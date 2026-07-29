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
    register_builtin_prototype_source_path,
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

    # 7. Ensure all existing users have the built-in blank prototype registered
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
app.include_router(llm_configs_router)  # deprecated — kept for backward compat
app.include_router(llm_providers_router)
app.include_router(llm_models_router)
app.include_router(model_profiles_router)
app.include_router(llm_slots_router)
app.include_router(workspaces_router)
app.include_router(session_router)
app.include_router(plugins_router)


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
    ))


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
    ))


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


async def _tool_use_loop(
    client: LLMClient,
    messages: list[dict],
    instance_dir: Path,
    user_id: str | None = None,
    instance_id: str | None = None,
):
    """Run tool use loop: call LLM → execute tools → feed back results → repeat until LLM returns text.

    The system prompt is assembled automatically from director-system/ templates,
    tools.json usage guide, and the instance's teahouse.md.

    Yields SSE-compatible dict events: tool_call, tool_result, then text chunks.
    """
    api_style = client.api_style
    msg = list(messages)

    # Ensure rendered file watcher is running for this instance
    if instance_id:
        from .tools import start_rendered_watcher
        start_rendered_watcher(instance_dir, instance_id)

    # Load tools from the single source of truth (tools.json)
    tools = load_tools()
    tools_usage = load_tools_usage()
    tool_system = assemble_system_prompt(instance_dir, tools_usage)

    for _round in range(MAX_TOOL_ROUNDS):
        # Call LLM with tools
        resp = await client.send_message_full(msg, system=tool_system, tools=tools)

        # Check for errors
        if "error" in resp:
            yield {"type": "text", "text": f"LLM API error: {resp['error']}"}
            return

        # Extract tool calls
        tool_calls = _extract_tool_calls(resp, api_style)

        # If no tool calls, extract text and yield it
        if not tool_calls:
            text = _extract_text(resp, api_style)
            if text:
                yield {"type": "text", "text": text}
            return

        # Add assistant message with tool_calls to the conversation
        if api_style == "anthropic":
            assistant_msg = {"role": "assistant"}
            # Anthropic: content is list of blocks
            content_blocks = resp.get("content", [])
            text_blocks = [b for b in content_blocks if b.get("type") == "text"]
            text_content = text_blocks[0]["text"] if text_blocks else None
            # Build content array: text blocks + tool_use blocks
            content_array = []
            if text_content:
                content_array.append({"type": "text", "text": text_content})
            for tc in tool_calls:
                content_array.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": json.loads(tc["function"]["arguments"]),
                })
            assistant_msg["content"] = content_array
            msg.append(assistant_msg)
        else:
            # OpenAI format: content must be null when tool_calls present
            choices = resp.get("choices", [])
            ai_content = None
            if choices:
                msg_data = choices[0].get("message", {})
                ai_content = msg_data.get("content") or None

            assistant_msg = {
                "role": "assistant",
                "content": ai_content,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": tc["type"],
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"],
                        },
                    }
                    for tc in tool_calls
                ],
            }
            msg.append(assistant_msg)

        # Process each tool call
        for tc in tool_calls:
            tc_id = tc["id"]
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except json.JSONDecodeError:
                args = {}

            # Yield tool_call event
            yield {"type": "tool_call", "id": tc_id, "name": name, "args": args}

            # Execute
            result = await execute_tool(name, args, instance_dir, user_id, instance_id)

            # Yield tool_result event
            yield {"type": "tool_result", "id": tc_id, "name": name, "result": result}

            # Feed result back to LLM as a tool_result message
            if api_style == "anthropic":
                msg.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tc_id,
                            "content": result,
                        }
                    ],
                })
            else:
                msg.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result,
                })

    # If we exhausted rounds, notify the LLM so it can summarize or retry
    # Use role "user" (not "tool") because OpenAI strictly validates that
    # role "tool" messages MUST be responses to a preceding tool_calls message.
    # A fake tool_call_id like "__limit__" will cause a 400 error.
    msg.append({
        "role": "user",
        "content": "已达到单轮工具调用上限（15 次）。已执行的工具调用都已获得结果，未执行的工具调用请在新一轮对话中重试。请基于已有结果输出当前可完成的内容。",
    })

    resp = await client.send_message_full(msg, system=tool_system, tools=tools)
    text = _extract_text(resp, api_style)
    if text:
        yield {"type": "text", "text": text}


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
