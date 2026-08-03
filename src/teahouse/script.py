"""
Script engine — static JSONL tool-call scripts (剧情剧本).

A script is a JSONL file, one tool call per line:
    {"tool": "Output", "args": {...}}

The Director invokes it through the BatchExecute tool. Scripts are fully
static/hand-written — the Director edits the JSONL in place and re-invokes.
No runtime references (no {{vars}}/{{res}}); every step is self-contained.

The batch is expanded by app._tool_use_loop into N real tool calls that execute
in place, so each step behaves exactly like a hand-issued call: independent SSE
event, independent tool_result fed back into the LLM context, independent
persistence.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .tools import _validate_path


class ScriptError(Exception):
    """Raised on invalid script content."""
class BatchError(Exception):
    """Raised on batch path / load errors."""


# --------------------------------------------------------------------------
# Path slicing — support "xxx.jsonl" (all) and "xxx.jsonl:13-20" (rename run)
# --------------------------------------------------------------------------

_SLICE_TAIL_RE = re.compile(r"^(.+)\.jsonl:(\d+)-(\d+)$", re.IGNORECASE)


def parse_batch_path(raw: str) -> tuple[str, tuple[int, int] | None]:
    """Split a batch path into (relative_path, line_slice).

    - ``settings/scripts/opening.jsonl``        → (path, None)
    - ``settings/scripts/opening.jsonl:13-20``   → (path, (13, 20))
    """
    raw = raw.strip()
    m = _SLICE_TAIL_RE.match(raw)
    if m:
        return m.group(1) + ".jsonl", (int(m.group(2)), int(m.group(3)))
    return raw, None


def load_batch(instance_dir: Path, raw_path: str, *, max_steps: int = 50) -> list[dict]:
    """Read a static batch script, apply optional line slice, return steps.

    Raises BatchError on missing / malformed files or an over-large batch.
    """
    path_str, slice_range = parse_batch_path(raw_path)

    full = _validate_path(instance_dir, path_str)
    if not full.exists():
        raise BatchError(f"批次脚本不存在: {path_str}")
    if full.suffix.lower() != ".jsonl":
        raise BatchError(f"批次脚本必须是 .jsonl 文件: {path_str}")

    steps: list[dict] = []
    for i, line in enumerate(full.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            raise BatchError(f"批次脚本第 {i} 行 JSON 解析失败: {e}")
        if not isinstance(rec, dict) or "tool" not in rec:
            raise BatchError(f"批次脚本第 {i} 行缺少 'tool' 字段: {rec}")
        rec.setdefault("args", {})
        steps.append(rec)

    steps = slice_lines(steps, slice_range)
    if len(steps) > max_steps:
        raise BatchError(
            f"批次展开后共 {len(steps)} 步，超过上限 {max_steps}。"
            f"请用行切片续跑：{path_str}:1-{max_steps}"
        )
    if not steps:
        raise BatchError(f"批次为空或切片后无步骤: {path_str}")
    return steps


def slice_lines(steps: list[dict], sl: tuple[int, int] | None) -> list[dict]:
    """Apply a 1-indexed inclusive line slice to the loaded steps. None → all."""
    if sl is None:
        return steps
    a, b = sl
    a = max(1, a)
    b = min(len(steps), b)
    if a > b or a > len(steps):
        raise BatchError(f"行切片 {sl[0]}-{sl[1]} 越界（脚本共 {len(steps)} 步）")
    return steps[a - 1:b]
