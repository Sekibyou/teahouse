"""
Teahouse — FastAPI 应用入口
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import __version__
from .config import Config, LLMConfig as ConfigLLMConfig
from .llm import LLMClient
from .llm import _extract_text, _extract_tool_calls
from .tools import execute_tool, load_tools, load_tools_usage
from .script import load_batch, BatchError
from .director_system import build_template_variables, resolve_preset_template
from .database.director_prompt_presets import ensure_director_preset_binding
from .database.connection import set_db_path
from .database.migrate import run_migrations
from .database.auth import configure_jwt
from .database.users import sync_super_admin, list_users
from .database.llm_configs import configure_crypto, get_default_llm_config, get_llm_config
from .database.llm_providers import configure_crypto as configure_provider_crypto
from .database.llm_slots import get_slot_binding
from .database.llm_models import get_model as get_llm_model
from .database.llm_providers import get_provider as get_llm_provider
from .database.model_profiles import get_profile as get_model_profile
from .database.workspaces import (
    list_prototypes,
    create_prototype,
    list_builtin_prototype_dirs,
    read_prototype_readme,
    get_instance,
    BUILTIN_PROTOTYPE_REGISTRY,
)
from .routes.auth import router as auth_router
from .routes.users import router as users_router
from .routes.invite_keys import router as invite_keys_router
from .routes.llm_configs import router as llm_configs_router
from .routes.llm_providers import router as llm_providers_router
from .routes.llm_models import router as llm_models_router
from .routes.model_profiles import router as model_profiles_router
from .routes.llm_slots import router as llm_slots_router
from .routes.director_prompt_presets import router as prompt_presets_router
from .routes.workspaces import router as workspaces_router
from .routes.session import router as session_router
from .routes.plugins import router as plugins_router
from .routes.skills import router as skills_router
from .routes.packages import router as packages_router
from .routes.settings import router as settings_router
from .plugins import load_all_enabled_plugins
from .database.plugins import configure_plugin_crypto
from .state import state
from .session_tracker import task_tracker


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Load config (creates teahouse.yaml on first run)
    cfg = Config.load_or_create()
    state.config = cfg

    # 2. Init database
    set_db_path(cfg.db_path)
    await run_migrations()

    # 3. Ensure the super admin account exists with the yaml password applied
    await sync_super_admin(cfg.auth.admin_password)

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
            name = BUILTIN_PROTOTYPE_REGISTRY.get(proto_dir.name, proto_dir.name)
            readme = read_prototype_readme(proto_dir)
            description = "" if proto_dir.name in BUILTIN_PROTOTYPE_REGISTRY \
                else (readme.strip().split("\n")[0].lstrip("#").strip() if readme else name)
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

app = FastAPI(title="Teahouse", version=__version__, lifespan=lifespan)

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
app.include_router(users_router)
app.include_router(invite_keys_router)
app.include_router(llm_configs_router)  # deprecated — kept for backward compat
app.include_router(llm_providers_router)
app.include_router(llm_models_router)
app.include_router(model_profiles_router)
app.include_router(llm_slots_router)
app.include_router(prompt_presets_router)
app.include_router(workspaces_router)
app.include_router(session_router)
app.include_router(plugins_router)
app.include_router(skills_router)
app.include_router(packages_router)
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

async def _user_max_retries(user_id: str | None) -> int:
    """Per-user LLM request retry budget (users.preferences). Falls back to default."""
    if user_id:
        from .database.users import get_preferences
        prefs = await get_preferences(user_id) or {}
        v = prefs.get("max_retries")
        if isinstance(v, int):
            return int(v)
    return 3


async def _user_max_tool_rounds(user_id: str | None) -> int:
    """Per-user tool-use loop iteration cap (users.preferences). Falls back to default."""
    if user_id:
        from .database.users import get_preferences
        prefs = await get_preferences(user_id) or {}
        v = prefs.get("max_tool_rounds")
        if isinstance(v, int):
            return int(v)
    return 15

class ChatRequest(BaseModel):
    messages: list[dict]
    system: str | None = None
    slot_id: str | None = None  # 'mainstream' or 'top_tier'; None = legacy path
    stream: bool = True
    tools: bool = False  # Enable tool use (Director tools)
    instance_id: str | None = None  # Required when tools=True
    session_id: str | None = None  # None or "main" = main session; else a child sub-session


async def _resolve_slot_client(user_id: str, slot_id: str) -> LLMClient:
    """Resolve an LLM client from a user's slot binding (provider→model→[slot-profile | model-profile] chain).

    Profile resolution order:
    1. Slot-level profile_id (from llm_slot_bindings)
    2. Model-level profile_id is NOT used anymore — profiles are slot-level only
    """
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
    # Slot-level profile override takes priority
    slot_profile_id = binding.get("profile_id")
    if slot_profile_id:
        profile = await get_model_profile(slot_profile_id)

    return LLMClient(ConfigLLMConfig(
        url=provider["api_url"],
        key=provider["api_key"],
        model=model["model_name"],
        api_style=provider["api_format"],
        max_tokens=profile["max_tokens"] if profile else 50000,
        max_context=profile.get("max_context", 131072) if profile else 131072,
        temperature=profile["temperature"] if profile else 0.7,
        top_p=profile.get("top_p") if profile else None,
        frequency_penalty=profile.get("frequency_penalty") if profile else None,
        presence_penalty=profile.get("presence_penalty") if profile else None,
    ), max_retries=await _user_max_retries(user_id))


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
        max_tokens=cfg["max_tokens"] if cfg["max_tokens"] else 50000,
        temperature=cfg["temperature"],
    ), max_retries=await _user_max_retries(user_id))


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


# Tools that require user approval before execution
APPROVAL_REQUIRED_TOOLS = {"GitCommit"}


def _preprocess_frontend_blocks(messages: list[dict], api_style: str) -> list[dict]:
    """Convert frontend RichMessage blocks into API-format tool_calls and tool_result messages.

    The frontend stores tool interactions as:
      blocks: [
        {type: "text", text: "..."},
        {type: "tool_call", id, name, args, result?: string},
        ...
      ]

    For interrupted messages (where blocks exist on an assistant message):
    - text blocks → accumulated into content
    - tool_call with real result → assistant tool_call + tool_result message pair
    - tool_call with result="(interrupted)" or no result → assistant tool_call + synthetic
      tool_result indicating the tool was cancelled by user interruption
    """
    result: list[dict] = []

    for msg in messages:
        blocks = msg.pop("blocks", None)
        msg.pop("reasoning", None)
        msg.pop("status", None)
        msg.pop("id", None)

        if not blocks or msg.get("role") != "assistant":
            result.append(msg)
            continue

        # Check if this is an interrupted message
        has_interrupted = any(
            b.get("type") == "tool_call" and b.get("result") in (None, "(interrupted)")
            for b in blocks
        )

        if not has_interrupted:
            # Normal message: blocks are just display artifacts, strip and pass through
            result.append(msg)
            continue

        # Interrupted assistant: reconstruct with proper tool_calls
        text_parts: list[str] = []
        all_tool_calls: list[dict] = []
        tool_results: list[dict] = []

        for b in blocks:
            if b.get("type") == "text" and b.get("text"):
                text_parts.append(b["text"])
            elif b.get("type") == "tool_call":
                tc_id = b.get("id", "")
                tc_name = b.get("name", "")
                tc_args = b.get("args", {})
                tc_result = b.get("result")

                if api_style == "anthropic":
                    api_tc = {
                        "type": "tool_use",
                        "id": tc_id,
                        "name": tc_name,
                        "input": tc_args,
                    }
                else:
                    api_tc = {
                        "id": tc_id,
                        "type": "function",
                        "function": {
                            "name": tc_name,
                            "arguments": json.dumps(tc_args),
                        },
                    }
                all_tool_calls.append(api_tc)

                if tc_result is not None and tc_result != "(interrupted)":
                    result_msg = tc_result
                else:
                    result_msg = f"[cancelled by user interruption]"
                if api_style == "anthropic":
                    tool_results.append({
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": tc_id, "content": result_msg}],
                    })
                else:
                    tool_results.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result_msg,
                    })

        # Build the assistant message
        content_text = "".join(text_parts) if text_parts else None

        if all_tool_calls:
            if api_style == "anthropic":
                content_array: list[dict] = []
                if content_text:
                    content_array.append({"type": "text", "text": content_text})
                content_array.extend(all_tool_calls)
                result.append({"role": "assistant", "content": content_array})
            else:
                result.append({
                    "role": "assistant",
                    "content": content_text or None,
                    "tool_calls": all_tool_calls,
                })
            result.extend(tool_results)
        else:
            # Only text, no tool calls
            result.append({"role": "assistant", "content": content_text or ""})

    return result


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


def _expand_batch_calls(all_tool_calls: list[dict], instance_dir: Path) -> list[dict]:
    """Expand BatchExecute entries into their real tool-call steps (mode B).

    Each ``BatchExecute`` call in ``all_tool_calls`` is replaced in-place by the
    static JSONL steps it points to (with optional line slice), each step becoming
    a normal tool call. The expansion is single-level (a step that itself names
    ``BatchExecute`` is *not* expanded again) to guard against infinite recursion.

    Returns the new list. Errors reading a script surface as a synthetic tool
    result that explains the failure, so the round can degrade gracefully.
    """
    import uuid as _uuid
    out: list[dict] = []
    for tc in all_tool_calls:
        try:
            name = tc["function"]["name"]
            args = json.loads(tc["function"]["arguments"]) if tc["function"].get("arguments") else {}
        except (json.JSONDecodeError, KeyError, AttributeError):
            name = ""
            args = {}

        if name != "BatchExecute":
            out.append(tc)
            continue

        raw_path = str(args.get("path", "")).strip()
        try:
            steps = load_batch(instance_dir, raw_path)
        except BatchError as e:
            # Degrade: keep the batch call itself so Phase 4 executes it; a BatchExecute
            # executor that reports the script error will surface the reason cleanly.
            out.append(tc)
            continue

        total = len(steps)

        # Keep the BatchExecute call itself as the batch's anchor record (before the
        # expanded steps). Its executor reports "expanded N steps" so the director
        # sees a concrete BatchExecute tool_call + result it can tie the sub-results to.
        anchor_tc: dict = {
            "id": tc.get("id") or f"batch_{_uuid.uuid4().hex[:8]}",
            "type": "function",
            "function": {
                "name": "BatchExecute",
                "arguments": json.dumps({"path": raw_path, "total": total}, ensure_ascii=False),
            },
        }
        # No _batch_meta on the anchor: it is the batch record itself, not a sub-step,
        # so its own tool_result must not carry an index prefix.
        out.append(anchor_tc)

        for i, step in enumerate(steps, 1):
            tool_name = step["tool"]
            tool_args = step.get("args", {})
            expanded_tc: dict = {
                "id": f"batch_{_uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": json.dumps(tool_args, ensure_ascii=False),
                },
            }
            # Batch metadata — display-only. Stripped before feeding LLM context
            # (Phase 3), attached to persisted records + SSE (Phase 4).
            expanded_tc["_batch_meta"] = {
                "path": raw_path,
                "index": i,
                "total": total,
            }
            out.append(expanded_tc)
    return out


async def _tool_use_loop(
    client: LLMClient,
    messages: list[dict],
    instance_dir: Path,
    user_id: str | None = None,
    instance_id: str | None = None,
    session_id: str | None = None,
    enabled_tools: list[str] | None = None,
    order_allocator=None,
    reasoning_effort: str | None = None,
    pending_check=None,
):
    """Run tool use loop with streaming: yield text chunks and tool_call events in real-time.

    Yields SSE-compatible dict events: text, tool_call, tool_result, approval_required.
    ``session_id`` selects which .sessions/<sid>.jsonl to read/write (None => main).
    ``enabled_tools`` (a child session) gates which tools the director may call;
    None means unrestricted (main session / sandbox runTool).

    ``order_allocator`` (optional zero-arg callable) supplies this round's order
    from the owning SessionLoop's monotonic watermark, keeping the round's
    reserved order consistent with queued-user reservations and the persisted
    record. When omitted, orders fall back to the on-disk record count.

    ``reasoning_effort`` (optional) is an internal effort value (none|low|mid|
    high|max). When None it is resolved from the session at run time (child
    meta / main user default); when set it wins.

    ``pending_check`` (optional zero-arg callable) drains user messages queued
    during generation. It is invoked before every round's API send; when it
    returns a non-empty list of (queue_id, content, order) tuples, each content
    is appended to the round's context as a trailing user message so the LLM
    sees it on this round instead of the user waiting for the whole loop to
    finish. Persistence + queued→done broadcast are the caller's job (see
    SessionLoop._drain_and_persist); this function only feeds the drained
    content into ``msg``.
    """
    api_style = client.api_style

    from . import sessions
    sid = session_id or sessions.MAIN_SESSION_ID

    # Authoritative context comes from the persisted session history; the
    # frontend no longer holds it. We rebuild LLM messages from .sessions/ (full,
    # never-clipped tool results) so the director re-gets prior tool outputs.
    msg = sessions.records_to_context(instance_dir, api_style, session_id=sid)

    # The frontend sends only this round's new user input (or nothing). Append it
    # as the trailing user message so the assistant replies to it.
    new_inputs = [m for m in messages if m.get("role") == "user" and isinstance(m.get("content"), str) and m.get("content")]
    if new_inputs:
        # Strip reasoning/blocks markers (frontend may still send them).
        msg.append({"role": "user", "content": new_inputs[-1]["content"]})

    # Persist this round's real user input. Preset fake messages / system prompt
    # are injected into `msg` below and never reach persistence.
    _real_user_content = new_inputs[-1]["content"] if new_inputs else None
    if _real_user_content:
        sessions.append_user(instance_dir, _real_user_content, session_id=sid)

    # Function-scope pending record for interruption fallback. Accumulated as
    # streaming chunks arrive; cleared on each normal flush. If the generator is
    # closed mid-stream (frontend disconnect / LLM error), Phase 1's
    # ``except GeneratorExit`` persists whatever text/reasoning had accumulated
    # so a long partial reply isn't lost wholesale.
    _pending = {"content": "", "reasoning": ""}

    def _flush_assistant(content: str, blocks: list[dict] | None = None, order: int | None = None) -> None:
        sessions.append_assistant(
            instance_dir,
            content=content,
            reasoning=_pending["reasoning"],
            blocks=blocks or [],
            session_id=sid,
            order=order,
        )
        _pending["content"] = ""
        _pending["reasoning"] = ""

    tools = load_tools(user_id=user_id)
    tools_usage = await load_tools_usage(user_id=user_id)

    # Resolve the director system prompt from the user's prompt preset. Every user
    # has a built-in preset auto-created and auto-bound to the director slot, so this
    # is the single, mandatory assembly path — there is no code-level fallback. A
    # missing/empty preset is an error, never a silent fallback.
    from .routes.settings import _user_max_parse_depth
    parse_depth = await _user_max_parse_depth(user_id)
    if not user_id:
        raise HTTPException(status_code=500, detail="Director system prompt requires a user")
    preset = await ensure_director_preset_binding(user_id)
    variables = build_template_variables(instance_dir, tools_usage)
    tool_system, fake_msgs = resolve_preset_template(
        preset["template_yaml"], variables, instance_dir, max_depth=parse_depth
    )
    if fake_msgs:
        msg = fake_msgs + msg

    # Scoped session framing: when the session has restricted tool access (enabled_tools
    # is not None), tell the director it is a scoped one-shot task.
    if enabled_tools is not None:
        allowed = ", ".join(sorted(enabled_tools or []))
        tool_system = (
            f"{tool_system}\n\n"
            f"[SESSION] You are a scoped task session (session {sid}). Complete exactly the "
            f"work asked below, then call the EndSession tool to declare it finished. "
            f"Your tool access is restricted to: {allowed}. "
            f"The Report tool writes conclusions to temp/ for later review. "
            f"Do not do unrelated work or wait for further instructions — this task is one-shot."
        )

    # Resolve effective reasoning effort for this session at run time.
    # Precedence: explicit caller override (child session meta) → session-level
    # effort (main → user default). None = omit the knob (model default).
    if reasoning_effort is None:
        from .reasoning import resolve_session_effort
        reasoning_effort = await resolve_session_effort(instance_dir, sid, user_id)

    def _feed_tool_result(msgs: list[dict], style: str, tc_id: str, name: str, result: str, batch_meta: dict | None = None):
        # When a call came from a BatchExecute expansion, prepend a batch note so
        # the director can tell this step was issued as part of a batch script (a
        # single JSONL run), not a manual loner call. Display-only for the LLM;
        # the frontend keeps the plain badge via the SSE/persisted `batch` field.
        if batch_meta:
            path = batch_meta.get("path", "?")
            idx = batch_meta.get("index", "?")
            total = batch_meta.get("total", "?")
            result = f"[This call was invoked by BatchExecute, NOT by you manually. It is auto-expanded sub-step {idx}/{total} of the script {path}]\n{result}"
        if style == "anthropic":
            msgs.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": tc_id, "content": result}],
            })
        else:
            msgs.append({"role": "tool", "tool_call_id": tc_id, "content": result})

    for _round in range(await _user_max_tool_rounds(user_id)):
        # ── Phase 0: Assign this round's order (session-wide monotonic) ──
        # The order is the stable (order, sub) key stamped onto every SSE event
        # of this round; it must equal the order append_assistant stamps when
        # the round persists (passed into _flush_assistant below), keeping
        # streaming and replayed records consistent. The allocator (when given)
        # is the SessionLoop's watermark, so concurrent queued-user reservations
        # never collide with the round's order.
        if order_allocator is not None:
            round_order = order_allocator()
        else:
            round_order = sessions.next_order(instance_dir, sid)

        def _tag(ev: dict, sub=None) -> dict:
            """Attach this round's order (+ optional block sub) to an event dict."""
            ev = dict(ev)
            ev["order"] = round_order
            if sub is not None:
                ev["sub"] = sub
            return ev

        # ── Phase 0.5: Absorb user messages queued mid-generation ──
        # Before this round's message is sent to the API, drain any user message
        # the user typed while the director was busy. The caller (SessionLoop)
        # has already persisted it + broadcast the queued→done upgrade; here we
        # only append the content into `msg` so this round's API call includes
        # it — the user doesn't have to wait for the whole tool loop to finish.
        _pending_msgs = pending_check() if pending_check else None
        for _qid, _content, _order in (_pending_msgs or []):
            msg.append({"role": "user", "content": _content})

        # ── Phase 1: Streaming LLM call ──
        collected_text = ""
        all_tool_calls = None  # stores {"type": "tool_calls", "calls": [...]} when received
        try:
            _call_kwargs = {}
            if reasoning_effort is not None:
                _call_kwargs["reasoning_effort"] = reasoning_effort
            async for event in client.send_message_stream_tools(msg, system=tool_system, tools=tools, **_call_kwargs):
                if event["type"] == "text":
                    # tool_args-marked events carry OpenAI tool-call argument
                    # fragments for token counting. Do NOT accumulate into
                    # collected_text and do NOT render to the frontend (the raw
                    # JSON fragments would render as garbled text). Yield a
                    # lightweight stats_heartbeat instead so the frontend's
                    # token/elapsed readout keeps moving during long tool-arg
                    # generation instead of appearing frozen.
                    if not event.get("tool_args"):
                        collected_text += event["text"]
                        _pending["content"] = collected_text
                        # A round has a single leading text block (index 0) when any.
                        yield _tag(event, 0)
                    else:
                        yield _tag({"type": "stats_heartbeat"})
                    # All text (body + tool args) counts toward the token
                    # counter; empty heartbeat text is a no-op (if not n: return).
                    task_tracker.stats_add_tokens(
                        instance_dir.name, sid, len(event["text"])
                    )
                elif event["type"] == "reasoning":
                    chunk = event.get("text", "")
                    _pending["reasoning"] += chunk
                    task_tracker.stats_add_tokens(instance_dir.name, sid, len(chunk))
                    yield _tag(event, "r")
                elif event["type"] == "tool_calls":
                    all_tool_calls = event["calls"]
                elif "error" in event:
                    yield _tag({"type": "text", "text": f"LLM API error: {event['error']}"}, 0)
                    return
        except GeneratorExit:
            # Frontend disconnected mid-stream. Persist whatever reasoning/text
            # had accumulated so a long partial reply isn't lost wholesale.
            if _pending["content"] or _pending["reasoning"]:
                _flush_assistant(
                    _pending["content"],
                    [{"type": "text", "text": _pending["content"]}] if _pending["content"] else None,
                    round_order,
                )
            raise

        # ── Phase 1.5: Expand BatchExecute into real tool calls (mode B) ──
        # Any BatchExecute entries are replaced by their static JSONL steps before
        # the assistant message is built, so the expanded steps ride the same round
        # as ordinary tool calls: independent SSE event, independent tool_result,
        # independent persistence.
        if all_tool_calls:
            all_tool_calls = _expand_batch_calls(all_tool_calls, instance_dir)

        # ── Phase 2: If no tool calls, done ──
        if not all_tool_calls:
            # Persist the plain-text assistant reply (no tool blocks).
            _flush_assistant(collected_text, [{"type": "text", "text": collected_text}] if collected_text else None, round_order)
            # Signal the frontend to close this bubble (mirrors Phase 4's assistant_done).
            yield _tag({"type": "assistant_done"})
            return

        # ── Phase 3: Add assistant message with tool_calls ──
        # Build a batch-metadata-stripped copy for the LLM context: display-only
        # `_batch_meta` must not reach the model's tool_calls.
        _llm_calls: list[dict] = []
        for tc in all_tool_calls:
            _c = dict(tc)
            _c.pop("_batch_meta", None)
            _llm_calls.append(_c)

        if api_style == "anthropic":
            content_array = []
            if collected_text:
                content_array.append({"type": "text", "text": collected_text})
            for tc in _llm_calls:
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
            assistant_msg: dict = {
                "role": "assistant",
                "content": ai_content,
                "tool_calls": _llm_calls,
            }
            # Echo this round's reasoning back so thinking-enabled models
            # (DeepSeek-Reasoner) can accept the next round's request.
            if _pending["reasoning"]:
                assistant_msg["reasoning"] = _pending["reasoning"]
            msg.append(assistant_msg)

        # ── Phase 4: Yield all tool_call events FIRST, then execute sequentially ──
        _round_blocks: list[dict] = []
        if collected_text:
            _round_blocks.append({"type": "text", "text": collected_text})
        # Block index layout within this round's persisted record:
        # text block = sub 0 (when present); tool_calls follow with sub
        # (1 if text else 0) + tool_index. Frontend sorts strictly by this.
        _tool_base = 1 if collected_text else 0

        for _ti, tc in enumerate(all_tool_calls):
            tc_id = tc["id"]
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                args = {}
            ev: dict = {"type": "tool_call", "id": tc_id, "name": name, "args": args}
            if tc.get("_batch_meta"):
                ev["_batch_meta"] = tc["_batch_meta"]
            yield _tag(ev, _tool_base + _ti)

        for _ti, tc in enumerate(all_tool_calls):
            tc_id = tc["id"]
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                args = {}
            batch_meta = tc.get("_batch_meta")
            _tool_sub = _tool_base + _ti

            # Approval-required tools
            if name in APPROVAL_REQUIRED_TOOLS:
                yield _tag({
                    "type": "approval_required",
                    "id": tc_id,
                    "name": name,
                    "args": args,
                }, _tool_sub)
                approved_result = await approval_store.wait_for_approval(tc_id)
                if approved_result is None:
                    reject_reason = "用户拒绝了提交请求，或等待超时。请根据反馈调整，或放弃本次提交。"
                    _round_blocks.append({"type": "tool_call", "id": tc_id, "name": name, "args": args, "result": reject_reason, **({"batch": batch_meta} if batch_meta else {})})
                    yield _tag({"type": "tool_result", "id": tc_id, "name": name, "result": reject_reason}, _tool_sub)
                    _feed_tool_result(msg, api_style, tc_id, name, reject_reason, batch_meta)
                    continue
                _round_blocks.append({"type": "tool_call", "id": tc_id, "name": name, "args": args, "result": approved_result, **({"batch": batch_meta} if batch_meta else {})})
                yield _tag({"type": "tool_result", "id": tc_id, "name": name, "result": approved_result}, _tool_sub)
                _feed_tool_result(msg, api_style, tc_id, name, approved_result, batch_meta)
                continue

            # Execute
            result = await execute_tool(name, args, instance_dir, user_id, instance_id, session_id=session_id, enabled_tools=enabled_tools)
            _round_blocks.append({"type": "tool_call", "id": tc_id, "name": name, "args": args, "result": result, **({"batch": batch_meta} if batch_meta else {})})
            yield _tag({"type": "tool_result", "id": tc_id, "name": name, "result": result}, _tool_sub)
            _feed_tool_result(msg, api_style, tc_id, name, result, batch_meta)

        # Flush this round's completed assistant record (reasoning + text + all tool results)
        _flush_assistant(collected_text, _round_blocks, round_order)
        # Signal the frontend that this tool round is a complete assistant turn, so
        # it can close the current bubble and start a fresh one — matching the
        # per-round records later replayed from .sessions/.
        yield _tag({"type": "assistant_done"})

        # Broadcast floors stats after each tool round
        from .director_system import get_floors_stats
        stats = get_floors_stats(instance_dir)
        if stats:
            stats["instance_id"] = instance_id or instance_dir.name
            state.broadcast("floors_changed", stats)

    # Max rounds exhausted
    msg.append({
        "role": "user",
        "content": "已达到单轮工具调用上限（15 次）。已执行的工具调用都已获得结果，未执行的工具调用请在新一轮对话中重试。请基于已有结果输出当前可完成的内容。",
    })

    _tail_text = ""
    try:
        async for event in client.send_message_stream_tools(msg, system=tool_system, tools=tools):
            if event["type"] == "text":
                if not event.get("tool_args"):
                    _tail_text += event["text"]
                    _pending["content"] = _tail_text
                    yield event
                else:
                    # tool-arg fragment: count but don't render raw JSON — yield a
                    # stats heartbeat so the counter/timer keep moving (see main loop).
                    yield {"type": "stats_heartbeat"}
                # Count all text (body + tool args); empty heartbeat is a no-op.
                task_tracker.stats_add_tokens(instance_dir.name, sid, len(event["text"]))
            elif event["type"] == "reasoning":
                chunk = event.get("text", "")
                _pending["reasoning"] += chunk
                task_tracker.stats_add_tokens(instance_dir.name, sid, len(chunk))
                yield event
            elif event["type"] == "tool_calls":
                # If LLM returns tool calls even at max, execute them inline
                pass
    except GeneratorExit:
        if _pending["content"] or _pending["reasoning"]:
            _flush_assistant(
                _pending["content"],
                [{"type": "text", "text": _pending["content"]}] if _pending["content"] else None,
            )
        raise
    else:
        # Normal completion: persist the final tail reply as its own assistant record.
        if _tail_text:
            _flush_assistant(_tail_text, [{"type": "text", "text": _tail_text}])


@app.post("/v1/chat")
async def chat(body: ChatRequest, request: Request):
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

        from . import sessions as _sessions
        from .session_loop import SessionLoop
        sid = (body.session_id or _sessions.MAIN_SESSION_ID)

        # Extract user content from frontend messages and enqueue.
        # The frontend may send either a plain string content, or — when paste
        # blocks are present — an object {manual, pastes:[{id, content}]}.
        new_inputs = [m for m in body.messages if m.get("role") == "user" and m.get("content")]
        if new_inputs:
            loop = SessionLoop.get_or_create(instance_dir, sid, body.instance_id, user_id)
            raw = new_inputs[-1]["content"]
            if isinstance(raw, dict):
                loop.enqueue(raw.get("manual") or "", raw.get("pastes"))
            else:
                loop.enqueue(raw)
            return {"queued": True, "session_id": sid, "count": len(new_inputs)}
        # No user input — return ok (frontend may send empty round to wake an idle session)
        return {"queued": False, "session_id": sid}

    client = await _chat_common(body, request)

    if not body.stream:
        msgs = _preprocess_frontend_blocks(list(body.messages), client.api_style)
        text = await client.send_message(msgs, system=body.system)
        state.broadcast("llm_done", {"full_text": text})
        return {"status": "ok", "full_text": text}

    async def sse_stream():
        msgs = _preprocess_frontend_blocks(list(body.messages), client.api_style)
        async for chunk in client.send_message_stream(msgs, system=body.system):
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
        "version": __version__,
    }


# ---------------------------------------------------------------------------
# Static frontend hosting (single-port deployment)
#
# Serves the built frontend (teahouse-frontend/dist/) from the same origin so
# a phone can use the whole app at http://<host>:8888 without a separate dev
# server. API prefixes are excluded and fall through to their own handlers /
# 404. Absent = dist not built yet, no-op (API-only still works).
#
# In dev mode (`--dev` / TEAHOUSE_DEV=1) the frontend is served by Vite on
# :5173 and proxies /api /v1 /events back here, so dist is never mounted and
# the SPA catch-all returns 404 instead of HTML.
# ---------------------------------------------------------------------------

# Dev mode: frontend hot-reloaded by Vite, backend hot-reloaded via --reload.
DEV_MODE = os.environ.get("TEAHOUSE_DEV") == "1" or "--dev" in sys.argv

def _frontend_dist() -> Path:
    """Resolve the built-frontend directory across source and PyInstaller layouts.

    Source: project-root/teahouse-frontend/dist.
    PyInstaller (frozen): <exe dir>/dist — the built SPA ships next to Teahouse.exe
    for a green/portable bundle. Falls back to _MEIPASS/dist if the spec collects
    it there instead (not our release layout, but harmless).
    """
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
        candidate = base / "dist"
        if candidate.is_dir():
            return candidate
        meipass = Path(getattr(sys, "_MEIPASS", base)) / "dist"
        if meipass.is_dir():
            return meipass
    return Path(__file__).resolve().parents[2] / "teahouse-frontend" / "dist"


FRONTEND_DIST = _frontend_dist()
_API_PREFIXES = ("/api", "/v1", "/events", "/docs", "/redoc", "/openapi.json")


def _setup_static() -> None:
    if DEV_MODE:
        return
    if FRONTEND_DIST.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=str(FRONTEND_DIST / "assets")),
            name="frontend-assets",
        )


_setup_static()


@app.get("/{full_path:path}")
async def frontend_spa(full_path: str) -> FileResponse:
    # Let the real API routers handle these (they're registered earlier, but a
    # catch-all here must not return HTML for unknown API-ish paths). In dev
    # mode the SPA is served by Vite, so never fall back to HTML here.
    if DEV_MODE or full_path.startswith(_API_PREFIXES):
        raise HTTPException(status_code=404, detail="Not found")
    if FRONTEND_DIST.is_dir():
        target = (FRONTEND_DIST / full_path).resolve()
        # Guard against path traversal outside dist.
        if target.is_file() and FRONTEND_DIST.resolve() in target.parents:
            return FileResponse(str(target))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
    raise HTTPException(status_code=404, detail="Frontend not built")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    reload_flag = "--reload" in sys.argv or DEV_MODE

    # Bundled git: in a PyInstaller bundle, prepend <exe dir>/git/cmd to PATH so
    # subprocess git calls (git_utils) hit the shipped MinGit instead of relying
    # on the user's environment. No-op in source mode (no exe dir / no git sibling).
    if getattr(sys, "frozen", False):
        git_dir = Path(sys.executable).resolve().parent / "git"
        git_cmd = git_dir / "cmd"
        if git_cmd.is_dir():
            os.environ["PATH"] = str(git_cmd) + os.pathsep + os.environ.get("PATH", "")
            print(f"[teahouse] using bundled git: {git_dir}")
        else:
            print("[teahouse] bundled git/ not found — falling back to system git")

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
