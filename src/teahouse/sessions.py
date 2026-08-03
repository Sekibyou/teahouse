"""Director session memory — durable per-instance conversation history.

Owns the canonical record of a director conversation (real user messages and
assistant reasoning/text/tool-call result blocks). Written by the backend as
each block completes; read back later by the frontend for initial render.

Design:
- One append-only JSONL per instance at ``.sessions/session.jsonl`` (point-prefixed
  so directory-scoped tool reads skip it; the director cannot see it).
- Append-only, never rewritten wholesale — a conversation grows indefinitely.
- Each line is a "record" shaped like the frontend ``RichMessage``:
    user:      {role:"user", content}
    assistant: {role:"assistant", content, reasoning, blocks:[text|tool_call]}
  Blocks are interleaved in generation order, matching the frontend shape so
  phase-2 replay can rebuild the UI 1:1.
- Only *real* conversation is persisted. Preset fake messages and the system
  prompt are injected transiently inside the tool-use loop and never reach here.
"""

from __future__ import annotations

import json
from pathlib import Path

SESSION_DIR = ".sessions"
SESSION_FILE = "session.jsonl"


def _session_path(instance_dir: Path) -> Path:
    """Get the JSONL path, creating ``.sessions/`` if missing."""
    d = instance_dir / SESSION_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d / SESSION_FILE


def append_user(instance_dir: Path, content: str) -> None:
    """Persist one real user message."""
    if not content:
        return
    append_record(
        instance_dir,
        {"role": "user", "content": content},
    )


def append_assistant(
    instance_dir: Path,
    *,
    content: str = "",
    reasoning: str = "",
    blocks: list[dict] | None = None,
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
    )


def append_record(instance_dir: Path, record: dict) -> None:
    """Append a single JSON line to the session file."""
    path = _session_path(instance_dir)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_records(
    instance_dir: Path,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Read persisted records, newest last. Malformed lines are skipped.

    Returns ``(records, total)``. ``offset``/``limit`` select a window measured
    from the *newest* record (offset=0 → the most recent ``limit``), for the
    frontend lazy-load path. ``total`` is the full record count.
    """
    path = instance_dir / SESSION_DIR / SESSION_FILE
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
    context. Reasoning is dropped from display (a thinking artifact, not part
    of the visible transcript).
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
                blocks.append({
                    "type": "tool_call",
                    "id": b.get("id", ""),
                    "name": b.get("name", ""),
                    "args": b.get("args"),
                    # Only the clipped preview crosses to the renderer; the full
                    # tool output stays in storage for LLM context.
                    "result": _preview_str(result) if isinstance(result, str) else None,
                })
        out.append({
            "role": "assistant",
            "content": rec.get("content", ""),
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
    if api_style == "anthropic":
        return {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": b_id, "content": result_msg}],
        }
    return {"role": "tool", "tool_call_id": b_id, "content": result_msg}


def records_to_context(instance_dir: Path, api_style: str) -> list[dict]:
    """Rebuild LLM-context messages from the full persisted history.

    Uses the *complete* tool results from storage (never clipped). Every
    assistant record's interleaved blocks are expanded back into API tool_calls
    + tool_result message pairs — for both completed and interrupted rounds — so
    the director re-gets what tools returned on the previous turns.
    """
    out: list[dict] = []
    records, _ = load_records(instance_dir)
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


def clear(instance_dir: Path) -> None:
    """Wipe the session file. Used by the ``/clear`` command."""
    path = instance_dir / SESSION_DIR / SESSION_FILE
    if path.exists():
        path.unlink()
