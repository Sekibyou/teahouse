"""
Teahouse — FastAPI 应用入口
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .config import Config, LLMConfig as ConfigLLMConfig
from .llm import LLMClient
from .database.connection import set_db_path
from .database.migrate import run_migrations
from .database.auth import configure_jwt
from .database.users import ensure_default_admin, list_users
from .database.llm_configs import configure_crypto, get_default_llm_config, get_llm_config
from .database.workspaces import (
    list_prototypes,
    create_prototype,
    register_builtin_prototype_source_path,
)
from .routes.auth import router as auth_router
from .routes.llm_configs import router as llm_configs_router
from .routes.workspaces import router as workspaces_router
from .routes.session import router as session_router
from .state import state


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Load config (creates teahouse.yaml on first run)
    cfg = Config.load_or_create()
    state.config = cfg

    # 2. Init database
    set_db_path(cfg.db.path)
    await run_migrations()

    # 3. Ensure default admin exists (after migrations add safe_name column)
    await ensure_default_admin()

    # 4. Init crypto / JWT
    configure_jwt(cfg.jwt_secret)
    configure_crypto(cfg.master_key or cfg.jwt_secret)

    # 4. Init LLM client — no global instance; resolved per-request from DB

    # 5. Ensure all existing users have the built-in blank prototype registered
    try:
        all_users = await list_users()
        for u in all_users:
            # Register built-in blank prototype if not already present
            existing = await list_prototypes(u["id"])
            if not any(p["is_builtin"] for p in existing):
                source_path = register_builtin_prototype_source_path(Path(state.workspace_base))
                await create_prototype(None, "空白模板", "默认空白原型，包含基础目录结构", source_path, is_builtin=True)
            break  # Built-in prototype is global — only register once
    except Exception:
        pass  # non-critical

    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Teahouse", version="0.1.0", lifespan=lifespan)

# CORS — allow frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth_router)
app.include_router(llm_configs_router)
app.include_router(workspaces_router)
app.include_router(session_router)


# ---------------------------------------------------------------------------
# SSE endpoint
# ---------------------------------------------------------------------------

@app.get("/events")
async def sse_events(request: Request) -> EventSourceResponse:
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    state._sse_queues.append(queue)

    async def event_generator() -> AsyncGenerator[dict[str, object], None]:
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                    yield msg
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            if queue in state._sse_queues:
                state._sse_queues.remove(queue)

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# Chat endpoint — per-request LLM config from database
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    messages: list[dict]
    system: str | None = None
    llm_config_id: str | None = None  # which LLM config to use; None = default
    stream: bool = True


async def _resolve_llm_config(llm_config_id: str | None, user_id: str | None) -> LLMClient:
    """Resolve an LLM config from DB and return a configured LLMClient."""
    if llm_config_id:
        cfg = await get_llm_config(llm_config_id)
        if not cfg or (user_id and cfg["user_id"] != user_id):
            raise HTTPException(status_code=404, detail="LLM config not found")
    elif user_id:
        cfg = await get_default_llm_config(user_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="No default LLM config found")
    else:
        raise HTTPException(status_code=400, detail="llm_config_id required when not authenticated")

    return LLMClient(ConfigLLMConfig(
        url=cfg["api_url"],
        key=cfg["api_key"],
        model=cfg["model_name"],
        api_style=cfg["api_format"],
        max_tokens=cfg["max_tokens"],
        temperature=cfg["temperature"],
    ))


async def _chat_common(body: ChatRequest, request: Request):
    """Shared logic: resolve user + LLM client. Called by both streaming and non-streaming paths."""
    user_id: str | None = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from .database.auth import validate_token
        try:
            user_info = await validate_token(auth_header[7:])
            user_id = user_info.user_id
        except Exception:
            pass
    client = await _resolve_llm_config(body.llm_config_id, user_id)
    return client


@app.post("/v1/chat")
async def chat(body: ChatRequest, request: Request):
    client = await _chat_common(body, request)

    if not body.stream:
        text = await client.send_message(body.messages, system=body.system)
        state.broadcast("llm_done", {"full_text": text})
        return {"status": "ok", "full_text": text}

    async def sse_stream():
        async for chunk in client.send_message_stream(body.messages, system=body.system):
            event = chunk["type"]  # "reasoning" or "text"
            yield f"event: {event}\ndata: {json.dumps(chunk)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Status endpoint
# ---------------------------------------------------------------------------

@app.get("/v1/status")
async def status():
    return {
        "status": "ok",
        "version": "0.1.0",
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    import sys
    reload_flag = "--reload" in sys.argv
    cfg = Config.load_or_create()
    import uvicorn
    uvicorn.run(
        "teahouse.app:app",
        host=cfg.server.host,
        port=cfg.server.port,
        reload=reload_flag,
    )


if __name__ == "__main__":
    main()
