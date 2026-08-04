"""
Placeholder resolver — replaces {{path}} syntax with actual file contents.

Supported syntax:
  {{path}}                               Full file
  {{path:10-30}}                         Line range (1-indexed, inclusive)
  {{path:10-20|from="A"|to="B"}}         Line range then anchor crop
  {{path|from="A"|to="B"}}               Anchor-based range
  {{path|from="A"}}                      From anchor to end
  {{path|to="B"}}                        From start to anchor
  {{glob:pattern}}                       Glob-matched files, sorted
  {{glob:pattern:lastN}}                 Glob-matched files, keep the last N by numeric segment (descending)

Note: use | as the anchor separator, : for the line range.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional


class PlaceholderError(Exception):
    """Raised when a placeholder cannot be resolved."""


def resolve_placeholders(text: str, instance_dir: Path) -> str:
    """Replace all {{...}} placeholders in text with actual file contents."""
    def _replacer(match: re.Match) -> str:
        raw = match.group(1).strip()
        return _resolve_one(raw, instance_dir)

    return re.sub(r"\{\{(.+?)\}\}", _replacer, text)


def resolve_messages_placeholders(messages: list[dict], instance_dir: Path) -> list[dict]:
    """Recursively resolve placeholders in all string values of a messages array."""
    return [_resolve_msg_dict(msg, instance_dir) for msg in messages]


# =====================================================================
# Internal: recursive dict/list resolution
# =====================================================================

def _resolve_msg_dict(d: dict, instance_dir: Path) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = resolve_placeholders(v, instance_dir)
        elif isinstance(v, dict):
            out[k] = _resolve_msg_dict(v, instance_dir)
        elif isinstance(v, list):
            out[k] = [_resolve_msg_item(item, instance_dir) for item in v]
        else:
            out[k] = v
    return out


def _resolve_msg_item(item, instance_dir: Path):
    if isinstance(item, str):
        return resolve_placeholders(item, instance_dir)
    if isinstance(item, dict):
        return _resolve_msg_dict(item, instance_dir)
    if isinstance(item, list):
        return [_resolve_msg_item(i, instance_dir) for i in item]
    return item


# =====================================================================
# Internal: single placeholder resolution
# =====================================================================

def _resolve_one(raw: str, instance_dir: Path) -> str:
    if raw.startswith("glob:"):
        return _resolve_glob(raw[5:].strip(), instance_dir)
    return _resolve_file(raw, instance_dir)


_NUM_SEGMENT_RE = re.compile(r"(\d+)")


def _first_number(name: str) -> int | None:
    """Return the first numeric segment in a filename, or None if absent.

    e.g. 'floor-5.md' -> 5, 'floor-5-draft.md' -> 5, 'readme.md' -> None.
    """
    m = _NUM_SEGMENT_RE.search(name)
    return int(m.group(1)) if m else None


def _is_draft(name: str) -> bool:
    """A file is a 'draft' (semi-formal) when its stem carries a -draft suffix."""
    return bool(re.search(r"-draft\.", name))


def _resolve_glob(raw_pattern: str, instance_dir: Path) -> str:
    # Split off an optional trailing ':lastN' suffix, e.g. 'floors/floor-*.md:last30'.
    pattern = raw_pattern
    last_n: int | None = None
    if ":" in raw_pattern:
        head, _, tail = raw_pattern.rpartition(":")
        low = tail.strip()
        if low.lower().startswith("last"):
            try:
                n = int(low[4:].strip())
            except ValueError:
                n = None
            if n is not None:
                if n <= 0:
                    raise PlaceholderError(f"lastN must be > 0: {raw_pattern}")
                pattern, last_n = head.strip(), n
            else:
                raise PlaceholderError(f"Invalid lastN suffix in glob: {raw_pattern}")

    # Match against the instance root. `.teahouse/` is a hidden directory that
    # plain globs skip, so a shorthand pattern like "output/floors/floor-*.md"
    # (per the {{glob:...:lastN}} design) is retried under `.teahouse/output/`.
    matched = sorted(instance_dir.glob(pattern))
    if not matched and not pattern.startswith(".teahouse/"):
        prefixed = sorted(instance_dir.glob(f".teahouse/{pattern}"))
        if prefixed:
            matched = prefixed
    if not matched:
        raise PlaceholderError(f"glob pattern matched no files: {pattern}")

    if last_n is not None:
        matched = _take_last_by_number(matched, last_n)

    parts = []
    for path in matched:
        rel = str(path.relative_to(instance_dir)).replace("\\", "/")
        content = path.read_text(encoding="utf-8")
        parts.append(f"--- {rel} ---\n{content}")
    return "\n\n".join(parts)


def _take_last_by_number(matched: list[Path], last_n: int) -> list[Path]:
    """Keep the files whose numeric segment ranks in the top `last_n` (descending).

    Files are grouped by numeric segment; within one number the formal floor
    (floor-N.md) wins over the draft (floor-N-draft.md). Files without a numeric
    segment are dropped when a lastN window is requested. The chosen files are
    returned in ascending numeric order (floor 1 → N), since a glob window feeds
    prose into the context in story order.
    """
    best_by_num: dict[int, Path] = {}
    for p in matched:
        num = _first_number(p.name)
        if num is None:
            continue
        current = best_by_num.get(num)
        if current is None or (not _is_draft(p.name) and _is_draft(current.name)):
            best_by_num[num] = p

    chosen_nums = sorted(best_by_num.keys(), reverse=True)[:last_n]
    ordered = sorted(
        ((best_by_num[num], num) for num in chosen_nums),
        key=lambda pn: (pn[1], 0 if not _is_draft(pn[0].name) else 1),
    )
    return [p for p, _ in ordered]


def _resolve_file(raw: str, instance_dir: Path) -> str:
    # Split on | to separate file/line-range from anchor modifiers
    # e.g. "test.md:10-30|from=A|to=B" → ["test.md:10-30", "from=A", "to=B"]
    pipe_parts = _split_pipes_outside_quotes(raw)
    base_part = pipe_parts[0].strip()  # e.g. "test.md" or "test.md:10-30"
    anchor_parts = pipe_parts[1:]      # e.g. ['from="A"', 'to="B"']

    # Parse base: separate file path from optional line range
    colon_pos = base_part.find(":")
    if colon_pos == -1:
        file_path = base_part
        line_range = None
    else:
        file_path = base_part[:colon_pos].strip()
        line_range = _extract_line_range(base_part[colon_pos + 1:].strip())

    full = _resolve_file_path(instance_dir, file_path)
    content = full.read_text(encoding="utf-8")
    lines = content.splitlines(keepends=True)

    # 1. Line range
    if line_range is not None:
        start, end = line_range
        start = max(0, start)
        end = min(len(lines), end)
        if start >= end:
            raise PlaceholderError(f"Line range out of bounds: {start+1}-{end}")
        lines = lines[start:end]

    # 2. Anchor modifiers (from= / to=)
    for part in anchor_parts:
        part = part.strip()
        from_a = _extract_quoted(part, "from")
        to_a = _extract_quoted(part, "to")

        if from_a is not None:
            idx = _find_anchor_line(from_a, lines)
            lines = lines[idx:]

        if to_a is not None:
            idx = _find_anchor_line(to_a, lines)
            lines = lines[: idx + 1]  # include the anchor line

    return "".join(lines)


def _read_full(file_path: str, instance_dir: Path) -> str:
    return _resolve_file_path(instance_dir, file_path).read_text(encoding="utf-8")


def _resolve_file_path(instance_dir: Path, file_path: str) -> Path:
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise PlaceholderError(f"Path traversal detected: {file_path}")
    if not full.exists():
        raise PlaceholderError(f"File not found: {file_path}")
    if full.is_dir():
        raise PlaceholderError(f"Path is a directory: {file_path}")
    return full


# =====================================================================
# Modifier parsing
# =====================================================================

LINE_RANGE_RE = re.compile(r"^(\d+)\s*-\s*(\d+)$")


def _extract_line_range(s: str) -> Optional[tuple[int, int]]:
    """Extract 0-indexed [start, end) from a 'start-end' pattern.
    Returns None if no line range found.
    """
    s = s.strip()
    m = LINE_RANGE_RE.search(s)
    if not m:
        return None
    start = int(m.group(1)) - 1  # 1-indexed → 0-indexed
    end = int(m.group(2))         # inclusive → exclusive
    if start < 0:
        raise PlaceholderError(f"Line number must be >= 1, got {m.group(1)}")
    if start >= end:
        raise PlaceholderError(f"Empty line range: {start+1}-{end}")
    return (start, end)


def _split_pipes_outside_quotes(s: str) -> list[str]:
    """Split string by | that are not inside double quotes."""
    parts: list[str] = []
    current: list[str] = []
    in_quotes = False
    for ch in s:
        if ch == '"':
            in_quotes = not in_quotes
            current.append(ch)
        elif ch == "|" and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


def _extract_quoted(s: str, key: str) -> Optional[str]:
    """Extract value from key="value" pattern. Returns None if not found."""
    m = re.search(rf'{key}="([^"]*)"', s)
    return m.group(1) if m else None


def _find_anchor_line(anchor: str, lines: list[str]) -> int:
    """Find the 0-indexed line index containing anchor. Raises if not exactly one."""
    found = None
    for i, line in enumerate(lines):
        if anchor in line:
            if found is not None:
                raise PlaceholderError(f"Anchor appears on multiple lines: '{anchor}'")
            found = i
    if found is None:
        raise PlaceholderError(f"Anchor not found: '{anchor}'")
    return found
