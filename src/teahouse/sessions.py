"""Director session memory — durable per-instance conversation history.

Owns the canonical record of a director conversation (real user messages and
assistant reasoning/text/tool-call result blocks). Written by the backend as
each block completes; read back later by the frontend for initial render.

Design:
- One append-only JSONL per (instance, session) at ``.sessions/<session_id>.jsonl``
  (point-prefixed so directory-scoped tool reads skip it; the director cannot
  see it). Every session also has an optional ``.sessions/<session_id>.meta.json``
  for metadata (enabled_tools, etc.). The main conversation lives at ``main.jsonl``;
  other sessions use ``session-<uuid>.jsonl``.
- Append-only, never rewritten wholesale — a conversation grows indefinitely.
- Each line is a "record" shaped like the frontend ``RichMessage``:
    user:      {role:"user", content}
    assistant: {role:"assistant", content, reasoning, blocks:[text|tool_call]}
  Blocks are interleaved in generation order, matching the frontend shape so
  phase-2 replay can rebuild the UI 1:1.
- Only *real* conversation is persisted. Preset fake messages and the system
  prompt are injected transiently inside the tool-use loop and never reach here.

All sessions (main + child) share the same lifecycle: append, load, destroy.
There is no special "clear" vs "destroy" distinction — destroy removes both
the jsonl and the meta file for any session. Main can be destroyed and will
be lazily recreated on next use.
"""

from __future__ import annotations

import json
from pathlib import Path

SESSION_DIR = ".sessions"
MAIN_SESSION_ID = "main"


def resolve_session_path(instance_dir: Path, session_id: str) -> Path:
    """Get the JSONL path for a session, creating ``.sessions/`` if missing."""
    d = instance_dir / SESSION_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{session_id}.jsonl"


def _meta_path(instance_dir: Path, session_id: str) -> Path:
    """Get the metadata path for a session."""
    return instance_dir / SESSION_DIR / f"{session_id}.meta.json"


def ensure_meta(instance_dir: Path, session_id: str, defaults: dict | None = None) -> dict:
    """Return the session metadata, creating it with *defaults* if absent.

    Main session defaults to ``{}`` (empty = unrestricted). Callers that need
    specific defaults (e.g. ``enabled_tools`` for child sessions) pass them in.
    """
    p = _meta_path(instance_dir, session_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    meta = dict(defaults) if defaults else {}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


def load_meta(instance_dir: Path, session_id: str) -> dict:
    """Read session metadata. Returns ``{}`` if absent (never creates)."""
    p = _meta_path(instance_dir, session_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_meta(instance_dir: Path, session_id: str, meta: dict) -> None:
    """Overwrite the session metadata file."""
    p = _meta_path(instance_dir, session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def list_sessions(instance_dir: Path) -> list[dict]:
    """List existing sessions: ``[{session_id, record_count}]``.

    Scans ``.sessions/*.jsonl`` on disk. The main session is always included
    (even before its file exists), so the frontend always shows a stable main entry.
    """
    d = instance_dir / SESSION_DIR
    out: list[dict] = []
    seen: set[str] = set()
    if d.is_dir():
        for p in sorted(d.glob("*.jsonl")):
            sid = p.stem
            seen.add(sid)
            out.append({
                "session_id": sid,
                "record_count": _count_records(p),
            })
    # Main session is always reported — even if its file doesn't exist yet.
    if MAIN_SESSION_ID not in seen:
        out.insert(0, {"session_id": MAIN_SESSION_ID, "record_count": 0})
    return out


def _count_records(path: Path) -> int:
    if not path.exists():
        return 0
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            n += 1
    return n


def append_user(instance_dir: Path, content: str, session_id: str = MAIN_SESSION_ID) -> None:
    """Persist one real user message."""
    if not content:
        return
    append_record(
        instance_dir,
        {"role": "user", "content": content},
        session_id=session_id,
    )


def append_assistant(
    instance_dir: Path,
    *,
    content: str = "",
    reasoning: str = "",
    blocks: list[dict] | None = None,
    session_id: str = MAIN_SESSION_ID,
) -> None:
    """Persist one finished assistant record (reasoning + interleaved blocks).

    ``blocks`` are ``{type:"text"|"tool_call", ...}`` already in frontend shape.
    """
    append_record(
        instance_dir,
        {
            "role": "assistant",
            "content": content,
            "reasoning": reasoning,
            "blocks": blocks or [],
        },
        session_id=session_id,
    )


def append_record(instance_dir: Path, record: dict, session_id: str = MAIN_SESSION_ID) -> None:
    """Append a single JSON line to a session file."""
    path = resolve_session_path(instance_dir, session_id)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_records(
    instance_dir: Path,
    *,
    limit: int | None = None,
    offset: int = 0,
    session_id: str = MAIN_SESSION_ID,
) -> tuple[list[dict], int]:
    """Read persisted records, newest last. Malformed lines are skipped.

    Returns ``(records, total)``. ``offset``/``limit`` select a window measured
    from the *newest* record (offset=0 → the most recent ``limit``), for the
    frontend lazy-load path. ``total`` is the full record count.
    """
    path = instance_dir / SESSION_DIR / f"{session_id}.jsonl"
    if not path.exists():
        return [], 0
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    total = len(records)
    start = max(0, total - offset - (limit or total))
    end = total - offset if offset < total else 0
    return records[start:end], total


PREVIEW_LINES = 3


def _preview_str(text: str, max_lines: int = PREVIEW_LINES) -> str:
    """Clip a long string to a short preview for display (never for LLM context)."""
    trimmed = text.rstrip("\n")
    lines = trimmed.splitlines()
    if len(lines) > max_lines:
        shown = "\n".join(lines[:max_lines])
        return f"{shown}\n…({len(lines) - max_lines} more lines)"
    return trimmed


def render_records(records: list[dict]) -> list[dict]:
    """Return a *display* copy of records for the frontend renderer.

    Tool results are clipped to a short preview so the renderer never pulls
    large tool outputs into memory — the full result stays in storage for LLM
    context. Reasoning is kept (the thinking-collapse UI shows it) but is never
    fed back into LLM context (see ``records_to_context``).
    """
    out: list[dict] = []
    for rec in records:
        if rec.get("role") == "user":
            out.append({"role": "user", "content": rec.get("content", "")})
            continue
        # assistant
        blocks = []
        for b in rec.get("blocks") or []:
            if b.get("type") == "text":
                blocks.append({"type": "text", "text": b.get("text", "")})
            elif b.get("type") == "tool_call":
                result = b.get("result")
                block: dict = {
                    "type": "tool_call",
                    "id": b.get("id", ""),
                    "name": b.get("name", ""),
                    "args": b.get("args"),
                    # Only the clipped preview crosses to the renderer; the full
                    # tool output stays in storage for LLM context.
                    "result": _preview_str(result) if isinstance(result, str) else None,
                }
                # Display-only batch metadata (BatchExecute expansion) survives render
                if b.get("batch"):
                    block["batch"] = b["batch"]
                blocks.append(block)
        out.append({
            "role": "assistant",
            "content": rec.get("content", ""),
            "reasoning": rec.get("reasoning", ""),
            "blocks": blocks,
        })
    return out


def _api_tool_call(b, api_style: str) -> dict:
    """Build one API tool call / tool_use from a persisted tool_call block."""
    b_id = b.get("id", "")
    b_name = b.get("name", "")
    b_args = b.get("args") or {}
    if api_style == "anthropic":
        return {"type": "tool_use", "id": b_id, "name": b_name, "input": b_args}
    return {
        "id": b_id,
        "type": "function",
        "function": {"name": b_name, "arguments": json.dumps(b_args)},
    }


def _api_tool_result(b, api_style: str) -> dict:
    """Build one API tool_result message from a persisted tool_call block."""
    b_id = b.get("id", "")
    b_result = b.get("result")
    if b_result in (None, "(interrupted)"):
        result_msg = "[cancelled by user interruption]"
    else:
        result_msg = b_result
    # Mirror the live path's BatchExecute note so the director sees, on refresh /
    # replay, that this step was issued as part of a batch script (not a loner call).
    blk_batch = b.get("batch")
    if blk_batch and isinstance(blk_batch, dict):
        bpath = blk_batch.get("path", "?")
        bidx = blk_batch.get("index", "?")
        btotal = blk_batch.get("total", "?")
        result_msg = f"[This call was invoked by BatchExecute, NOT by you manually. It is auto-expanded sub-step {bidx}/{btotal} of the script {bpath}]\n{result_msg}"
    if api_style == "anthropic":
        return {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": b_id, "content": result_msg}],
        }
    return {"role": "tool", "tool_call_id": b_id, "content": result_msg}


def records_to_context(instance_dir: Path, api_style: str, session_id: str = MAIN_SESSION_ID) -> list[dict]:
    """Rebuild LLM-context messages from the full persisted history.

    Uses the *complete* tool results from storage (never clipped). Every
    assistant record's interleaved blocks are expanded back into API tool_calls
    + tool_result message pairs — for both completed and interrupted rounds — so
    the director re-gets what tools returned on the previous turns.
    """
    out: list[dict] = []
    records, _ = load_records(instance_dir, session_id=session_id)
    for rec in records:
        if rec.get("role") == "user":
            out.append({"role": "user", "content": rec.get("content", "")})
            continue
        # assistant
        text_parts: list[str] = []
        api_calls: list[dict] = []
        results: list[dict] = []
        for b in rec.get("blocks") or []:
            if b.get("type") == "text" and b.get("text"):
                text_parts.append(b["text"])
            elif b.get("type") == "tool_call":
                api_calls.append(_api_tool_call(b, api_style))
                results.append(_api_tool_result(b, api_style))
        content_text = "".join(text_parts) if text_parts else None
        if api_calls:
            if api_style == "anthropic":
                content_array: list[dict] = []
                if content_text:
                    content_array.append({"type": "text", "text": content_text})
                content_array.extend(api_calls)
                out.append({"role": "assistant", "content": content_array})
            else:
                out.append({
                    "role": "assistant",
                    "content": content_text or None,
                    "tool_calls": api_calls,
                })
            out.extend(results)
        else:
            out.append({"role": "assistant", "content": content_text or ""})
    return out


def destroy(instance_dir: Path, session_id: str) -> None:
    """Delete a session's JSONL and metadata file.

    Unified lifecycle — works for main and child sessions alike. Main will be
    lazily recreated on the next write.
    """
    sess = instance_dir / SESSION_DIR / f"{session_id}.jsonl"
    meta = instance_dir / SESSION_DIR / f"{session_id}.meta.json"
    for p in (sess, meta):
        if p.exists():
            p.unlink()


# -- legacy aliases (kept for backward-compat in routes) --

def clear(instance_dir: Path, session_id: str = MAIN_SESSION_ID) -> None:
    """Wipe a session file. Legacy — delegates to ``destroy``."""
    destroy(instance_dir, session_id)
