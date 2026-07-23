"""
Teahouse — FastAPI 应用入口
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .config import Config, LLMConfig as ConfigLLMConfig
from .llm import LLMClient
from .database.connection import set_db_path, execute, generate_uuid
from .database.migrate import run_migrations
from .database.auth import configure_jwt
from .database.users import ensure_default_admin
from .database.llm_configs import configure_crypto, get_default_llm_config, get_llm_config
from .database.workspaces import get_workspace_by_user, ensure_workspace_dirs, build_blank_prototype_zip, create_prototype, list_prototypes
from .routes.auth import router as auth_router
from .routes.llm_configs import router as llm_configs_router
from .routes.workspaces import router as workspaces_router
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

    # 5. Ensure all existing users have a workspace + blank prototype
    try:
        from .database.users import list_users, ensure_unique_safe_name
        all_users = await list_users()
        for u in all_users:
            ws = await get_workspace_by_user(u["id"])
            if not ws:
                safe = await ensure_unique_safe_name(u["username"])
                now = __import__("time").time() * 1000
                ws_id = generate_uuid()
                await execute(
                    "INSERT INTO workspaces (id, user_id, name, safe_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (ws_id, u["id"], "默认工作区", safe, int(now), int(now)),
                )
                ws = await get_workspace_by_user(u["id"])
            if ws:
                zip_path = await build_blank_prototype_zip(ws, Path(state.workspace_base))
                existing = await list_prototypes(ws["id"])
                if not any(p["is_builtin"] for p in existing):
                    ws_dir = Path(state.workspace_base) / "workspaces" / ws["safe_name"]
                    zip_rel = str(zip_path.relative_to(ws_dir))
                    await create_prototype(ws["id"], None, "空白模板", "默认空白原型，包含基础目录结构", zip_rel, is_builtin=True)
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


@app.post("/v1/chat")
async def chat(body: ChatRequest, request: Request):
    # Try to identify the user from the Authorization header (optional for chat)
    user_id: str | None = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from .database.auth import validate_token
        try:
            user_info = validate_token(auth_header[7:])
            user_id = user_info.user_id
        except Exception:
            pass  # anonymous chat if token is invalid

    client = await _resolve_llm_config(body.llm_config_id, user_id)

    if body.stream:
        full_response = ""
        async for text in client.send_message_stream(
            body.messages, system=body.system
        ):
            full_response += text
            state.broadcast("llm_chunk", {"text": text})
        state.broadcast("llm_done", {"full_text": full_response})
        return {"status": "streaming", "full_text": full_response}
    else:
        text = await client.send_message(
            body.messages, system=body.system
        )
        state.broadcast("llm_done", {"full_text": text})
        return {"status": "ok", "data": text}


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
