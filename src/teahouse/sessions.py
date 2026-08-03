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


def load_records(instance_dir: Path) -> list[dict]:
    """Read all persisted records, newest last. Malformed lines are skipped."""
    path = instance_dir / SESSION_DIR / SESSION_FILE
    if not path.exists():
        return []
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def clear(instance_dir: Path) -> None:
    """Wipe the session file. Used by the ``/clear`` command."""
    path = instance_dir / SESSION_DIR / SESSION_FILE
    if path.exists():
        path.unlink()
