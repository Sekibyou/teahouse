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
from .llm import _extract_text, _extract_tool_calls
from .tools import execute_tool, load_tools, load_tools_usage
from .director_system import assemble_system_prompt
from .database.connection import set_db_path
from .database.migrate import run_migrations
from .database.auth import configure_jwt
from .database.users import ensure_default_admin, list_users
from .database.llm_configs import configure_crypto, get_default_llm_config, get_llm_config
from .database.llm_providers import configure_crypto as configure_provider_crypto
from .database.llm_slots import get_all_slot_bindings, get_slot_binding
from .database.llm_models import get_model as get_llm_model
from .database.llm_providers import get_provider as get_llm_provider
from .database.model_profiles import get_profile as get_model_profile
from .database.workspaces import (
    list_prototypes,
    create_prototype,
    list_builtin_prototype_dirs,
    read_prototype_readme,
    get_instance,
)
from .routes.auth import router as auth_router
from .routes.llm_configs import router as llm_configs_router
from .routes.llm_providers import router as llm_providers_router
from .routes.llm_models import router as llm_models_router
from .routes.model_profiles import router as model_profiles_router
from .routes.llm_slots import router as llm_slots_router
from .routes.workspaces import router as workspaces_router
from .routes.session import router as session_router
from .routes.plugins import router as plugins_router
from .routes.settings import router as settings_router
from .plugins import load_all_enabled_plugins
from .database.plugins import configure_plugin_crypto
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
    _master = cfg.master_key or cfg.jwt_secret
    configure_crypto(_master)
    configure_provider_crypto(_master)
    configure_plugin_crypto(_master)

    # 5. Init LLM client — no global instance; resolved per-request from DB

    # 6. Scan and load enabled plugins for all users
    try:
        await load_all_enabled_plugins()
        print("[teahouse] plugin system initialized")
    except Exception as e:
        print(f"[teahouse] plugin init failed: {e}")

    # 7. Register all built-in prototypes from prototypes/ directory
    try:
        from .database.connection import execute
        builtin_dirs = list_builtin_prototype_dirs()

        # Clean up old built-in records that no longer exist on disk
        existing_all = await list_prototypes(None)
        existing_paths = {Path(p["source_path"]).resolve() for p in existing_all if p["is_builtin"]}
        current_paths = {d.resolve() for d in builtin_dirs}
        for p in existing_all:
            if p["is_builtin"] and Path(p["source_path"]).resolve() not in current_paths:
                await execute("DELETE FROM prototypes WHERE id = ?", (p["id"],))

        # Register or update built-in prototypes
        for proto_dir in builtin_dirs:
            name = proto_dir.name
            readme = read_prototype_readme(proto_dir)
            description = readme.strip().split("\n")[0].lstrip("#").strip() if readme else name
            source_path = str(proto_dir.resolve())

            if proto_dir.resolve() in existing_paths:
                # Update name/description in case it changed
                await execute(
                    "UPDATE prototypes SET name = ?, description = ?, source_path = ? WHERE is_builtin = 1 AND source_path = ?",
                    (name, description, source_path, source_path),
                )
            else:
                await create_prototype(None, name, description, source_path, is_builtin=True)
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
app.include_router(llm_configs_router)  # deprecated — kept for backward compat
app.include_router(llm_providers_router)
app.include_router(llm_models_router)
app.include_router(model_profiles_router)
app.include_router(llm_slots_router)
app.include_router(workspaces_router)
app.include_router(session_router)
app.include_router(plugins_router)
app.include_router(settings_router)


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

def _global_max_retries() -> int:
    cfg = state.config
    if cfg and cfg.llm:
        return cfg.llm.max_retries
    return 3

class ChatRequest(BaseModel):
    messages: list[dict]
    system: str | None = None
    slot_id: str | None = None  # 'mainstream' or 'top_tier'; None = legacy path
    stream: bool = True
    tools: bool = False  # Enable tool use (Director tools)
    instance_id: str | None = None  # Required when tools=True


async def _resolve_slot_client(user_id: str, slot_id: str) -> LLMClient:
    """Resolve an LLM client from a user's slot binding (provider→model→profile chain)."""
    binding = await get_slot_binding(user_id, slot_id)
    if not binding or not binding.get("model_id"):
        raise HTTPException(status_code=404, detail=f"Slot '{slot_id}' is not bound to a model")

    model = await get_llm_model(binding["model_id"])
    if not model:
        raise HTTPException(status_code=404, detail="Bound model not found")

    provider = await get_llm_provider(model["provider_id"])
    if not provider:
        raise HTTPException(status_code=404, detail="Model's provider not found")

    profile = None
    if model.get("profile_id"):
        profile = await get_model_profile(model["profile_id"])

    return LLMClient(ConfigLLMConfig(
        url=provider["api_url"],
        key=provider["api_key"],
        model=model["model_name"],
        api_style=provider["api_format"],
        max_tokens=profile["max_tokens"] if profile else 8192,
        temperature=profile["temperature"] if profile else 0.7,
        top_p=profile.get("top_p") if profile else None,
        frequency_penalty=profile.get("frequency_penalty") if profile else None,
        presence_penalty=profile.get("presence_penalty") if profile else None,
    ), max_retries=_global_max_retries())


async def _resolve_llm_config(llm_config_id: str | None, user_id: str | None) -> LLMClient:
    """Resolve an LLM config from DB and return a configured LLMClient. Legacy path."""
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
    ), max_retries=_global_max_retries())


async def _chat_common(body: ChatRequest, request: Request) -> LLMClient:
    """Resolve user + LLM client. Prefers slot-based resolution, falls back to legacy."""
    user_id: str | None = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from .database.auth import validate_token
        try:
            user_info = await validate_token(auth_header[7:])
            user_id = user_info.user_id
        except Exception:
            pass

    # Slot-based resolution (new path)
    if body.slot_id and user_id:
        return await _resolve_slot_client(user_id, body.slot_id)

    # Legacy path
    return await _resolve_llm_config(None, user_id)


MAX_TOOL_ROUNDS = 15  # Safety limit for tool use iterations

# Tools that require user approval before execution
APPROVAL_REQUIRED_TOOLS = {"GitCommit"}


class ToolApprovalStore:
    """In-memory store for pending tool approvals."""

    def __init__(self):
        self._events: dict[str, asyncio.Event] = {}
        self._results: dict[str, str | None] = {}  # str = approved, None = rejected

    async def wait_for_approval(self, tool_call_id: str, timeout: float = 300) -> str | None:
        """Wait for user approval. Returns tool result if approved, None if rejected/timed out."""
        self._events[tool_call_id] = asyncio.Event()
        try:
            await asyncio.wait_for(self._events[tool_call_id].wait(), timeout=timeout)
            return self._results.get(tool_call_id)
        except asyncio.TimeoutError:
            return None
        finally:
            self._events.pop(tool_call_id, None)
            self._results.pop(tool_call_id, None)

    def approve(self, tool_call_id: str, result: str):
        self._results[tool_call_id] = result
        event = self._events.get(tool_call_id)
        if event:
            event.set()

    def reject(self, tool_call_id: str, reason: str):
        self._results[tool_call_id] = None
        event = self._events.get(tool_call_id)
        if event:
            event.set()


approval_store = ToolApprovalStore()


async def _tool_use_loop(
    client: LLMClient,
    messages: list[dict],
    instance_dir: Path,
    user_id: str | None = None,
    instance_id: str | None = None,
):
    """Run tool use loop with streaming: yield text chunks and tool_call events in real-time.

    Yields SSE-compatible dict events: text, tool_call, tool_result, approval_required.
    """
    api_style = client.api_style
    msg = list(messages)

    if instance_id:
        from .tools import start_rendered_watcher
        start_rendered_watcher(instance_dir, instance_id)

    tools = load_tools()
    tools_usage = load_tools_usage()
    tool_system = assemble_system_prompt(instance_dir, tools_usage)

    def _feed_tool_result(msgs: list[dict], style: str, tc_id: str, name: str, result: str):
        if style == "anthropic":
            msgs.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": tc_id, "content": result}],
            })
        else:
            msgs.append({"role": "tool", "tool_call_id": tc_id, "content": result})

    for _round in range(MAX_TOOL_ROUNDS):
        # ── Phase 1: Streaming LLM call ──
        collected_text = ""
        all_tool_calls = None  # stores {"type": "tool_calls", "calls": [...]} when received

        async for event in client.send_message_stream_tools(msg, system=tool_system, tools=tools):
            if event["type"] == "text":
                collected_text += event["text"]
                yield event  # stream text chunks to frontend
            elif event["type"] == "reasoning":
                yield event
            elif event["type"] == "tool_calls":
                all_tool_calls = event["calls"]
            elif "error" in event:
                yield {"type": "text", "text": f"LLM API error: {event['error']}"}
                return

        # ── Phase 2: If no tool calls, done ──
        if not all_tool_calls:
            # If there was text but no separate text event yielded, yield it now
            return

        # ── Phase 3: Add assistant message with tool_calls ──
        if api_style == "anthropic":
            content_array = []
            if collected_text:
                content_array.append({"type": "text", "text": collected_text})
            for tc in all_tool_calls:
                try:
                    input_json = json.loads(tc["function"]["arguments"])
                except (json.JSONDecodeError, KeyError):
                    input_json = {}
                content_array.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": input_json,
                })
            msg.append({"role": "assistant", "content": content_array})
        else:
            ai_content = collected_text if collected_text else None
            msg.append({
                "role": "assistant",
                "content": ai_content,
                "tool_calls": all_tool_calls,
            })

        # ── Phase 4: Yield all tool_call events FIRST, then execute sequentially ──
        for tc in all_tool_calls:
            tc_id = tc["id"]
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                args = {}
            yield {"type": "tool_call", "id": tc_id, "name": name, "args": args}

        for tc in all_tool_calls:
            tc_id = tc["id"]
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                args = {}

            # Approval-required tools
            if name in APPROVAL_REQUIRED_TOOLS:
                yield {
                    "type": "approval_required",
                    "id": tc_id,
                    "name": name,
                    "args": args,
                }
                approved_result = await approval_store.wait_for_approval(tc_id)
                if approved_result is None:
                    reject_reason = "用户拒绝了提交请求，或等待超时。请根据反馈调整，或放弃本次提交。"
                    yield {"type": "tool_result", "id": tc_id, "name": name, "result": reject_reason}
                    _feed_tool_result(msg, api_style, tc_id, name, reject_reason)
                    continue
                yield {"type": "tool_result", "id": tc_id, "name": name, "result": approved_result}
                _feed_tool_result(msg, api_style, tc_id, name, approved_result)
                continue

            # Execute
            result = await execute_tool(name, args, instance_dir, user_id, instance_id)
            yield {"type": "tool_result", "id": tc_id, "name": name, "result": result}
            _feed_tool_result(msg, api_style, tc_id, name, result)

    # Max rounds exhausted
    msg.append({
        "role": "user",
        "content": "已达到单轮工具调用上限（15 次）。已执行的工具调用都已获得结果，未执行的工具调用请在新一轮对话中重试。请基于已有结果输出当前可完成的内容。",
    })

    async for event in client.send_message_stream_tools(msg, system=tool_system, tools=tools):
        if event["type"] == "text":
            yield event
        elif event["type"] == "reasoning":
            yield event
        elif event["type"] == "tool_calls":
            # If LLM returns tool calls even at max, execute them inline
            pass


@app.post("/v1/chat")
async def chat(body: ChatRequest, request: Request):
    client = await _chat_common(body, request)

    if body.tools:
        if not body.instance_id:
            raise HTTPException(status_code=400, detail="instance_id required when tools=True")

        # Resolve instance directory
        auth_header = request.headers.get("authorization", "")
        user_id = None
        if auth_header.startswith("Bearer "):
            from .database.auth import validate_token
            try:
                user_info = await validate_token(auth_header[7:])
                user_id = user_info.user_id
            except Exception:
                pass

        inst = await get_instance(body.instance_id)
        if not inst or (user_id and inst["user_id"] != user_id):
            raise HTTPException(status_code=404, detail="Instance not found")

        instance_dir = Path(inst["dir_path"])

        async def sse_tool_stream():
            async for event in _tool_use_loop(client, body.messages, instance_dir, user_id, body.instance_id):
                event_type = event.get("type", "tool_call")
                yield f"event: {event_type}\ndata: {json.dumps(event)}\n\n"
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(
            sse_tool_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

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
        reload_dirs=["src"] if reload_flag else None,
        reload_excludes=["data/**"] if reload_flag else None,
    )


if __name__ == "__main__":
    main()
