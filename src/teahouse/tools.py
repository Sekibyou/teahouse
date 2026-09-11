"""
Director tool definitions and executors.

Each tool is defined as an OpenAI-compatible function-calling schema,
with a corresponding async executor that operates on an instance's file system.

Following Claude Code's harness design: exact string matching for Edit,
path traversal protection, atomic operations with clear success/failure.

Tool definitions are loaded from director-system/tools.json — the single
source of truth for both the LLM function-calling schema and the natural-language
usage guide injected into the director's system prompt.
"""
from __future__ import annotations

import asyncio
import json
import uuid
import os
import re as _re
import shutil
from pathlib import Path
from typing import Any

from .placeholder import resolve_placeholders, resolve_variables, validate_var_name, drop_unmatched_mentions, strip_placeholder_shells, resolve_slice_spans, MAX_RESOLVE_DEPTH
from .config import LLMConfig
from .llm import LLMClient, LLMError
from .database.workspaces import read_sandbox_vars as _read_sandbox_vars, write_sandbox_vars as _write_sandbox_vars, build_type_map as _build_type_map
from .prose_vars import register_instance as _register_instance
from .git_utils import git_commit as _git_commit, git_branch as _git_branch, git_log as _git_log, git_branch_rename as _git_branch_rename, git_branch_create as _git_branch_create, git_rev_parse as _git_rev_parse, git_branch_switch_with_cleanup as _git_branch_switch_with_cleanup, git_status_porcelain, git_diff
from .state import state

# The runtime-vars file's canonical relative path within an instance. Because it
# is the "file-as-state" authority for variables, a few file tools may also touch
# it directly (not just SetRuntimeVar). When that happens we broadcast the same
# file_changed the sandbox relies on to re-resolve ${name} placeholders in prose.
RUNTIME_VARS_RELPATH = "runtime/runtime_vars.jsonl"


def _maybe_broadcast_vars_changed(instance_dir: Path, full: Path, tool: str, instance_id: str | None = None) -> None:
    """Broadcast the runtime-vars file_changed signal when the written path is
    the variables file (so prose ${name} placeholders re-resolve to new values)."""
    if full.resolve() == (instance_dir / RUNTIME_VARS_RELPATH).resolve():
        state.broadcast(
            "file_changed",
            {"path": RUNTIME_VARS_RELPATH, "tool": tool, "type": "modified", "instance_id": instance_id or instance_dir.name},
        )

import yaml
import time


def _to_base36(n: int) -> str:
    """Convert int to base-36 string, matching JS Date.now().toString(36)."""
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    result = ""
    while n > 0:
        n, rem = divmod(n, 36)
        result = chars[rem] + result
    return result


# ---------------------------------------------------------------------------
# Tool schema loading from tools.json
# ---------------------------------------------------------------------------

# Default path relative to this file — can be overridden via load_tools()
_TOOLS_JSON_PATH = Path(__file__).resolve().parent / "director-system" / "tools.json"

# Loaded at module level, reloaded via load_tools()
TOOLS: list[dict] = []


def _raw_tool_to_schema(tool: dict) -> dict:
    """Convert a raw tool entry from tools.json into an OpenAI function-calling schema dict."""
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["parameters"],
        },
    }


def load_tools(
    path: Path | None = None,
    user_id: str | None = None,
    only: set[str] | None = None,
    exclude: set[str] | None = None,
) -> list[dict]:
    """Load tool schemas from tools.json, returning OpenAI-compatible function-calling format.

    Call this once at startup. The result is also stored in the module-level TOOLS variable.
    Includes plugin-provided tools for the given user if plugins are loaded.

    ``only`` (optional) restricts the returned schemas to that name set — used to
    give the DM a lean, role-specific toolset. When set, plugin tools are omitted
    (they are director-scoped extensions, not part of the DM's fixed set).
    ``exclude`` (optional) drops that name set — used to keep DM-only tools out of
    the director's schema (see DIRECTOR_EXCLUDED_TOOLS).
    """
    global TOOLS
    p = path or _TOOLS_JSON_PATH
    raw = json.loads(p.read_text(encoding="utf-8"))
    if only is not None:
        raw = [t for t in raw if t.get("name") in only]
    if exclude:
        raw = [t for t in raw if t.get("name") not in exclude]
    builtin = [_raw_tool_to_schema(t) for t in raw]

    # Merge plugin tools — scoped to the calling user so one user's plugin
    # tools never leak into another user's tool schema. Startup/global loads
    # (no user_id) stay builtin-only; per-director-round loads pass the user.
    try:
        if user_id and only is None:
            from .plugins import get_tool_defs_from_plugins
            plugin_defs = get_tool_defs_from_plugins(user_id)
            plugin_schemas = [_raw_tool_to_schema(t) for t in plugin_defs]
            TOOLS = builtin + plugin_schemas
        else:
            TOOLS = builtin
    except Exception:
        TOOLS = builtin

    return TOOLS


def load_tools_summary(
    path: Path | None = None,
    exclude: set[str] | None = None,
) -> list[dict]:
    """Return ``[{name, short}]`` for the builtin tools.

    Used by the frontend's permission autocomplete (sub-session tool picker).
    ``short`` is a one-line label from tools.json; falls back to ``description``
    when a tool lacks a ``short`` field.
    ``exclude`` (optional) drops that name set — sub-session grants are always
    director-side, so DM-only tools must not be offered there.
    """
    raw = json.loads((path or _TOOLS_JSON_PATH).read_text(encoding="utf-8"))
    if exclude:
        raw = [t for t in raw if t.get("name") not in exclude]
    return [
        {"name": t["name"], "short": t.get("short") or t.get("description", "")}
        for t in raw
    ]


async def load_tools_usage(
    path: Path | None = None,
    user_id: str | None = None,
    only: set[str] | None = None,
    exclude: set[str] | None = None,
) -> str:
    """Build the natural-language tool usage guide from tools.json.

    Each tool's `usage` field is rendered as a markdown section.
    Tools without a `usage` field are skipped.
    Includes plugin tool usage guides, resolving `${var:key}` references against
    the plugin's live plugin_data each assembly.
    Returns the combined text for injection into the director's system prompt.

    ``only`` (optional) restricts the guide to that name set — used to build the
    DM's lean usage guide. Plugin usage guides are omitted when set.
    ``exclude`` (optional) drops that name set — see DIRECTOR_EXCLUDED_TOOLS.
    """
    p = path or _TOOLS_JSON_PATH
    raw = json.loads(p.read_text(encoding="utf-8"))
    if only is not None:
        raw = [t for t in raw if t.get("name") in only]
    if exclude:
        raw = [t for t in raw if t.get("name") not in exclude]

    sections = ["# 工具使用指南\n"]
    for tool in raw:
        name = tool["name"]
        usage = tool.get("usage", "")
        if not usage:
            continue

        sections.append(f"## {name}\n")
        sections.append(f"{usage}\n")

    # Append plugin tool usage guides — scoped per user, resolving ${var:...}
    # against the plugin's live data. Only when a user context is present.
    try:
        if user_id and only is None:
            from .plugins import get_tool_defs_from_plugins
            plugin_defs = get_tool_defs_from_plugins(user_id)
            if plugin_defs:
                sections.append("\n## 插件工具\n")
                for tool in plugin_defs:
                    name = tool["name"]
                    usage = await _resolve_plugin_usage(tool, user_id) or tool["description"]
                    sections.append(f"### {name}\n")
                    sections.append(f"{usage}\n")
    except Exception:
        pass

    return "\n".join(sections)


async def _resolve_plugin_usage(tool: dict, user_id: str | None) -> str | None:
    """Resolve a plugin tool's `usage`, expanding `${var:key}` against the owning
    plugin's live plugin_data. Unknown keys fall back to the literal token."""
    usage = tool.get("usage")
    if not usage or user_id is None or "${var:" not in usage:
        return usage

    import re as _re
    plugin_id = tool.get("_plugin_id")
    if not plugin_id:
        return usage
    from .database.plugins import get_plugin_data
    try:
        data = await get_plugin_data(plugin_id, user_id)
    except Exception:
        return usage

    def _sub(m):
        key = m.group(1)
        return str(data.get(key, m.group(0)))
    return _re.sub(r"\$\{var:([^}]+)\}", _sub, usage)


# Eager-load at import time so existing imports of `TOOLS` still work
load_tools()


# ---------------------------------------------------------------------------
# Tool executors
# ---------------------------------------------------------------------------


def _validate_path(instance_dir: Path, file_path: str) -> Path:
    """Resolve and validate a path is within the instance directory. Path traversal protection."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError(f"Path traversal detected: {file_path}")
    return full


async def execute_read(instance_dir: Path, args: dict[str, Any]) -> str:
    """Read file contents, optionally by line range OR by a slice expression.

    Two mutually-exclusive modes:
      - path/offset/limit: read a file's lines (existing behavior).
      - slice: a {{path|...}} placeholder expression (e.g.
        "{{payload.json|between=\"A\"|and=\"B\"}}") that is resolved to text via the
        SAME placeholder resolver — so every slice capability (between/and in-line
        crop, from/to line anchors, :line-range, {{glob}}) is available without
        adding a parallel param set. When slice is present, path/offset/limit are
        ignored. strict=True so an unresolvable slice (bad file / non-unique anchor)
        raises an explicit error instead of silently echoing the {{...}} literal.
    """
    slice_expr = args.get("slice")

    # Slice mode: resolve the expression with source-line tracking and display
    # REAL source file + line numbers (unlike plain re-numbering of the crop).
    if slice_expr is not None:
        try:
            segs = resolve_slice_spans(str(slice_expr), instance_dir)
        except Exception as e:
            return f"Error: 切片解析失败: {e}"
        return _format_read_slice(segs, file_label=str(slice_expr))

    path = args["path"]
    offset = args.get("offset")
    limit = args.get("limit")

    full = _validate_path(instance_dir, path)
    if not full.exists():
        return f"Error: File not found: {path}"
    if full.is_dir():
        return f"Error: Path is a directory, not a file: {path}"

    lines = full.read_text(encoding="utf-8").splitlines(keepends=True)
    total = len(lines)

    if offset is not None:
        offset = int(offset)
        if offset < 1:
            return f"Error: offset must be >= 1, got {offset}"
        start = offset - 1
    else:
        start = 0

    if limit is not None:
        limit = int(limit)
        end = start + limit
    else:
        end = total

    selected = lines[start:end]

    # Slice mode never truncates (its text is already the crop); the whole-file /
    # no-limit line path is the only one subject to the char cap below. Pass a
    # marker so the footer's truncation note matches how selected was built.
    return _format_read_result(selected, start=start, end=end, total=total,
                               file_label=path, instance_dir=instance_dir)


def _format_read_result(selected: list[str], start: int, end: int, total: int,
                        file_label: str, instance_dir: Path) -> str:
    """Shared line-numbered Read output for both file lines and slice text.

    Applies the BIG_INPUT_CHAR_LIMIT cap only on a whole-selection (no range) read.
    """
    from .compact import BIG_INPUT_CHAR_LIMIT

    # Line numbers shown are 1-based absolute (start is the 0-based index of the
    # first selected line); total_chars reflects the SELECTED lines, not the file.
    total_chars = sum(len(l) for l in selected)

    truncated = False
    if start == 0 and end == total:
        # Whole-selection path — cap chars over the full selection.
        budget = BIG_INPUT_CHAR_LIMIT
        kept_lines: list[str] = []
        used = 0
        for line in selected:
            if used + len(line) > budget and kept_lines:
                truncated = True
                break
            kept_lines.append(line)
            used += len(line)
        if used > budget:
            # A single line alone exceeds the cap — emit its head, still capped.
            truncated = True
            line_txt = selected[0]
            kept_lines = [line_txt[:budget]]
        selected = kept_lines
        end = start + len(selected)

    # Build output with line numbers like Claude Code:
    #   N  │ content
    #     │
    #   M  │ last line
    #     │
    #   (N–M/M lines, file: path)
    line_width = len(str(end)) if end else 1
    result_lines = []
    for i, line in enumerate(selected):
        line_num = start + 1 + i
        content = line.rstrip("\n").rstrip("\r")
        result_lines.append(f"{str(line_num).rjust(line_width)}  │ {content}")
    result_lines.append(" " * line_width + "  │")
    size_note = ""
    if truncated:
        size_note = (
            f"; 已达单次读取上限 {BIG_INPUT_CHAR_LIMIT:,} 字符，"
            f"文件共 {total_chars:,} 字符，已省略后续部分，可用 limit/offset 或更窄的切片分段读取"
        )
    result_lines.append(f"  ({start + 1}–{min(end, total)}/{total} lines, source: {file_label}){size_note}")

    return "\n".join(result_lines)


def _format_read_slice(segs, file_label: str) -> str:
    """Render line-aware slice segments with REAL source line numbers.

    Each SliceSegment (one source file) gets a header line; within a segment every
    row shows the line's true 1-indexed line number in that source file. A row whose
    line was cut mid-way by between/and is marked with a `~` prefix on its number.
    Mirrors _format_read_result's look (rjust, │ gutter) so slice output reads the
    same as plain Read but locates rows in the source file.
    """
    from .compact import BIG_INPUT_CHAR_LIMIT

    # Flatten segments but keep per-line real numbers. Compute the max width from
    # the largest real line number shown, for a stable gutter.
    all_rows = []  # (text, line_no, partial, file_header_before)
    max_ln = 1
    for sg in segs:
        header = f"── file: {sg.source.file_rel}  (lines {sg.source.start_line}–{sg.source.end_line}) ──"
        for ln in sg.lines:
            all_rows.append((ln.text, ln.line_no, ln.partial, header))
            max_ln = max(max_ln, ln.line_no)
    if not all_rows:
        return "（切片结果为空）"

    # Char cap across the whole slice result.
    used = 0
    truncated = False
    capped_rows = []
    for text, lno, partial, hdr in all_rows:
        if used + len(text) > BIG_INPUT_CHAR_LIMIT and capped_rows:
            truncated = True
            break
        capped_rows.append((text, lno, partial, hdr))
        used += len(text)

    width = len(str(max_ln))
    out = []
    last_hdr = None
    for text, lno, partial, hdr in capped_rows:
        if hdr != last_hdr:
            out.append(hdr)
            last_hdr = hdr
        num = f"{lno}" if not partial else f"~{lno}"
        out.append(f"{num.rjust(width)}  │ {text.rstrip(chr(10)).rstrip(chr(13))}")
    size_note = (
        f"; 已达单次读取上限 {BIG_INPUT_CHAR_LIMIT:,} 字符，已省略后续部分"
        if truncated else ""
    )
    nfiles = len(segs)
    total_rows = len(capped_rows)
    out.append(f"  (slice: {total_rows} 行 / {nfiles} 个文件, source: {file_label}){size_note}")
    out.append("  注: 行号为源文件真实行号; `~` 开头=该行被 between/and 从中腰裁切(仅部分显示)")
    return "\n".join(out)


def _fmt_var_entry(item: dict) -> str:
    """Format a {name, value, note?, change_log?} entry for director display."""
    import json as _json
    try:
        value_txt = _json.dumps(item["value"], ensure_ascii=False)
    except (TypeError, ValueError):
        value_txt = str(item["value"])
    line = f"{item['name']}: {value_txt}"
    if item.get("note"):
        line += f"\n  note: {item['note']}"
    log = item.get("change_log")
    if log:
        try:
            log_txt = _json.dumps(log, ensure_ascii=False)
        except (TypeError, ValueError):
            log_txt = str(log)
        line += f"\n  change_log: {log_txt}"
    return line


async def execute_get_runtime_vars(instance_dir: Path, args: dict[str, Any]) -> str:
    """Read runtime variables by name. Values + optional note/change_log metadata."""
    names = args.get("names")
    if names is None:
        return "Error: 'names' is required — pass an array of variable names to read (e.g. [\"opt-3-1\"])"
    if not isinstance(names, list):
        names = [names]
    names = [str(n) for n in names]

    try:
        items = _read_sandbox_vars(instance_dir, names)
    except ValueError as e:
        return f"Error: {e}"

    if not items:
        return "No sandbox variables found with the requested names."

    return "\n".join(_fmt_var_entry(item) for item in items)


async def execute_set_runtime_var(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Write runtime variables. Merges `updates` (+ optional `note`/`change_log`/`meta`).

    - `updates`: {name: value} — overwrite value; missing names are created.
    - `note`: {name: content} — overwrite that variable's note (metadata).
    - `change_log`: {name: entry} — APPEND an entry to that variable's change_log.
    - `meta`: {name: {type?, min?, max?}} — declare/overwrite the strong type and
      numeric bounds. Type is enforced on write; out-of-range numbers are clamped.
    - `delete`: list of names — remove those variables entirely.
    File-as-state: persisted to runtime/runtime_vars.jsonl, authoritative + git-tracked.
    """
    updates = args.get("updates")
    note = args.get("note")
    change_log = args.get("change_log")
    meta = args.get("meta")
    delete = args.get("delete")

    if not isinstance(delete, list):
        delete = []
    delete = [str(d) for d in delete]

    if updates is not None and not isinstance(updates, dict):
        return "Error: 'updates' must be an object of {name: value}"
    if note is not None and not isinstance(note, dict):
        return "Error: 'note' must be an object of {name: content}"
    if change_log is not None and not isinstance(change_log, dict):
        return "Error: 'change_log' must be an object of {name: entry}"
    if meta is not None and not isinstance(meta, dict):
        return "Error: 'meta' must be an object of {name: {type, min, max}}"
    if not updates and not note and not change_log and not meta and not delete:
        return "Error: provide at least one of updates / note / change_log / meta / delete"

    # Whitespace/colon/@ in a variable name breaks ${...} identifiers /
    # codespace:colon triggers the condition judgement path and @ the @-directive
    # prefix — reject up front rather than silently.
    bad_names: set[str] = set()
    for mapping in (updates, note, change_log, meta):
        if not mapping:
            continue
        for k in mapping:
            err = validate_var_name(k)
            if err:
                bad_names.add(str(k))
    for k in delete:
        err = validate_var_name(k)
        if err:
            bad_names.add(str(k))
    if bad_names:
        detail = "; ".join(validate_var_name(k) for k in sorted(bad_names))
        return "Error: " + detail

    # Reserved namespace guard across every name-bearing arg
    prefix_warn = ""
    reserved = []
    for mapping in (updates, note, change_log, meta):
        if not mapping:
            continue
        for k in mapping:
            if str(k).startswith("teahouse."):
                reserved.append(str(k))
    for k in delete:
        if str(k).startswith("teahouse."):
            reserved.append(str(k))
    if reserved:
        prefix_warn = (
            f"\nWARNING: 'teahouse.' is a reserved prefix for system-internal variables. "
            f"Ignoring reserved key(s): {', '.join(reserved)}."
        )
        reserved_key_set = set(reserved)
        for mapping in (updates, note, change_log, meta):
            if not mapping:
                continue
            for k in list(mapping):
                if str(k) in reserved_key_set:
                    mapping.pop(k)
        delete = [d for d in delete if d not in reserved_key_set]

    try:
        if updates or meta:
            _write_sandbox_vars(instance_dir, updates or {}, note=note, change_log=change_log, meta=meta)
        elif note or change_log:
            # metadata-only update with no value change
            _write_sandbox_vars(instance_dir, {}, note=note, change_log=change_log)
        if delete:
            from .database.workspaces import delete_sandbox_vars as _delete_sandbox_vars
            _delete_sandbox_vars(instance_dir, delete)
    except ValueError as e:
        return f"Error: {e}"

    state.broadcast(
        "file_changed",
        {"path": "runtime/runtime_vars.jsonl", "tool": "SetRuntimeVar", "type": "modified", "instance_id": instance_id or instance_dir.name},
    )

    affected = list(updates.keys()) if updates else []
    affected += list(note.keys()) if note else []
    affected += list(change_log.keys()) if change_log else []
    affected += list(meta.keys()) if meta else []
    if delete:
        return "Variables deleted: " + ", ".join(delete) + prefix_warn

    items = _read_sandbox_vars(instance_dir, list(dict.fromkeys(affected)))
    if not items:
        return "No variables found." + prefix_warn
    return "Variables set:\n" + "\n".join(_fmt_var_entry(item) for item in items) + prefix_warn


async def execute_repair_vars(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Rebuild the whole variable store from the OLDEST snapshot in git history.

    Manual fallback for when the variable state and the prose have gone out of sync —
    e.g. a snapshot that looks wrong, or a variable block edited on an older formal
    floor (which the normal recompute cannot see, because it only replays floors above
    the latest snapshot). Re-derives everything forward from the oldest committed
    snapshot and re-freezes the snapshot at the current formal floor.
    """
    from .prose_vars import full_repair

    try:
        errors, info = full_repair(instance_dir)
    except Exception as e:  # noqa: BLE001 — surface any git/IO failure as a tool error
        return f"Error: 变量全量修复失败：{e}"

    src = f"提交 {info['base_commit'][:9]}" if info["base_commit"] else "无可用历史快照，从零起算"
    lines = [
        "变量已按 git 历史里最早的可用快照全量重建。",
        f"- 基底：第 {info['base_floor']} 楼（{src}）",
        f"- 重放的正式楼层：{info['replayed'] or '（无）'}",
        f"- 重放的草稿楼层：{info['drafts'] or '（无）'}",
        f"- 当前正式楼层：{info['floor']}；变量数：{info['vars']}",
        "- 权威快照已就地重冻结（runtime/runtime_vars_snapshot.jsonl 已改动，需 GitCommit 才会入库）。",
    ]
    if info.get("skipped"):
        lines.append(
            f"- 已跳过 {info['skipped']} 个楼层号高于当前正式楼层的早期快照"
            "（多为原型携带的、与本实例楼层数不符的编号）。"
        )
    if errors:
        lines.append("- 解析/应用告警：" + "；".join(errors))
    return "\n".join(lines)


def _sandbox_var_map(instance_dir: Path) -> dict:
    """Flat name→value dict of the instance sandbox variables."""
    try:
        items = _read_sandbox_vars(instance_dir, None)
    except ValueError:
        return {}
    return {item["name"]: item["value"] for item in items}


def _resolve_messages_vars(messages: list[dict], instance_dir: Path, max_depth: int = MAX_RESOLVE_DEPTH) -> list[dict]:
    """Resolve ${name} + {{path}} in every string value of a messages list (Generate).

    Both surfaces an LLM consumes resolve variables before send (酒馆-style): the
    writer/Generate path materializes `${name}` to its value so the prose `AI` writes
    uses real values (not placeholders) — the sandbox later applies special effects via
    regex on the resolved text.

    @mention 的跨消息匹配：`mention_source` 传「上一轮全部消息 content 拼接」的只读变量
    （prev_joined），使 system 里的 @mention 能匹配到 user/assistant 其它消息的正文。
    因此这里用**跨消息多轮**：每轮以当轮 prev_joined 作 @mention 匹配源，逐条 resolve 各
    content，直到稳定；全部轮结束后统一销毁仍未命中的 @mention 残留（跨消息最后一轮才销毁，
    resolve_variables 内部在 mention_source 非 None 时不销毁、透传保留）。
    """
    var_map = _sandbox_var_map(instance_dir)
    type_map = _build_type_map(instance_dir)

    def _msg_content_str(m: dict) -> str:
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "\n".join(
                p.get("text") if isinstance(p, dict) and isinstance(p.get("text"), str) else ""
                for p in c
            )
        return ""

    def _resolve_value(v, mention_source):
        if isinstance(v, str):
            if "{{" in v or "${" in v:
                # 阶段二外层循环是唯一的层数推进源：内层 resolve_variables 每轮只
                # 推进一层（max_depth=1），这样 max_depth 精确等于「总展开层数」，
                # 不会因内层又跑一个 range(max_depth) 而被放大（off-by-one）。
                return resolve_variables(v, var_map, instance_dir, max_depth=1, type_map=type_map,
                                         mention_source=mention_source)
            return v
        if isinstance(v, dict):
            return {k: _resolve_value(x, mention_source) for k, x in v.items()}
        if isinstance(v, list):
            return [_resolve_value(x, mention_source) for x in v]
        return v

    def _resolve_content(v, mention_source):
        """解析一条消息的 content（str 或 list-of-parts），返回替换后的同构结构。"""
        return _resolve_value(v, mention_source)

    resolved = [dict(m) for m in messages]

    # —— 阶段一：仅展开文件切片 {{...}} 的第 1 层（计入 max_depth 预算）——
    # 不用 resolve_variables（那会连 @mention 一起处理、并展开其 return 值里的 {{}}，破坏
    # ${@mention ...: "{{file}}"} 的字面量结构）。这里只 resolve_placeholders，把初始切片
    # 展开一层成真实正文，作为稍后 @mention 的判定依据。max_depth=0 时一步都不展开
    # （占位符全部按字面量保留）。
    budget = max(int(max_depth), 0)
    # 阶段一：预展开初始 `{{}}` 的第 1 层（计入预算，仅当确有顶层 `{{}}` 可解时才扣减——
    # 纯 `${}` 链没有 `{{}}`，阶段一不推进，预算全部留给阶段二解 `${}`，保证两类链精确）。
    had_slice = False
    if budget > 0:
        for m in resolved:
            c = m.get("content")
            if isinstance(c, str) and "{{" in c:
                m["content"] = resolve_placeholders(c, instance_dir)
                had_slice = True
        if had_slice:
            budget -= 1

    # —— 阶段二：跨消息快照 + 完整占位符（含 @mention）判定，推进剩余预算层 ——
    # 快照分两个用途：
    #   稳定判定用「完整 content 拼接」（保留占位符）——若用 strip_placeholder_shells
    #   剥壳，则中间产物 `{{refN}}` 会被剥成空串，导致纯 `{{}}` 链每轮快照都相等而被
    #   误判「已稳定」提前 break，无法推进到预算层数。
    #   @mention 匹配源用「剥壳拼接」（strip_placeholder_shells）——去掉 ${@mention 剑: "x"}
    #   这类占位符参数，避免触发词来自占位符参数本身。
    # 剩余预算轮是唯一的外层层数源，每轮经 _resolve_value 的内层 resolve_variables(max_depth=1)
    # 恰好推进一层，故 total 展开层数 === max_depth。
    snapshot_full = "\n".join(_msg_content_str(m) for m in resolved)
    snapshot_trim = "\n".join(strip_placeholder_shells(_msg_content_str(m)) for m in resolved)
    for _ in range(budget):
        prev_full = snapshot_full
        for m in resolved:
            c = m.get("content")
            if c is not None:
                m["content"] = _resolve_content(c, snapshot_trim)
        snapshot_full = "\n".join(_msg_content_str(m) for m in resolved)
        snapshot_trim = "\n".join(strip_placeholder_shells(_msg_content_str(m)) for m in resolved)
        if snapshot_full == prev_full:
            break

    # —— 阶段三：最终统一销毁仍未命中的 @mention 残留 ——
    for m in resolved:
        c = m.get("content")
        if isinstance(c, str) and "${" in c:
            m["content"] = drop_unmatched_mentions(c)
        elif isinstance(c, list):
            m["content"] = [
                {**p, "text": drop_unmatched_mentions(p["text"])}
                if isinstance(p, dict) and isinstance(p.get("text"), str) and "@mention" in p["text"]
                else p
                for p in c
            ]
    return resolved


async def execute_write(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Write content to a file (overwrite). Creates parent directories if needed.

    Set resolve_placeholders=true to resolve {{path}} placeholders in content.
    Default is false — placeholders are written literally.
    """
    path = args["path"]
    content = args["content"]

    # Resolve {{path}} placeholders (only when explicitly requested).
    # File slicing is a "copy/move" primitive that does NOT resolve variables —
    # content is materialized verbatim, only placeholders pointing at other files expand.
    if args.get("resolve_placeholders", False) and "{{" in content:
        try:
            content = resolve_placeholders(content, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"

    full = _validate_path(instance_dir, path)
    existed = full.exists()
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    state.broadcast("file_changed", {"path": path, "tool": "Write", "type": "modified" if existed else "created", "instance_id": instance_id or instance_dir.name})
    _maybe_broadcast_vars_changed(instance_dir, full, "Write", instance_id)
    return f"Successfully wrote {len(content.encode('utf-8'))} bytes to {path}. File state is now up to date in your context — no need to Read it back."


async def execute_edit(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Edit a file by exact string replacement, optionally confined to a region.

    Region confinement (mutually exclusive, both optional):
      - offset/limit: 1-based line range, like Read's line mode.
      - slice: a {{path|...}} slice expression (same syntax as Read's slice mode);
        only single-file slices are supported.
    Without either, the whole file is the region (legacy behavior).

    Follows Claude Code harness rules:
    - old_string must appear exactly once in the REGION (unless replace_all=True)
    - Must match whitespace exactly
    - Atomic: on failure, file is unchanged
    Set resolve_placeholders=true to resolve {{path}} placeholders in new_string.
    Default is false.
    """
    path = args.get("path")
    slice_expr = args.get("slice")
    old_string = args["old_string"]
    new_string = args["new_string"]
    replace_all = args.get("replace_all", False)
    offset = args.get("offset")
    limit = args.get("limit")

    has_line_range = offset is not None or limit is not None
    if slice_expr is not None and has_line_range:
        return "Error: slice 与 offset/limit 是两种区域限定方式，二选一。"
    # slice 自带文件路径且是权威；同时传 path 时忽略它而非报错（导演常误传）。
    ignored_path = None
    if slice_expr is not None and path:
        ignored_path = path
        path = None
    if slice_expr is None and not path:
        return "Error: 缺少目标文件 —— path 与 slice 二选一必填（本次两者都没给）。"

    # Resolve {{path}} placeholders in new_string (only when explicitly requested).
    # File slicing does NOT resolve variables (copy/move primitive).
    if args.get("resolve_placeholders", False) and "{{" in new_string:
        try:
            new_string = resolve_placeholders(new_string, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"

    if slice_expr is not None:
        try:
            segs = resolve_slice_spans(str(slice_expr), instance_dir)
        except Exception as e:
            return f"Error: 切片解析失败: {e}"
        if len(segs) != 1:
            return "Error: slice 区域限定仅支持单文件切片（glob/多文件不适用），请收窄到单个文件。"
        seg = segs[0]
        if seg.source.char_start is None or seg.source.char_end is None:
            return "Error: 切片区域不可定位（内部错误）。"
        full = _validate_path(instance_dir, seg.source.file_rel)
        if not full.exists():
            return f"Error: File not found: {seg.source.file_rel}"
        content = full.read_text(encoding="utf-8")
        cs, ce = seg.source.char_start, seg.source.char_end
        label = (
            f"{seg.source.file_rel} 第 {seg.source.start_line}–{seg.source.end_line} 行"
            f"（slice: {slice_expr}）"
        )
        if ignored_path:
            label += f"（已忽略同时传入的 path={ignored_path}，以 slice 为准）"
        return _apply_edit_in_region(
            instance_dir, full, content, cs, ce, seg.source.file_rel,
            old_string, new_string, replace_all, label, instance_id,
        )

    full = _validate_path(instance_dir, path)
    if not full.exists():
        return f"Error: File not found: {path}"

    content = full.read_text(encoding="utf-8")

    if not has_line_range:
        cs, ce = 0, len(content)
        label = path
    else:
        lines = content.splitlines(keepends=True)
        total = len(lines)
        start = int(offset) - 1 if offset is not None else 0
        if start < 0:
            return f"Error: offset must be >= 1, got {int(offset)}"
        if start > total:
            return f"Error: offset ({int(offset)}) exceeds file length ({total} lines)"
        if limit is not None and int(limit) < 1:
            return f"Error: limit must be >= 1, got {int(limit)}"
        end = start + int(limit) if limit is not None else total
        end = min(end, total)
        cs = sum(len(l) for l in lines[:start])
        ce = sum(len(l) for l in lines[:end])
        label = f"{path} 第 {start + 1}–{end} 行"

    return _apply_edit_in_region(
        instance_dir, full, content, cs, ce, path,
        old_string, new_string, replace_all, label, instance_id,
    )


def _apply_edit_in_region(
    instance_dir: Path,
    full: Path,
    content: str,
    cs: int,
    ce: int,
    rel_path: str,
    old_string: str,
    new_string: str,
    replace_all: bool,
    label: str,
    instance_id: str | None,
) -> str:
    """Replace old_string within content[cs:ce] only, write back, broadcast.

    Matches must be fully inside the region — an occurrence straddling a region
    boundary is neither counted nor replaced.
    """
    region = content[cs:ce]
    count = region.count(old_string)
    if count == 0:
        return (
            f"Error: old_string not found in {label}. "
            "Note that the match must be exact including whitespace and line endings, "
            "and must lie entirely inside the confined region."
        )
    if count > 1 and not replace_all:
        return (
            f"Error: old_string appears {count} times in {label}. Must be unique within "
            "the region. Set replace_all=true to replace all occurrences, include more "
            "surrounding context, or narrow the region."
        )

    if replace_all:
        new_region = region.replace(old_string, new_string)
    else:
        new_region = region.replace(old_string, new_string, 1)
    full.write_text(content[:cs] + new_region + content[ce:], encoding="utf-8")
    state.broadcast("file_changed", {"path": rel_path, "tool": "Edit", "type": "modified", "instance_id": instance_id or instance_dir.name})
    _maybe_broadcast_vars_changed(instance_dir, full, "Edit", instance_id)
    if replace_all:
        return f"Successfully replaced all {count} occurrences in {label}. File state is now up to date in your context — no need to Read it back."
    return f"Successfully applied edit to {label}. File state is now up to date in your context — no need to Read it back."


async def execute_report(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Write a sub-session / exploration report to temp/ as markdown.

    ``mode="write"`` overwrites (creates or replaces); ``mode="edit"`` appends.
    Restricted to temp/*.md — reports must never touch formal artifact dirs.
    The temp/ dir is gitignored, so reports stay out of version control.
    """
    mode = args.get("mode", "write")
    filename = args.get("filename", "")
    content = args.get("content", "")

    if mode not in ("write", "edit"):
        return f"Error: mode must be 'write' or 'edit', got {mode!r}"
    if not filename:
        return "Error: filename is required"

    rel = f"temp/{filename}"
    full = _validate_path(instance_dir, rel)
    # Constrain to temp/ only — reports must not escape the scratch area.
    temp_root = (instance_dir / "temp").resolve()
    if not str(full).startswith(str(temp_root)):
        return f"Error: Report may only write under temp/, got {rel}"

    full.parent.mkdir(parents=True, exist_ok=True)
    if mode == "edit" and full.exists():
        full.write_text(full.read_text(encoding="utf-8") + content, encoding="utf-8")
        change_type = "modified"
    else:
        full.write_text(content, encoding="utf-8")
        change_type = "created"
    state.broadcast("file_changed", {"path": rel, "tool": "Report", "type": change_type, "instance_id": instance_id or instance_dir.name})
    return f"Report {mode} to {rel}. File state is now up to date in your context — no need to Read it back."




def _read_meta(instance_dir: Path, session_id: str) -> dict:
    from . import sessions
    return sessions.load_meta(instance_dir, session_id)


def _write_meta(instance_dir: Path, session_id: str, meta: dict) -> None:
    from . import sessions
    sessions.save_meta(instance_dir, session_id, meta)


def _session_record_count(instance_dir: Path, session_id: str) -> int:
    """Count records in a session's jsonl (0 if absent)."""
    p = instance_dir / ".sessions" / f"{session_id}.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text(encoding="utf-8").splitlines() if line.strip())


async def execute_start_sub_session(instance_dir: Path, args: dict[str, Any], session_id: str | None = "", instance_id: str | None = None, user_id: str | None = None) -> str:
    """Director tool: create a child sub-session to delegate a one-shot task.

    Returns the new ``session_id``. ``await_result=true`` tells the director to
    end its current round and wait to be woken when the child finishes. Records
    the calling session as ``parent_session_id`` so EndSession can notify it.
    """
    task = args.get("task", "")
    enabled = args.get("enabled_tools")
    await_result = bool(args.get("await_result", False))
    parent = session_id or ""

    from .reasoning import validate_effort
    effort = validate_effort(args.get("reasoning_effort"))

    child = f"session-{uuid.uuid4().hex[:4]}"
    tools_list = sorted(set(enabled)) if enabled else sorted(SUB_SESSION_BASE_TOOLS)
    meta = {
        "enabled_tools": tools_list,
        "parent_session_id": parent or None,
        "await_result": await_result,
        "created_from": "director",
    }
    if effort:
        meta["reasoning_effort"] = effort
    _write_meta(instance_dir, child, meta)
    # 立即产出空 JSONL，使会话在 list_sessions 中立即可见
    from .sessions import resolve_session_path
    resolve_session_path(instance_dir, child).touch(exist_ok=True)

    # Enqueue the task into the child's session loop. The loop persists it to
    # jsonl and starts processing immediately.
    from .session_loop import SessionLoop
    from .session_tracker import task_tracker
    if task:
        loop = SessionLoop.get_or_create(instance_dir, child, instance_id=instance_id, user_id=user_id)
        loop.enqueue(task)

    state.broadcast("session_created", {
        "instance_id": instance_id or instance_dir.name,
        "session_id": child,
        "parent_session_id": parent or None,
        "parent_await_result": await_result,
        "running": task_tracker.running_sessions(instance_dir.name),
    })

    if await_result:
        return (f"Created sub-session {child} and delegated task. AWAITING_RESULT — stop this round now and do not issue further "
                f"tools; the backend will wake you with a new message when sub-session {child} finishes (it calls EndSession). "
                f"Then Read its temp/ report to close this work.")
    return (f"Created sub-session {child}. Task delegated ('{task[:80]}…' if long). It runs in background with a fresh context; "
            f"it will write its conclusion via Report to temp/ and call EndSession when done. You may continue your current work "
            f"or Read its temp/ report later. Session list: you can check it at any time.")


async def execute_send_to_sub_session(instance_dir: Path, args: dict[str, Any], session_id: str | None = "", instance_id: str | None = None, user_id: str | None = None) -> str:
    """Director tool: deliver a follow-up message to a child sub-session (fire-and-forget)."""
    child = args.get("session_id", "")
    message = args.get("message", "")
    if not child or not message:
        return "Error: SendToSubSession requires both session_id and message."

    # Enqueue the message into the child's session loop.
    # The loop will persist it to jsonl and process it.
    from .session_loop import SessionLoop
    loop = SessionLoop.get_or_create(instance_dir, child, instance_id=instance_id, user_id=user_id)
    loop.enqueue(f"[director@{session_id or 'main'}] {message}")

    return f"Message delivered to sub-session {child}. It will process this in its next turn (or when it next runs)."


async def execute_end_session(instance_dir: Path, args: dict[str, Any], session_id: str | None = "", instance_id: str | None = None, user_id: str | None = None) -> str:
    """Declare a sub-session's work complete, then wake its parent in-backend.

    Only signals ``session_done`` (does NOT destroy the session — that's the caller's
    decision). If this child was created by a director session, the backend itself
    appends a wake-up user message to the parent and kicks the parent to finish in
    the background — reliable, frontend-independent, works for both await modes.
    """
    sid = session_id or ""
    meta = _read_meta(instance_dir, sid)
    parent = meta.get("parent_session_id")

    from .session_tracker import task_tracker
    from .session_loop import SessionLoop
    from .sessions import MAIN_SESSION_ID as _MAIN

    # Wake the parent by enqueuing an auto wake message. The parent's loop will
    # persist it and start processing.
    if parent:
        loop = SessionLoop.get_or_create(instance_dir, parent, instance_id=instance_id, user_id=user_id)
        loop.enqueue(f"[auto] 你委派的子会话 {sid} 已完成（它调用了 EndSession）。请读取它落盘到 temp/ 的结论并收尾本轮。")

    payload = {
        "instance_id": instance_id or instance_dir.name,
        "session_id": sid,
        "parent_session_id": parent or None,
        "parent_await_result": bool(meta.get("await_result")),
        # Authoritative per-session running map at completion time.
        "running": task_tracker.running_sessions(instance_dir.name),
    }
    state.broadcast("session_done", payload)

    # Force-interrupt THIS session's own running tool loop (mirrors the frontend
    # ESC / stop button) so the model cannot keep streaming tail text / a summary
    # after EndSession — otherwise a leftover message would re-create the JSONL
    # after the caller destroys the session. SessionLoop cancellation delivers
    # end-of-round flush via GeneratorExit; the loop then persists the reason text.
    # Only meaningful for a real child session (EndSession targets a running loop
    # other than the caller's own); guard against an empty / main sid.
    if sid and sid != _MAIN:
        SessionLoop.interrupt_session(instance_dir.name, sid, reason="endsession")

    return f"Session {sid or '(main)'} marked done and parent notified. The session is NOT destroyed — destroy it explicitly if the caller wants to reclaim it."


async def execute_delete_sub_session(instance_dir: Path, args: dict[str, Any], session_id: str | None = "", instance_id: str | None = None, user_id: str | None = None) -> str:
    """Director tool: destroy a sub-session (delete its JSONL + meta) and broadcast session_destroyed.

    ``abort=true`` (default) first cancels any in-flight /v1/chat for that session.
    Works for child sessions; the main session is off-limits (use /clear instead).
    """
    from .sessions import MAIN_SESSION_ID, destroy as _destroy

    target = args.get("session_id", "")
    if not target:
        return "Error: DeleteSubSession requires a session_id."
    if target == MAIN_SESSION_ID:
        return f"Error: DeleteSubSession only destroys sub-sessions. Wipe the main session with /clear (or the session API) instead of {target}."

    if args.get("abort", True):
        from .session_tracker import abort_session_requests
        await abort_session_requests(instance_dir.name, target)

    _destroy(instance_dir, target)
    state.broadcast("session_destroyed", {"instance_id": instance_id or instance_dir.name, "session_id": target})
    return f"Sub-session {target} destroyed and reclaimed."


# ---------------------------------------------------------------------------
# PruneContext — proactive context pruning (see ignored/context-compression-design.md)
# ---------------------------------------------------------------------------
#
# Single tool, two phases: `dry_run` (default) estimates and lists candidates at
# zero cost; `dry_run=false` + explicit ids applies them in one batch (one prompt-
# cache invalidation). Replaces stale tool content in the session JSONL with a
# one-line stub — the "action ledger" structure survives, the detail is unloaded
# and can be re-read from disk when needed.

# A-class: read-only tool results, regenerable by re-running the tool / re-reading.
_PRUNE_RESULT_TOOLS = {
    "Read", "SkillRead", "Grep", "Glob", "GitDiff", "GitLog", "GitStatus",
    "GetRuntimeVars", "CheckPackageRefs",
}

# B-class: write tools whose large INPUT fields are a redundant copy of disk state
# (file-as-state — the written content lives on disk, so the arg copy is pure
# duplication). Only these fields are stubbed; path/slice/offset/limit stay.
_PRUNE_ARG_FIELDS = {
    "Write": ("content",),
    "Edit": ("old_string", "new_string"),
    "WriteLine": ("new_content",),
}

# Content below this size (chars) is not listed — keeps candidates meaningful, and
# makes pruning idempotent (the stub is far below it, so a pruned block never
# reappears as a candidate).
_PRUNE_MIN_CHARS = 400


def _prune_digest(args: dict) -> str:
    """A short, single-line hint of what a pruned tool call was about."""
    try:
        s = json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(args)
    s = " ".join(s.split())
    return s if len(s) <= 80 else s[:80] + "…"


def _prune_scan(instance_dir: Path, sid: str) -> list[dict]:
    """List prunable blocks that sit before the last user record.

    Everything after the last real user turn is the current round's work, so it is
    excluded — only genuinely stale content is offered.
    """
    from . import sessions as _sessions

    records, _ = _sessions.load_records(instance_dir, session_id=sid)
    cut = len(records)
    for i in range(len(records) - 1, -1, -1):
        if records[i].get("role") == "user":
            cut = i
            break

    out: list[dict] = []
    for rec in records[:cut]:
        if rec.get("role") != "assistant":
            continue
        order = rec.get("order", 0)
        for bi, b in enumerate(rec.get("blocks") or []):
            if not isinstance(b, dict) or b.get("type") != "tool_call":
                continue
            name = b.get("name", "")
            if name in _PRUNE_RESULT_TOOLS:
                r = b.get("result")
                if isinstance(r, str) and len(r) >= _PRUNE_MIN_CHARS:
                    out.append({"id": f"{order}:{bi}", "order": order, "index": bi,
                                "name": name, "kind": "result", "chars": len(r)})
            elif name in _PRUNE_ARG_FIELDS:
                a = b.get("args") or {}
                total = sum(
                    len(v) for f in _PRUNE_ARG_FIELDS[name]
                    if isinstance(v := a.get(f), str)
                )
                if total >= _PRUNE_MIN_CHARS:
                    out.append({"id": f"{order}:{bi}", "order": order, "index": bi,
                                "name": name, "kind": "args", "chars": total})
    return out


def _prune_transform(targets: dict[int, dict[int, str]], stats: dict[str, int]):
    """Build the `rewrite_lines` transform for `{record_order: {block_index: kind}}`.

    ``stats`` accumulates the real work done — ``blocks`` (content fields stubbed)
    and ``chars`` (net chars removed) — so the tool reports what actually changed
    rather than what was merely requested.
    """
    def _stub_args(b: dict) -> None:
        a = b.get("args")
        if not isinstance(a, dict):
            return
        path = a.get("path") or a.get("slice") or "?"
        marker = f"[已压缩：内容见磁盘 {path}，以文件为准]"
        for f in _PRUNE_ARG_FIELDS.get(b.get("name", ""), ()):
            if isinstance(a.get(f), str) and a[f]:
                stats["chars"] += len(a[f]) - len(marker)
                stats["blocks"] += 1
                a[f] = marker

    def _transform(rec: dict) -> bool:
        wanted = targets.get(rec.get("order"))
        if not wanted or rec.get("role") != "assistant":
            return False
        blocks = rec.get("blocks")
        if not isinstance(blocks, list):
            return False
        changed = False
        for bi, kind in wanted.items():
            if bi >= len(blocks) or not isinstance(blocks[bi], dict):
                continue
            b = blocks[bi]
            if b.get("type") != "tool_call":
                continue
            name = b.get("name", "")
            if kind == "result":
                r = b.get("result")
                if isinstance(r, str) and len(r) >= _PRUNE_MIN_CHARS:
                    stub = (
                        f"[已卸载 {name}] {_prune_digest(b.get('args') or {})} — "
                        f"原 {len(r):,} 字符，需要时重新调用该工具。"
                    )
                    stats["chars"] += len(r) - len(stub)
                    stats["blocks"] += 1
                    b["result"] = stub
                    changed = True
            elif kind == "args":
                before = stats["blocks"]
                _stub_args(b)
                changed = changed or stats["blocks"] > before
        return changed
    return _transform


async def execute_prune_context(instance_dir: Path, args: dict[str, Any], session_id: str | None = "", instance_id: str | None = None, user_id: str | None = None) -> str:
    """PruneContext executor — estimate (dry_run, default) or apply an explicit prune."""
    from . import sessions as _sessions

    sid = session_id or _sessions.MAIN_SESSION_ID
    candidates = _prune_scan(instance_dir, sid)

    # Anything other than an explicit boolean False estimates only — a malformed
    # arg can never mutate history.
    if bool(args.get("dry_run", True)):
        if not candidates:
            return "当前没有可压缩的旧工具内容。"
        total = sum(c["chars"] for c in candidates)
        lines = [f"可压缩候选 {len(candidates)} 条，合计可省约 {total:,} 字符（≈ {total // 3:,} tokens）。"]
        for c in candidates:
            tag = "（入参）" if c["kind"] == "args" else ""
            lines.append(f"  {c['id']}  {c['name']}  {c['chars']:,} 字符{tag}")
        ids_txt = ", ".join(f'"{c["id"]}"' for c in candidates)
        lines.append(f"\n执行：PruneContext(dry_run: false, ids: [{ids_txt}]) —— 只列要卸的 id 即可。")
        return "\n".join(lines)

    ids = args.get("ids")
    if not isinstance(ids, list) or not ids:
        return "Error: dry_run=false 需要显式传入 ids（取自上一步的候选列表）。可先用 dry_run:true 查看候选。"

    by_id = {c["id"]: c for c in candidates}
    targets: dict[int, dict[int, str]] = {}
    unknown: list[str] = []
    for raw in ids:
        cid = str(raw)
        c = by_id.get(cid)
        if c is None:
            unknown.append(cid)
            continue
        targets.setdefault(c["order"], {})[c["index"]] = c["kind"]
    if not targets:
        return f"Error: ids 中没有有效候选（无效：{', '.join(unknown)}）。可先用 dry_run:true 重新查看候选。"

    stats = {"blocks": 0, "chars": 0}
    _sessions.rewrite_lines(instance_dir, sid, _prune_transform(targets, stats))
    if stats["blocks"] == 0:
        return "没有实际压缩任何内容（可能已被压缩过，或已不满足阈值）。可先用 dry_run:true 重新查看候选。"

    freed = max(0, stats["chars"])
    msg = (f"已压缩 {stats['blocks']} 处，释放约 {freed:,} 字符（≈ {freed // 3:,} tokens）。"
           "改动的效果在下一次上下文重建时生效。")
    if unknown:
        msg += f" 无效 id（已跳过）：{', '.join(unknown)}。"
    return msg


async def execute_edit_line(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Edit a file by replacing a range of lines. Use after Read to confirm line numbers.

    Set resolve_placeholders=true to resolve {{path}} placeholders in new_content.
    Default is false.
    """
    path = args["path"]
    start_line = int(args["start_line"])
    end_line = int(args.get("end_line", start_line))
    new_content = args["new_content"]

    if start_line < 1:
        return f"Error: start_line must be >= 1, got {start_line}"
    if end_line < start_line:
        return f"Error: end_line ({end_line}) must be >= start_line ({start_line})"

    full = _validate_path(instance_dir, path)
    if not full.exists():
        return f"Error: File not found: {path}"

    lines = full.read_text(encoding="utf-8").splitlines(keepends=True)
    total = len(lines)

    if start_line > total:
        return f"Error: start_line ({start_line}) exceeds file length ({total} lines)"
    if end_line > total:
        return f"Error: end_line ({end_line}) exceeds file length ({total} lines)"

    # Decode literal \n and \r\n in JSON string to real newlines.
    # LLMs pass these as literal backslash-n in JSON tool-call args.
    decoded = new_content.replace("\\r\\n", "\n").replace("\\n", "\n")

    # Resolve {{path}} placeholders (only when explicitly requested).
    # File slicing does NOT resolve variables (copy/move primitive).
    if args.get("resolve_placeholders", False) and "{{" in decoded:
        try:
            decoded = resolve_placeholders(decoded, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"

    # If replacing a single line and the new content doesn't end with a newline,
    # append the original line ending so the next line doesn't merge into this one.
    if start_line == end_line and not decoded.endswith("\n") and total > start_line:
        decoded += lines[start_line - 1][-1] if lines[start_line - 1][-1] in ("\n", "\r") else "\n"

    # Replace the range [start_line-1, end_line) with decoded content.
    before = "".join(lines[: start_line - 1])
    after = "".join(lines[end_line:])
    new_file = before + decoded + after

    full.write_text(new_file, encoding="utf-8")
    state.broadcast("file_changed", {"path": path, "tool": "WriteLine", "type": "modified", "instance_id": instance_id or instance_dir.name})
    _maybe_broadcast_vars_changed(instance_dir, full, "WriteLine", instance_id)
    return f"Successfully replaced lines {start_line}–{end_line} in {path}. File state is now up to date in your context — no need to Read it back."


async def execute_glob(instance_dir: Path, args: dict[str, Any]) -> str:
    """Glob for files matching a pattern within the instance directory."""
    pattern = args["pattern"]

    matched = list(instance_dir.glob(pattern))
    matched = [str(p.relative_to(instance_dir)).replace("\\", "/") for p in matched]
    matched.sort()

    if not matched:
        return f"No files matched pattern: {pattern}"

    result = "\n".join(matched)
    info = f"({len(matched)} files)"
    return f"{info}\n{result}"


async def execute_grep(instance_dir: Path, args: dict[str, Any]) -> str:
    """Search file contents with a regex pattern within the instance directory.

    Only searches text files (extensions: .md, .yaml, .yml, .json, .txt, .py, .js, .ts, .css, .html).
    Args['path'] (optional): restrict search to a single file or directory (relative to instance root).
    Returns matching file paths with line counts, sorted by match count descending.
    """
    pattern = args["pattern"]
    text_extensions = {".md", ".yaml", ".yml", ".json", ".txt", ".py", ".js", ".ts", ".css", ".html"}

    # Normalize once so relative_to() against .resolve()'d wrapper paths never
    # trips mismatched forms (e.g. Windows 8.3 short names vs long names).
    instance_dir = instance_dir.resolve()

    try:
        regex = _re.compile(pattern)
    except _re.error as e:
        return f"Error: invalid regex pattern '{pattern}': {e}"

    # Resolve the optional scope: a single file or a directory under the instance root.
    scope = args.get("path")
    if scope:
        base = Path(instance_dir / str(scope))
        base = base.resolve()
        instance_root = instance_dir.resolve()
        if not (base == instance_root or instance_root in base.parents):
            return f"Error: path '{scope}' is outside the instance directory, refusing to search"
        if base.is_file():
            wrapper: list[Path] = [base]
        elif base.is_dir():
            wrapper = [p for p in base.rglob("*")]
        else:
            return f"Error: path '{scope}' does not exist"
    else:
        wrapper = [p for p in instance_dir.rglob("*")]

    # result: (path, line_numbers_sorted, total_match_count)
    results: list[tuple[str, list[int], int]] = []
    for filepath in wrapper:
        if not filepath.is_file():
            continue
        if filepath.suffix not in text_extensions:
            continue
        rel = str(filepath.relative_to(instance_dir)).replace("\\", "/")
        try:
            lines = filepath.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        hit_lines: list[int] = []
        count = 0
        for lineno, text in enumerate(lines, start=1):
            n = len(regex.findall(text))
            if n > 0:
                hit_lines.append(lineno)
                count += n
        if count > 0:
            results.append((rel, hit_lines, count))

    if not results:
        return f"No files matched pattern: {pattern}"

    results.sort(key=lambda x: (-x[2], x[0]))
    lines = [f"({len(results)} files)"]
    for path, hit_lines, count in results:
        lineno_str = ", ".join(str(n) for n in hit_lines)
        suffix = f" ({count} matches)" if count > 1 else ""
        lines.append(f"{path} : {lineno_str}{suffix}")
    return "\n".join(lines)


async def execute_check_package_refs(instance_dir: Path, args: dict[str, Any]) -> str:
    """Scan the instance tree for broken {{@包名/路径}} references.

    A package reference resolves against <instance>/packages/<包名>/<路径>. We
    report every `{{@...}}` whose package is missing or path no longer exists,
    as 文件 : 行号 + 原因 — so the director can learn where a package slice
    broke before a Generate/assemble hits it.

    Scope: whole instance tree, EXCLUDING packages/ itself (no chain deps:
    an instance references packages, packages don't reference each other, so
    包内 {{@...}} is teaching copy about how to reference — nothing to check)
    and internal/metadata dirs (.git, building, sessions, disabled/).
    """
    from .placeholder import check_package_ref

    instance_dir = instance_dir.resolve()
    text_extensions = {".md", ".yaml", ".yml", ".json", ".txt", ".py", ".js", ".ts", ".css", ".html"}
    exclude_rel_dirs = {
        "packages",
        ".git",
        "building",
        "sessions",
        ".sessions",
        "runtime/sandbox/disabled",
    }
    slice_re = _re.compile(r"\{\{@([^}]+?)\}\}")

    # result: (rel, line_no, pkg_ref_raw, reason)
    broken: list[tuple[str, int, str, str]] = []
    seen_files = 0
    for p in sorted(instance_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix not in text_extensions:
            continue
        rel = str(p.relative_to(instance_dir)).replace("\\", "/")
        # skip excluded dirs by path prefix
        if any(rel == d or rel.startswith(d + "/") for d in exclude_rel_dirs):
            continue
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for lineno, text in enumerate(lines, start=1):
            for m in slice_re.finditer(text):
                raw = m.group(1).strip()
                ok, reason = check_package_ref(instance_dir, raw)
                if not ok:
                    broken.append((rel, lineno, raw, reason))
                else:
                    seen_files += 1

    if not broken:
        return "所有 {{@包名/路径}} 引用均有效" + (f"（检查了 {seen_files} 处引用）" if seen_files else "")

    lines = [f"({len(broken)} broken package refs)"]
    # 归并同一文件的多个行号
    from collections import OrderedDict
    per_file: OrderedDict[str, list[tuple[int, str, str]]] = OrderedDict()
    for rel, lineno, raw, reason in broken:
        per_file.setdefault(rel, []).append((lineno, raw, reason))
    for rel, hits in per_file.items():
        for lineno, raw, reason in hits:
            lines.append(f"{rel} : {lineno}  [{reason}]  ({{{{@{raw}}}}})")
    return "\n".join(lines)


# Placed before execute_generate. Content extraction + placeholder scan helpers
# shared by the payload .meta dump.
_PH_RESIDUE_RE = _re.compile(r"\{\{[^}]*\}\}|\$\{[^}]*\}")


def _msg_plaintext(msg: dict) -> str:
    """Flatten a message's content (str or list-of-parts) into a single string."""
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(
            p.get("text") if isinstance(p, dict) and isinstance(p.get("text"), str) else ""
            for p in c
        )
    return ""


def _placeholder_context(text: str, start: int, end: int, width: int = 40) -> str:
    """Return the residue hit's neighbours (width chars each side) as a preview line."""
    lo = max(0, start - width)
    hi = min(len(text), end + width)
    left = text[lo:start]
    right = text[end:hi]
    return (("…" if lo > 0 else "") + left + text[start:end] + right + ("…" if hi < len(text) else "")).replace("\n", "␤")


def _dump_payload_meta(messages: list[dict], total_chars: int) -> str:
    """Build a plain-text .meta report over the RESOLVED payload messages.

    Report format (per-message + rollups), keeping the Generate return short so
    the director only Read the .meta file when it wants the full table:

      - Per-message char count + share, and every leftover placeholder
        (${...} / {{...}}) with a short context window. Resolved payloads are
        meant for the prose LLM and must contain NO placeholders — a leftover is
        a real defect (typo'd / unset variable, broken slice), reported verbatim
        without exemption (teaching text should live in ${@note}, which is
        stripped before this point).
      - Total chars + a rough token estimate (中文≈1char/token, 英文≈4char/token;
        labelled approximate — the exact count only the API knows).
    """
    lines: list[str] = []
    per_role: dict[str, int] = {}
    residues: list[str] = []
    for i, msg in enumerate(messages):
        text = _msg_plaintext(msg)
        role = str(msg.get("role", "?"))
        per_role[role] = per_role.get(role, 0) + len(text)
        share = (len(text) / total_chars * 100) if total_chars else 0.0
        lines.append(f"[msg {i} | {role}] chars={len(text):,} ({share:.1f}%)")
        if not text:
            continue
        hits = []
        for m in _PH_RESIDUE_RE.finditer(text):
            hits.append((m.group(0), m.start(), m.end()))
        if not hits:
            lines.append("  残留: 0")
        else:
            residues.append(f"[msg {i} | {role}]")
            for token, s, e in hits:
                ctx = _placeholder_context(text, s, e).strip()
                residues.append(f"  {token}")
                residues.append(f"      上下文: {ctx}")
    lines.append("")
    role_summary = ", ".join(f"{r}:{c}" for r, c in per_role.items())
    est = total_chars  # 中文近似 1char/token; 英文部分实际偏高
    lines.append(f"messages: {len(messages)}  ({role_summary})")
    lines.append(f"total chars: {total_chars:,}    估算 token: ~{est:,}(粗略:中文≈1字符/token,英文≈4字符/token;精确以 API 为准)")
    if residues:
        lines.append("")
        lines.append("残留占位符(共 %d 处,payload 本不应含占位符,多为未定义变量/断链切片):" % sum(1 for r in residues if not r.startswith("[")))
        lines.extend(residues)
    return "\n".join(lines)


async def execute_generate(
    instance_dir: Path,
    args: dict[str, Any],
    user_id: str | None = None,
    run_uuid: str | None = None,
    instance_id: str | None = None,
) -> str:
    """Generate tool — reads YAML config, resolves placeholders, calls writer LLM, writes result to file.

    1. Read and parse YAML source_file into messages array
    2. Resolve {{path}} placeholders in messages
    3. Optionally dry-run: if dump_payload_path set, dump resolved payload JSON and return WITHOUT calling the model
    4. Call the writer slot LLM (streaming)
    5. Stream text in memory + forward each text chunk as an incremental delta
       via generate_progress (no throttling), do NOT write file until stream ends
    6. On end: write the accumulated text + broadcast file_changed once; return summary
    """
    import json

    source_file_str = args.get("source_file", "")
    output_path_str = args.get("path", "")
    dump_payload_str = args.get("dump_payload_path", "")
    overwrite = bool(args.get("overwrite", False))

    from .reasoning import validate_effort
    effort = validate_effort(args.get("reasoning_effort"))

    if not source_file_str:
        return "Error: 'source_file' is required — specify the YAML config file path (e.g. temp/generate-config-12-1.yaml)"
    if not output_path_str:
        return "Error: 'path' is required — specify the output file path (e.g. temp/draft-12-1.md)"

    # Step 1: Read and parse YAML source_file
    try:
        source_full = _validate_path(instance_dir, source_file_str)
    except ValueError as e:
        return f"Error: {e}"

    if not source_full.exists():
        return f"Error: source_file not found: {source_file_str}"

    try:
        raw_yaml = source_full.read_text(encoding="utf-8")
        messages = yaml.safe_load(raw_yaml)
    except yaml.YAMLError as e:
        return f"Error: YAML 解析失败: {e}"
    except Exception as e:
        return f"Error: 读取 source_file 失败: {e}"

    if not isinstance(messages, list):
        return "Error: YAML 配置文件必须是列表格式，每项包含 role 和 content"
    for i, msg in enumerate(messages):
        if not isinstance(msg, dict):
            return f"Error: 配置第 {i+1} 项必须是字典，包含 role 和 content"
        if "role" not in msg or "content" not in msg:
            return f"Error: 配置第 {i+1} 项缺少 role 或 content 字段"

    # Validate output path
    try:
        output_full = _validate_path(instance_dir, output_path_str)
    except ValueError as e:
        return f"Error: {e}"

    output_full.parent.mkdir(parents=True, exist_ok=True)

    # Overwrite safety: by default refuse to clobber an existing file, WITHOUT
    # calling the writer model. When overwrite=true, delete the old file first
    # so the streaming model can't silently overwrite fresh content before it
    # materializes — the replace happens up-front (old content is recoverable
    # via git), and the accumulated text is what lands at stream end.
    if output_full.exists():
        if not overwrite:
            return (
                f"Error: 目标文件已存在: {output_path_str}\n"
                f"拒绝覆盖（Generate 默认只读保护）。\n"
                f"请选择一个新文件路径，或确认覆盖后在参数传入 overwrite=true 重试。"
            )
        try:
            output_full.unlink()
        except OSError as e:
            return f"Error: 删除旧文件失败，无法覆盖: {output_path_str}: {e}"

    # Step 2: Resolve ${variables} + {{path}} file slices before sending to the writer LLM.
    from .routes.settings import _user_max_parse_depth
    parse_depth = await _user_max_parse_depth(user_id)
    resolved = _resolve_messages_vars(messages, instance_dir, max_depth=parse_depth)

    # Step 4: Resolve writer slot LLM client
    if not user_id:
        return (
            "Error: 无法获取用户身份，无法调用正文模型。\n"
            "请确保已登录后再试。"
        )

    try:
        from .database.llm_slots import get_slot_binding
        from .database.llm_models import get_model as get_llm_model
        from .database.llm_providers import get_provider as get_llm_provider
        from .database.model_profiles import get_profile as get_model_profile

        binding = await get_slot_binding(user_id, "writer")
        if not binding or not binding.get("model_id"):
            return (
                "Error: 正文模型（writer slot）未绑定。\n"
                "请在 LLM 槽位设置中将 writer slot 绑定到一个可用模型，然后重试。"
            )

        model = await get_llm_model(binding["model_id"])
        if not model:
            return "Error: 绑定的模型不存在，请检查 writer slot 配置。"

        provider = await get_llm_provider(model["provider_id"])
        if not provider:
            return "Error: 模型的 provider 不存在，请检查 writer slot 配置。"

        profile = None
        # Use slot-level profile_id (not model-level)
        slot_profile_id = binding.get("profile_id")
        if slot_profile_id:
            profile = await get_model_profile(slot_profile_id)

        writer_client = LLMClient(LLMConfig(
            url=provider["api_url"],
            key=provider["api_key"],
            model=model["model_name"],
            api_style=provider["api_format"],
            max_tokens=profile["max_tokens"] if profile else 50000,
            temperature=profile["temperature"] if profile else 0.7,
            top_p=profile.get("top_p") if profile else None,
            frequency_penalty=profile.get("frequency_penalty") if profile else None,
            presence_penalty=profile.get("presence_penalty") if profile else None,
        ))
    except Exception as e:
        return f"Error: 解析 writer slot 配置失败: {e}"

    # Step 3: dry-run — dump the full resolved request context and return WITHOUT
    # calling the writer model. Placed AFTER client resolution so
    # url/model/api_style/effort-mapping are known. API key is masked (only the
    # last 4 chars survive) so the payload is safe to inspect but traceable to a
    # specific endpoint/key. This lets a dry run verify precisely what a real
    # call would send.
    if dump_payload_str:
        from .reasoning import effort_kwargs

        def _mask_key(key: str | None) -> str | None:
            if not key:
                return key
            return "*" * max(len(key) - 4, 0) + key[-4:]

        try:
            payload_full = _validate_path(instance_dir, dump_payload_str)
            payload_full.parent.mkdir(parents=True, exist_ok=True)
            payload_obj: dict = {
                "model": writer_client.config.model,
                "api_style": writer_client.api_style,
                "url": writer_client.config.url,
                "api_key": _mask_key(writer_client.config.key),
                "max_tokens": writer_client.config.max_tokens,
                "temperature": writer_client.config.temperature,
                "top_p": writer_client.config.top_p,
                "frequency_penalty": writer_client.config.frequency_penalty,
                "presence_penalty": writer_client.config.presence_penalty,
                "reasoning_effort": effort,
                "api_fields": effort_kwargs(writer_client.api_style, effort),
                "messages": resolved,
            }
            payload_full.write_text(
                json.dumps(payload_obj, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            state.broadcast(
                "file_changed",
                {"path": dump_payload_str, "tool": "Generate.dump", "type": "created", "instance_id": instance_id or instance_dir.name},
            )
            # 旁路 .meta:残留占位符表(带上下文)+ 字符统计 + 粗略 token 估算。
            # 写 payload 同根文件(纯文本,便于 Read),不塞进返回串刷屏。
            try:
                total_chars = sum(len(_msg_plaintext(m)) for m in resolved)
                meta_full = Path(str(payload_full) + ".meta")
                meta_full.write_text(_dump_payload_meta(resolved, total_chars), encoding="utf-8")
                state.broadcast(
                    "file_changed",
                    {"path": dump_payload_str + ".meta", "tool": "Generate.dump.meta", "type": "created", "instance_id": instance_id or instance_dir.name},
                )
                meta_note = f"\npayload meta(残留占位符 + 字符统计)已写出到 {dump_payload_str}.meta,导演如需查看可 Read"
            except Exception:
                meta_note = "\n(meta 写出失败,仅 payload 已落盘)"
        except ValueError as e:
            return f"Error: dump_payload_path 路径无效: {e}"
        except Exception as e:
            return f"Error: 写入 dump_payload_path 失败: {e}"
        return f"Dry-run: payload 已写出到 {dump_payload_str}，未调用正文模型{meta_note}"

    # Step 5/6: Call writer LLM — stream and forward each text chunk to the
    # frontend as an incremental delta via generate_progress (no throttling), but
    # do NOT write the file or broadcast file_changed until the stream ends
    # (completed / interrupted / errored). This keeps the file system clean during
    # generation and avoids the file_changed → git/refresh noise per frame (档1).
    #
    # The delta is a pure typewriter effect for the frontend: within a single SSE
    # connection the server emits chunks in order the LLM produced them, so the
    # browser appends in arrival order and the result equals the full text. Any
    # drift from a lost tail is reconciled by the single `done` broadcast, which
    # carries the full accumulated_text, and by the file_changed→read-file path.
    buffered = ""            # 已累积正文（仅 text chunk，不含 reasoning/thinking）
    got_text = False         # 是否收到过任一正文 chunk（gate：无正文则不产出文件）

    _gen_kwargs = {}
    if effort:
        _gen_kwargs["reasoning_effort"] = effort
    stream = writer_client.send_message_stream(resolved, **_gen_kwargs)

    def _progress(done: bool, delta: str = "") -> None:
        # done=false: forward just this chunk's delta (append on the frontend).
        # done=true: carry the full accumulated_text so the frontend can reconcile
        # any gap from a lost tail and switch to the persisted file.
        state.broadcast(
            "generate_progress",
            {
                "run_uuid": run_uuid,
                "path": output_path_str,
                "instance_id": instance_id or instance_dir.name,
                "delta": delta if not done else "",
                "accumulated_len": len(buffered),
                "accumulated_text": buffered if done else "",
                "done": done,
            },
        )

    async def _finalize_write() -> None:
        """Interrupt/error/complete path: write whatever has accumulated, broadcast
        file_changed once. Mid-stream there was no file, so this is the sole flush."""
        existed = output_full.exists()
        try:
            output_full.write_text(buffered, encoding="utf-8")
        except Exception as e:
            raise RuntimeError(f"写入输出文件失败: {e}") from e
        state.broadcast(
            "file_changed",
            {"path": output_path_str, "tool": "Generate", "type": "modified" if existed else "created", "instance_id": instance_id or instance_dir.name},
        )

    try:
        async for chunk in stream:
            if chunk.get("type") == "text" and chunk.get("text"):
                if not got_text:
                    got_text = True
                _progress(done=False, delta=chunk["text"])
                buffered += chunk["text"]
    except asyncio.CancelledError:
        # 任务被取消（沙盒 runTool 打断 / 导演 ESC）——已生成正文也要落盘
        # 半成品供续写，与"流中失败/中断"语义一致；写盘后重新抛 CancelledError
        # 让外层任务干净终止。shield 保证在已取消任务里落盘仍能执行完
        # （_finalize_write 全同步、无 await，实证可靠），随后 raise 不得被省略，
        # 否则任务不会真正进入 cancelled 状态。
        if got_text:
            try:
                await asyncio.shield(_finalize_write())
            except Exception:
                pass
            _progress(done=True)
        raise
    except LLMError as e:
        # 流中途失败：首 chunk 前失败 → 不产出文件；已有正文 → 留下半成品供续写。
        if got_text:
            try:
                await _finalize_write()
            except Exception:
                pass
            _progress(done=True)
            return (
                f"Generate 部分完成（生成中断，已落盘半成品供续写）\n"
                f"  输出文件：{output_path_str}\n"
                f"  已产出字数：{len(buffered)}\n"
                f"  中断原因：{e}"
            )
        return (
            f"Error: 正文模型 API 调用失败（未产生任何输出）: {e}\n"
            f"请检查 writer slot 的 API key 和网络连接后重试。"
        )
    except Exception as e:
        if got_text:
            try:
                await _finalize_write()
            except Exception:
                pass
            _progress(done=True)
            return f"Generate 部分完成（生成中断，已落盘半成品）\n  输出文件：{output_path_str}\n  已产出字数：{len(buffered)}\n  意外错误：{e}"
        return f"Error: 调用正文模型时发生意外错误（未产生任何输出）: {e}"

    # 流正常结束 — 若从未收到正文，不产出文件报错；否则最终落盘 + file_changed
    if not got_text:
        return "Error: 正文模型返回为空（未生成任何正文）"

    await _finalize_write()
    _progress(done=True)

    # Build summary
    generated_text = buffered
    char_count = len(generated_text)
    # Rough word count for Chinese text (characters ≈ words)
    word_count = char_count
    preview = generated_text.strip()[:50]

    return (
        f"Generate 完成\n"
        f"  输出文件：{output_path_str}\n"
        f"  字数：{word_count}\n"
        f"  前 50 字预览：「{preview}」"
    )


async def execute_output(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Output — 向玩家呈现一条消息（追加到 runtime/dm-output.jsonl 的当前批次）。"""
    from .dm_output import append_message, DM_OUTPUT_REL, RESERVED_CHARA_USER

    chara = args.get("chara")
    content = args.get("content")
    kind = args.get("kind")
    if not isinstance(chara, str) or not chara.strip():
        return "Error: 'chara' 必填 —— 发言者（\"user\" 为玩家保留值，勿用）"
    if chara.strip() == RESERVED_CHARA_USER:
        return (
            "Error: 'chara' 不能用保留值 'user' —— 玩家发言由系统自动写入，"
            "不要重复呈现玩家的话"
        )
    if not isinstance(content, str) or content == "":
        return "Error: 'content' 必填（要呈现的正文）"
    if kind is not None and not isinstance(kind, str):
        return "Error: 'kind' 必须是字符串（say / narrate / roll / …）"
    # 文件切片 {{path}} —— 与 Write/Edit 同语义：只展开文件引用，不动 ${}（呈现的是
    # 成品正文，变量已在别处展开）。strict：切片配错就报错让 DM 立刻看到并修正，
    # 而不是把裸 {{...}} 原样推给玩家（呈现层是玩家可见面，静默失败比报错更糟）。
    if "{{" in content:
        try:
            content = resolve_placeholders(content, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"
    try:
        rec = append_message(
            instance_dir, chara.strip(), content,
            kind.strip() if isinstance(kind, str) and kind.strip() else None,
        )
    except OSError as e:
        return f"Error: 写入 dm-output 失败: {e}"
    state.broadcast(
        "file_changed",
        {"path": DM_OUTPUT_REL, "tool": "Output", "type": "modified",
         "instance_id": instance_id or instance_dir.name},
    )
    return (
        f"Output 完成\n"
        f"  seq={rec['seq']}  batch={rec['batch']}  chara={rec['chara']}\n"
        f"  （最新批次内可用 OutputEdit 修改）"
    )


async def execute_output_edit(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """OutputEdit — 修改最新批次内某条已呈现的消息。"""
    from .dm_output import edit_message, DM_OUTPUT_REL

    seq = args.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool):
        return "Error: 'seq' 必填，且为整数（目标消息序号）"
    new_string = args.get("new_string")
    if not isinstance(new_string, str):
        return "Error: 'new_string' 必填，且为字符串"
    old_string = args.get("old_string")
    if old_string is not None and not isinstance(old_string, str):
        return "Error: 'old_string' 必须是字符串（留空 = 整体覆写）"
    # 与 Output 一致：new_string 解析文件切片 {{path}}；old_string 是锚点、不解析
    # （要匹配的是落盘后已展开的正文，解析反而对不上）。
    if "{{" in new_string:
        try:
            new_string = resolve_placeholders(new_string, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"

    ok, err = edit_message(instance_dir, seq, old_string, new_string)
    if not ok:
        return f"Error: {err}"
    state.broadcast(
        "file_changed",
        {"path": DM_OUTPUT_REL, "tool": "OutputEdit", "type": "modified",
         "instance_id": instance_id or instance_dir.name},
    )
    return f"OutputEdit 完成：seq={seq}（{'整体覆写' if not old_string else '锚点替换'}）"


async def execute_roll(instance_dir: Path, args: dict[str, Any]) -> str:
    """Roll — 掷骰，返回整数。复用 placeholder._roll（唯一事实源）。"""
    from .placeholder import _roll

    dice = args.get("dice")
    if not isinstance(dice, str) or not dice.strip():
        return "Error: 'dice' 必填 —— 骰子表达式，如 1d6 / 2d6+1 / 4d6k3"
    try:
        result = _roll(dice.strip())
    except ValueError as e:
        return f"Error: 骰子表达式无效: {e}"
    return str(result)


async def execute_skill_read(instance_dir: Path, args: dict[str, Any]) -> str:
    """Read a skill file. Defaults to SKILL.md; `file` reads a sub-file
    (e.g. references/api.md) for skills split into a thin SKILL.md + references.

    System skills take priority over instance skills: built-in skills are the
    on-demand API/convention reference (必需品), so an instance skill of the same
    name must not silently shadow them. Instance skills fill in the rest."""
    name = args["name"]
    rel = (args.get("file") or "SKILL.md").strip() or "SKILL.md"

    # System skills first (built-ins are the required conventions)
    from .director_system import TEMPLATE_DIR
    system_skill_dir = TEMPLATE_DIR / "teahouse_skills" / name
    skill_dir = system_skill_dir

    if not skill_dir.is_dir():
        # Fall back to instance skills
        skill_dir = instance_dir / "skills" / name

    if not skill_dir.is_dir():
        return f"Error: Skill '{name}' 不存在"

    # Resolve the requested file inside the skill dir (path traversal protection).
    skill_root = skill_dir.resolve()
    target = (skill_dir / rel).resolve()
    if not str(target).startswith(str(skill_root)):
        return f"Error: 非法路径: {rel}"

    if not target.is_file():
        available = sorted(
            str(p.relative_to(skill_root)).replace("\\", "/")
            for p in skill_root.rglob("*")
            if p.is_file()
        )
        listing = "\n".join(f"- {f}" for f in available) or "（空）"
        return f"Error: Skill '{name}' 中不存在文件: {rel}\n可用文件：\n{listing}"

    content = target.read_text(encoding="utf-8")
    header = f"## Skill: {name}" if rel == "SKILL.md" else f"## Skill: {name} / {rel}"
    return f"{header}\n\n{content.strip()}"


# ---------------------------------------------------------------------------
# FileOps tool executor
# ---------------------------------------------------------------------------


async def execute_file_ops(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Create directories, move/rename, or delete files and directories."""
    action = args["action"]
    path_str = args["path"]

    full = _validate_path(instance_dir, path_str)

    if action == "mkdir":
        full.mkdir(parents=True, exist_ok=True)
        return f"目录已创建（或已存在）：{path_str}"

    if action == "move":
        destination_str = args.get("destination")
        if not destination_str:
            return "Error: move 操作需要 destination 参数"
        dest = _validate_path(instance_dir, destination_str)

        if not full.exists():
            return f"Error: 源路径不存在：{path_str}"

        # If destination exists, remove it first (覆盖)
        if dest.exists():
            if dest.is_dir() and any(dest.iterdir()):
                return (
                    f"Error: 目标目录 '{destination_str}' 已存在且非空，无法覆盖。\n"
                    f"请先使用 FileOps delete 删除目标目录，或选择其他目标路径。"
                )
            # Remove existing file or empty directory
            if dest.is_dir():
                dest.rmdir()
            else:
                dest.unlink()

        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(full), str(dest))
        state.broadcast("file_changed", {"path": destination_str, "tool": "FileOps", "type": "moved", "prev_path": path_str, "action": "move", "instance_id": instance_id or instance_dir.name})
        _maybe_broadcast_vars_changed(instance_dir, dest, "FileOps", instance_id)
        return f"已移动：{path_str} → {destination_str}"

    if action == "delete":
        if not full.exists():
            return f"Error: 路径不存在：{path_str}"

        if full.is_dir():
            shutil.rmtree(full)
        else:
            full.unlink()

        state.broadcast("file_changed", {"path": path_str, "tool": "FileOps", "type": "deleted", "action": "delete", "instance_id": instance_id or instance_dir.name})
        _maybe_broadcast_vars_changed(instance_dir, full, "FileOps", instance_id)
        return f"已删除：{path_str}"

    return f"Error: 未知操作 '{action}'，支持 mkdir / move / delete"


# ---------------------------------------------------------------------------
# Text style rules — runtime/text-style-rules.yaml
# ---------------------------------------------------------------------------

RUNTIME_DIR = "runtime"
TEXT_STYLE_RULES_FILE = "text-style-rules.yaml"


def _text_style_rules_path(instance_dir: Path) -> Path:
    """Get the path to text-style-rules.yaml, ensuring runtime/ exists."""
    runtime_dir = instance_dir / RUNTIME_DIR
    runtime_dir.mkdir(parents=True, exist_ok=True)
    return runtime_dir / TEXT_STYLE_RULES_FILE


def _load_text_style_rules(instance_dir: Path) -> list[dict]:
    """Load text style rules from disk. Returns empty list if file doesn't exist."""
    path = _text_style_rules_path(instance_dir)
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if data is None:
        return []
    return data.get("rules", [])


async def execute_todo_write(instance_dir: Path, args: dict[str, Any]) -> str:
    """Write the full todo list (overwrite). Session-only, no persistence."""
    todos = args["todos"]

    # Validate
    if not isinstance(todos, list):
        return "Error: todos must be an array"

    valid_statuses = {"pending", "in_progress", "completed"}
    in_progress_count = 0
    for i, item in enumerate(todos):
        if not isinstance(item, dict):
            return f"Error: todos[{i}] must be an object"
        if "content" not in item:
            return f"Error: todos[{i}] missing required field 'content'"
        if "status" not in item:
            return f"Error: todos[{i}] missing required field 'status'"
        if "activeForm" not in item:
            return f"Error: todos[{i}] missing required field 'activeForm'"
        if item["status"] not in valid_statuses:
            return f"Error: todos[{i}].status must be one of {valid_statuses}, got '{item['status']}'"
        if item["status"] == "in_progress":
            in_progress_count += 1

    if in_progress_count > 1:
        return (
            f"Error: 同时只能有一个任务为 in_progress，当前有 {in_progress_count} 个。\n"
            f"请将多余的任务改为 pending 后再提交。"
        )

    # Build summary
    counts = {"pending": 0, "in_progress": 0, "completed": 0}
    for item in todos:
        counts[item["status"]] += 1

    return (
        f"任务清单已更新。\n"
        f"  pending: {counts['pending']}\n"
        f"  in_progress: {counts['in_progress']}\n"
        f"  completed: {counts['completed']}"
    )


# ---------------------------------------------------------------------------
# Git tool executors
# ---------------------------------------------------------------------------


async def execute_git_status(instance_dir: Path, args: dict[str, Any]) -> str:
    """Execute git status --porcelain."""
    try:
        entries = git_status_porcelain(instance_dir)
        if not entries:
            return "工作区干净，没有未提交的变更。"
        lines = [f"  {e['status']}  {'(staged)' if e['staged'] else '(unstaged)'}  {e['path']}" for e in entries]
        return "工作区变更：\n" + "\n".join(lines)
    except Exception as e:
        return f"Git status 失败: {e}"


async def execute_git_diff(instance_dir: Path, args: dict[str, Any]) -> str:
    """Execute git diff."""
    path = args.get("path")
    staged = args.get("staged", False)
    try:
        diff_output = git_diff(instance_dir, path, staged=staged)
        if not diff_output.strip():
            if staged:
                return "没有已暂存的差异（index 与 HEAD 相同）。"
            return "没有差异（工作区与 HEAD 相同）。"
        return diff_output
    except Exception as e:
        return f"Git diff 失败: {e}"


async def execute_git_commit(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Execute git add + git commit with semantic type.

    If ``paths`` is provided, only those paths are staged (into this commit),
    leaving other uncommitted changes untouched — this is what lets a background
    summary sub-session commit settings/dyn_settings while the main session is
    mid-floor without their changes bleeding into each other.
    """
    commit_type = args["type"]
    message = args["message"]
    paths = args.get("paths")
    if isinstance(paths, (list, tuple)) and len(paths) > 0:
        paths = [str(p) for p in paths]
    else:
        paths = None

    # Build git message
    if commit_type == "floor":
        number = args.get("number")
        if number is None:
            return "Error: floor 类型需要 number 参数"
        git_message = f"floor-{number}: {message}"
    elif commit_type == "summary":
        start = args.get("start")
        end = args.get("end")
        if start is None or end is None:
            return "Error: summary 类型需要 start 和 end 参数"
        if start == end:
            git_message = f"summary-{start}: {message}"
        else:
            git_message = f"summary-{start}-{end}: {message}"
    else:
        git_message = f"other: {message}"

    try:
        # For summary commits, advance the archive boundary in summary/index.json
        # BEFORE commit so `git add -A` captures it in this commit.
        if commit_type == "summary":
            from .database.workspaces import update_summary_index
            update_summary_index(instance_dir, start, end)
        result = _git_commit(instance_dir, git_message, paths=paths)
        files_str = ", ".join(result["files_changed"]) if result["files_changed"] else "(none)"
        state.broadcast("workspace_changed", {"tool": "GitCommit", "branch": result["branch"], "instance_id": instance_id or instance_dir.name})

        # Update floor_count in DB for floor commits
        if commit_type == "floor" and instance_id:
            from .database.workspaces import update_floor_count
            await update_floor_count(instance_id, number)

        path_scope = ", ".join(paths) if paths else "全部（git add -A）"
        return (
            f"提交成功\n"
            f"  Commit: {result['commit_hash']}\n"
            f"  Branch: {result['branch']}\n"
            f"  范围: {path_scope}\n"
            f"  文件: {files_str}"
        )
    except Exception as e:
        error_msg = str(e)
        if "nothing to commit" in error_msg.lower() or "nothing added" in error_msg.lower():
            return "没有需要提交的变更"
        return f"Git 提交失败: {error_msg}"


async def execute_git_branch(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Execute branch operations: list, create, switch, delete, rename."""
    action = args["action"]
    name = args.get("name")

    try:
        if action == "rename":
            new_name = args.get("new_name")
            if not name or not new_name:
                return "Error: rename 操作需要 name 和 new_name 参数"
            _git_branch_rename(instance_dir, name, new_name)
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "rename", "instance_id": instance_id or instance_dir.name})
            return f"分支 '{name}' 已重命名为 '{new_name}'"

        result = _git_branch(instance_dir, action, name)

        if action == "list":
            branches = result["branches"]
            if not branches:
                return "（没有分支）"
            lines = ["分支列表："]
            for b in branches:
                marker = "* " if b["is_current"] else "  "
                lines.append(f"  {marker}{b['name']}  ({b['commit_hash']})")
            return "\n".join(lines)

        if action == "create":
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "create", "instance_id": instance_id or instance_dir.name})
            return f"分支 '{name}' 创建成功（基于当前 HEAD）"

        if action == "switch":
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "switch", "instance_id": instance_id or instance_dir.name})
            return f"已切换到分支 '{name}'"

        if action == "delete":
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "delete", "instance_id": instance_id or instance_dir.name})
            return f"分支 '{name}' 已删除"

        return f"未知操作: {action}"
    except Exception as e:
        error_msg = str(e)
        if "already exists" in error_msg:
            return f"分支 '{name}' 已存在"
        if "not found" in error_msg or "not a valid branch" in error_msg:
            return f"分支 '{name}' 不存在"
        if "cannot delete branch" in error_msg and "not fully merged" in error_msg:
            return f"无法删除分支 '{name}'：该分支有未合并的提交，请先切换到其他分支再重试"
        return f"Git 分支操作失败: {error_msg}"


async def execute_git_checkout(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Checkout a historical commit: create temp branch at the hash and switch to it.

    Non-destructive — the original branch is untouched. The director can explore
    on the temp branch and switch back any time with GitBranch switch.
    """
    target_hash = args["target_hash"]

    # Validate: resolve the hash
    try:
        full_hash = _git_rev_parse(instance_dir, target_hash)
    except Exception:
        return f"错误：无法解析 commit hash '{target_hash}'。请检查 hash 是否正确，可先使用 GitLog 查看可用提交。"

    # Generate temp branch name matching frontend pattern: temp-{ms_base36}
    temp_name = f"temp-{_to_base36(int(time.time() * 1000))}"

    # Step 1: Create temp branch at the target commit
    try:
        _git_branch_create(instance_dir, temp_name, target_hash)
    except Exception as e:
        return f"错误：无法在 {target_hash[:7]} 处创建临时分支：{e}"

    # Step 2: Switch to the temp branch (with cleanup of orphaned temp branches)
    try:
        _git_branch_switch_with_cleanup(instance_dir, temp_name)
    except Exception as e:
        return f"错误：无法切换到临时分支 '{temp_name}'：{e}"

    # Step 3: Confirm current HEAD
    current_hash = _git_rev_parse(instance_dir, "HEAD")

    state.broadcast("workspace_changed", {"tool": "GitCheckout", "branch": temp_name, "instance_id": instance_id or instance_dir.name})

    return (
        f"已回退到历史提交。\n"
        f"  目标提交: {full_hash[:7]}\n"
        f"  当前分支: {temp_name}（临时分支）\n"
        f"  当前 HEAD: {current_hash[:7]}\n"
        f"\n"
        f"【重要提示】\n"
        f"  · 当前位于临时分支，原分支未被修改\n"
        f"  · 可在此查看/实验，修改会自动保存在此临时分支上\n"
        f"  · 回到原分支：使用 GitBranch switch 操作\n"
        f"  · 保留实验成果：在临时分支上提交即可"
    )


async def execute_git_log(instance_dir: Path, args: dict[str, Any]) -> str:
    """View git commit history."""
    limit = args.get("limit", 10)
    try:
        entries = _git_log(instance_dir, limit)
        if not entries:
            return "（没有提交记录）"
        lines = [f"最近 {len(entries)} 条提交："]
        for e in entries:
            lines.append(f"  {e['hash']}  {e['date'][:10]}  {e['message']}")
        return "\n".join(lines)
    except Exception as e:
        return f"查看提交历史失败: {e}"


async def execute_wait(instance_dir: Path, args: dict[str, Any]) -> str:
    """Wait a given number of milliseconds before returning.

    Useful when a later step (an external service, a rate limit, a cooldown)
    must not run immediately. Returns once the delay elapses.
    """
    import asyncio
    raw = args.get("ms")
    try:
        ms = int(raw)
    except (TypeError, ValueError):
        return f"Error: Wait 需要数字类型的 ms 参数（毫秒）。收到: {raw!r}"
    if ms < 0:
        return f"Error: ms 不能为负数，收到 {ms}"
    if ms > 300000:
        return f"Error: ms 超出上限（最多 300000 = 5 分钟），收到 {ms}"
    await asyncio.sleep(ms / 1000)
    return f"已等待 {ms} 毫秒。"


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

# Tools whose executor accepts `instance_id` (DB uuid) as the 3rd positional
# arg, so backend SSE broadcasts carry the uuid instead of the directory name.
# GitCommit is excluded (handled by its own dispatcher branch above).
_FILE_TOOL_EXECUTORS = {
    "SetRuntimeVar", "Write", "Edit", "Report", "WriteLine", "FileOps",
    "GitBranch", "GitCheckout", "Output", "OutputEdit", "RepairVars",
}

TOOL_EXECUTORS = {
    "Read": execute_read,
    "Write": execute_write,
    "Edit": execute_edit,
    "WriteLine": execute_edit_line,
    "Glob": execute_glob,
    "Grep": execute_grep,
    "CheckPackageRefs": execute_check_package_refs,
    "Generate": execute_generate,
    "Output": execute_output,
    "OutputEdit": execute_output_edit,
    "Roll": execute_roll,
    "SkillRead": execute_skill_read,
    "FileOps": execute_file_ops,
    "TodoWrite": execute_todo_write,
    "GetRuntimeVars": execute_get_runtime_vars,
    "SetRuntimeVar": execute_set_runtime_var,
    "RepairVars": execute_repair_vars,
    "GitCommit": execute_git_commit,
    "GitBranch": execute_git_branch,
    "GitCheckout": execute_git_checkout,
    "GitLog": execute_git_log,
    "GitStatus": execute_git_status,
    "GitDiff": execute_git_diff,
    "Wait": execute_wait,
    "Report": execute_report,
    "EndSession": execute_end_session,
    "StartSubSession": execute_start_sub_session,
    "SendToSubSession": execute_send_to_sub_session,
    "DeleteSubSession": execute_delete_sub_session,
    "PruneContext": execute_prune_context,
}

# Sub-session default tool grants. A child session may only call the tools on
# its `enabled_tools` list; if the list is absent, these read-only + bookkeeping
# tools are the baseline. Report is always allowed (its only output is temp/).
# Read-only toolset: 文件读取/搜索、Skill 教学、变量读取、git 只读（log/diff/status）。
# 写正式区（Write/Edit/Generate/GitCommit 等）一律不默认给，需要显式 add。
SUB_SESSION_BASE_TOOLS = {
    "Read",
    "Glob",
    "Grep",
    "CheckPackageRefs",
    "SkillRead",
    "GetRuntimeVars",
    "GitStatus",
    "GitLog",
    "GitDiff",
    "Report",
    "EndSession",
}


# DM（运行时导演）工具白名单 —— 轻量、全权但无子会话能力（见 ignored/dm-design.md）。
# 读/写/git 存盘/变量/呈现/骰子 + 少量辅助。**不给**：子会话三件套（Start/Send/DeleteSubSession）、
# Report、EndSession、Generate（正文助手轨）、FileOps、CheckPackageRefs、
# GitBranch/GitCheckout（分支切换是元操作，留给导演）。
DM_TOOLS = {
    "Read", "Glob", "Grep",
    "Write", "Edit", "WriteLine",
    "GitCommit", "GitDiff", "GitStatus", "GitLog",
    "GetRuntimeVars", "SetRuntimeVar",
    "Output", "OutputEdit", "Roll",
    "SkillRead", "TodoWrite", "Wait",
    "PruneContext",
}


# 导演**排除**集 —— DM 呈现子系统的两个工具，导演（含其子会话）一律不得调用。
# 导演的正交线路是 floors（Generate/Write），呈现归 DM 独占；导演误调 Output 会把气泡
# 写进 runtime/dm-output.jsonl，污染玩家视图（Roll 不排：导演可用骰子做随机判定）。
# schema 层摘掉（load_tools/load_tools_usage）+ 执行层拒绝（execute_tool）双层兜底。
DIRECTOR_EXCLUDED_TOOLS = {"Output", "OutputEdit"}


async def execute_tool(
    name: str,
    args: dict[str, Any],
    instance_dir: Path,
    user_id: str | None = None,
    instance_id: str | None = None,
    run_uuid: str | None = None,
    session_id: str | None = None,
    enabled_tools: list[str] | None = None,
    exclude: set[str] | None = None,
) -> str:
    """Execute a tool by name with the given args. Returns the result text.

    instance_id is the DB UUID — used for SSE broadcast filtering on the frontend.
    run_uuid (runTool batch id) is threaded to tools that emit progress events
    (Generate → generate_progress) so viewers can bind the buffer to a batch.
    session_id (a non-main child session) restricts which tools may run: the
    tool must be in `enabled_tools` (defaulting to SUB_SESSION_BASE_TOOLS).
    exclude is a role-level denylist applied *in addition* to enabled_tools — the
    director's loop passes DIRECTOR_EXCLUDED_TOOLS so a hallucinated DM-only call
    is refused even though the director session has no whitelist (DM passes None).
    Falls back to plugin tool executors if the tool is not built-in.
    """
    # Role-level denylist. Checked before the whitelist so a tool that is both
    # excluded for the role and absent from enabled_tools reports the right reason.
    _register_instance(instance_dir, instance_id)
    if exclude and name in exclude:
        return f"Error: tool '{name}' is not available in this context (DM-only tool)."
    # Sub-session permission gate. Main sessions (session_id=None/'main') and
    # sandbox runTool pass enabled_tools=None → no restriction.
    if enabled_tools is not None and name not in enabled_tools:
        return f"Error: tool '{name}' is not enabled in this sub-session. Enabled tools: {sorted(enabled_tools)}."

    executor = TOOL_EXECUTORS.get(name)
    if executor:
        try:
            if name == "Generate":
                result = await executor(instance_dir, args, user_id, run_uuid, instance_id)
            elif name == "GitCommit":
                result = await executor(instance_dir, args, instance_id)
            elif name in ("EndSession", "StartSubSession", "SendToSubSession", "DeleteSubSession") or name == "PruneContext":
                result = await executor(instance_dir, args, session_id, instance_id, user_id)
            elif name in _FILE_TOOL_EXECUTORS:
                result = await executor(instance_dir, args, instance_id)
            else:
                result = await executor(instance_dir, args)
            return result
        except Exception as e:
            return f"Error executing {name}: {e}"

    # Check plugin tool executors
    try:
        from .plugins import get_tool_executors_from_plugins, find_plugin_context_for_tool
        plugin_execs = get_tool_executors_from_plugins(user_id)
        plugin_exec = plugin_execs.get(name)
        if plugin_exec:
            ctx = find_plugin_context_for_tool(name, user_id or "")
            if ctx is not None and instance_dir is not None:
                ctx.bind_instance(instance_dir, instance_id or "")
            try:
                result = await plugin_exec(args, ctx, instance_dir, user_id)
                return result
            except Exception as e:
                return f"Error executing plugin tool {name}: {e}"
    except Exception:
        pass

    return f"Error: Unknown tool: {name}"
