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
import os
import re as _re
import shutil
from pathlib import Path
from typing import Any

from .placeholder import resolve_placeholders, resolve_variables
from .config import LLMConfig
from .llm import LLMClient, LLMError
from .database.workspaces import read_sandbox_vars as _read_sandbox_vars, write_sandbox_vars as _write_sandbox_vars
from .git_utils import git_commit as _git_commit, git_branch as _git_branch, git_log as _git_log, git_branch_rename as _git_branch_rename, git_branch_create as _git_branch_create, git_rev_parse as _git_rev_parse, git_branch_switch_with_cleanup as _git_branch_switch_with_cleanup, git_status_porcelain, git_diff
from .state import state

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


def load_tools(path: Path | None = None) -> list[dict]:
    """Load tool schemas from tools.json, returning OpenAI-compatible function-calling format.

    Call this once at startup. The result is also stored in the module-level TOOLS variable.
    Includes plugin-provided tools if plugins are loaded.
    """
    global TOOLS
    p = path or _TOOLS_JSON_PATH
    raw = json.loads(p.read_text(encoding="utf-8"))
    builtin = [_raw_tool_to_schema(t) for t in raw]

    # Merge plugin tools
    try:
        from .plugins import get_tool_defs_from_plugins
        plugin_defs = get_tool_defs_from_plugins()
        plugin_schemas = [_raw_tool_to_schema(t) for t in plugin_defs]
        TOOLS = builtin + plugin_schemas
    except Exception:
        TOOLS = builtin

    return TOOLS


def load_tools_usage(path: Path | None = None) -> str:
    """Build the natural-language tool usage guide from tools.json.

    Each tool's `usage` field is rendered as a markdown section.
    Tools without a `usage` field are skipped.
    Includes plugin tool usage guides.
    Returns the combined text for injection into the director's system prompt.
    """
    p = path or _TOOLS_JSON_PATH
    raw = json.loads(p.read_text(encoding="utf-8"))

    sections = ["# 工具使用指南\n"]
    for tool in raw:
        name = tool["name"]
        usage = tool.get("usage", "")
        if not usage:
            continue

        sections.append(f"## {name}\n")
        sections.append(f"{usage}\n")

    # Append plugin tool usage guides
    try:
        from .plugins import get_tool_defs_from_plugins
        plugin_defs = get_tool_defs_from_plugins()
        if plugin_defs:
            sections.append("\n## 插件工具\n")
            for tool in plugin_defs:
                name = tool["name"]
                usage = tool.get("usage", tool["description"])
                sections.append(f"### {name}\n")
                sections.append(f"{usage}\n")
    except Exception:
        pass

    return "\n".join(sections)


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
    """Read file contents with optional offset and limit."""
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

    # Build output with line numbers like Claude Code:
    #   N  │ content
    #     │
    #   M  │ last line
    #     │
    #   (N–M/M lines, file: path)
    line_width = len(str(end))
    result_lines = []
    for i, line in enumerate(selected):
        line_num = start + 1 + i
        content = line.rstrip("\n").rstrip("\r")
        result_lines.append(f"{str(line_num).rjust(line_width)}  │ {content}")
    result_lines.append(" " * line_width + "  │")
    result_lines.append(f"  ({start + 1}–{min(end, total)}/{total} lines, file: {path})")

    return "\n".join(result_lines)


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


async def execute_set_runtime_var(instance_dir: Path, args: dict[str, Any]) -> str:
    """Write runtime variables. Merges `updates` (+ optional `note`/`change_log`).

    - `updates`: {name: value} — overwrite value; missing names are created.
    - `note`: {name: content} — overwrite that variable's note (metadata).
    - `change_log`: {name: entry} — APPEND an entry to that variable's change_log.
    - `delete`: list of names — remove those variables entirely.
    File-as-state: persisted to .teahouse/runtime_vars.jsonl, authoritative + git-tracked.
    """
    updates = args.get("updates")
    note = args.get("note")
    change_log = args.get("change_log")
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
    if not updates and not note and not change_log and not delete:
        return "Error: provide at least one of updates / note / change_log / delete"

    # Reserved namespace guard across every name-bearing arg
    prefix_warn = ""
    reserved = []
    for mapping in (updates, note, change_log):
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
        for mapping in (updates, note, change_log):
            if not mapping:
                continue
            for k in list(mapping):
                if str(k) in reserved_key_set:
                    mapping.pop(k)
        delete = [d for d in delete if d not in reserved_key_set]

    try:
        if updates:
            _write_sandbox_vars(instance_dir, updates, note=note, change_log=change_log)
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
        {"path": ".teahouse/runtime_vars.jsonl", "tool": "SetRuntimeVar", "instance_id": instance_dir.name},
    )

    affected = list(updates.keys()) if updates else []
    affected += list(note.keys()) if note else []
    affected += list(change_log.keys()) if change_log else []
    if delete:
        return "Variables deleted: " + ", ".join(delete) + prefix_warn

    items = _read_sandbox_vars(instance_dir, list(dict.fromkeys(affected)))
    if not items:
        return "No variables found." + prefix_warn
    return "Variables set:\n" + "\n".join(_fmt_var_entry(item) for item in items) + prefix_warn


def _sandbox_var_map(instance_dir: Path) -> dict:
    """Flat name→value dict of the instance sandbox variables."""
    try:
        items = _read_sandbox_vars(instance_dir, None)
    except ValueError:
        return {}
    return {item["name"]: item["value"] for item in items}


def _resolve_messages_vars(messages: list[dict], instance_dir: Path) -> list[dict]:
    """Resolve ${name} + {{path}} in every string value of a messages list (Generate).

    Both surfaces an LLM consumes resolve variables before send (酒馆-style): the
    writer/Generate path materializes `${name}` to its value so the prose `AI` writes
    uses real values (not placeholders) — the sandbox later applies special effects via
    regex on the resolved text.
    """
    var_map = _sandbox_var_map(instance_dir)

    def _resolve_value(v):
        if isinstance(v, str):
            if "{{" in v or "${" in v:
                return resolve_variables(v, var_map, instance_dir)
            return v
        if isinstance(v, dict):
            return {k: _resolve_value(x) for k, x in v.items()}
        if isinstance(v, list):
            return [_resolve_value(x) for x in v]
        return v

    return [_resolve_value(m) for m in messages]


async def execute_write(instance_dir: Path, args: dict[str, Any]) -> str:
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
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    state.broadcast("file_changed", {"path": path, "tool": "Write", "instance_id": instance_dir.name})
    return f"Successfully wrote {len(content.encode('utf-8'))} bytes to {path}. File state is now up to date in your context — no need to Read it back."


async def execute_edit(instance_dir: Path, args: dict[str, Any]) -> str:
    """Edit a file by exact string replacement. Follows Claude Code harness rules:
    - old_string must appear exactly once in the file (unless replace_all=True)
    - Must match whitespace exactly
    - Atomic: on failure, file is unchanged
    Set resolve_placeholders=true to resolve {{path}} placeholders in new_string.
    Default is false.
    """
    path = args["path"]
    old_string = args["old_string"]
    new_string = args["new_string"]
    replace_all = args.get("replace_all", False)

    # Resolve {{path}} placeholders in new_string (only when explicitly requested).
    # File slicing does NOT resolve variables (copy/move primitive).
    if args.get("resolve_placeholders", False) and "{{" in new_string:
        try:
            new_string = resolve_placeholders(new_string, instance_dir, strict=True)
        except Exception as e:
            return f"Error: 占位符解析失败: {e}"

    full = _validate_path(instance_dir, path)
    if not full.exists():
        return f"Error: File not found: {path}"

    content = full.read_text(encoding="utf-8")

    count = content.count(old_string)
    if count == 0:
        return f"Error: old_string not found in {path}. Note that the match must be exact including whitespace and line endings."
    if count > 1 and not replace_all:
        return f"Error: old_string appears {count} times in {path}. Must be unique. Set replace_all=true to replace all occurrences, or include more surrounding context."

    if replace_all:
        new_content = content.replace(old_string, new_string)
        full.write_text(new_content, encoding="utf-8")
        state.broadcast("file_changed", {"path": path, "tool": "Edit", "instance_id": instance_dir.name})
        return f"Successfully replaced all {count} occurrences in {path}. File state is now up to date in your context — no need to Read it back."
    else:
        new_content = content.replace(old_string, new_string, 1)
        full.write_text(new_content, encoding="utf-8")
        state.broadcast("file_changed", {"path": path, "tool": "Edit", "instance_id": instance_dir.name})
        return f"Successfully applied edit to {path}. File state is now up to date in your context — no need to Read it back."


async def execute_edit_line(instance_dir: Path, args: dict[str, Any]) -> str:
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
    state.broadcast("file_changed", {"path": path, "tool": "WriteLine", "instance_id": instance_dir.name})
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
    Returns matching file paths with line counts, sorted by match count descending.
    """
    pattern = args["pattern"]
    text_extensions = {".md", ".yaml", ".yml", ".json", ".txt", ".py", ".js", ".ts", ".css", ".html"}

    try:
        regex = _re.compile(pattern)
    except _re.error as e:
        return f"Error: invalid regex pattern '{pattern}': {e}"

    results: list[tuple[str, int]] = []
    for filepath in instance_dir.rglob("*"):
        if not filepath.is_file():
            continue
        if filepath.suffix not in text_extensions:
            continue
        rel = str(filepath.relative_to(instance_dir)).replace("\\", "/")
        try:
            content = filepath.read_text(encoding="utf-8")
        except Exception:
            continue
        count = len(regex.findall(content))
        if count > 0:
            results.append((rel, count))

    if not results:
        return f"No files matched pattern: {pattern}"

    results.sort(key=lambda x: (-x[1], x[0]))
    lines = [f"({len(results)} files)"]
    for path, count in results:
        suffix = f" ({count} matches)" if count > 1 else ""
        lines.append(f"{path}{suffix}")
    return "\n".join(lines)


async def execute_generate(instance_dir: Path, args: dict[str, Any], user_id: str | None = None) -> str:
    """Generate tool — reads YAML config, resolves placeholders, calls writer LLM, writes result to file.

    1. Read and parse YAML source_file into messages array
    2. Resolve {{path}} placeholders in messages
    3. Optionally dump resolved payload to JSON (debug only)
    4. Call the writer slot LLM (non-streaming)
    5. Write generated text to the specified output path
    6. Return summary with file path, word count, and first 50 chars preview
    """
    import json

    source_file_str = args.get("source_file", "")
    output_path_str = args.get("path", "")
    dump_payload_str = args.get("dump_payload_path", "")

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

    # Step 2: Resolve ${variables} + {{path}} file slices before sending to the writer LLM.
    resolved = _resolve_messages_vars(messages, instance_dir)

    # Step 3: Optionally dump resolved payload (debug only)
    if dump_payload_str:
        try:
            payload_full = _validate_path(instance_dir, dump_payload_str)
            payload_full.parent.mkdir(parents=True, exist_ok=True)
            payload_json = json.dumps(resolved, ensure_ascii=False, indent=2)
            payload_full.write_text(payload_json, encoding="utf-8")
        except ValueError as e:
            return f"Error: dump_payload_path 路径无效: {e}"
        except Exception as e:
            return f"Error: 写入 dump_payload_path 失败: {e}"

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
            max_tokens=profile["max_tokens"] if profile else 8192,
            temperature=profile["temperature"] if profile else 0.7,
            top_p=profile.get("top_p") if profile else None,
            frequency_penalty=profile.get("frequency_penalty") if profile else None,
            presence_penalty=profile.get("presence_penalty") if profile else None,
        ))
    except Exception as e:
        return f"Error: 解析 writer slot 配置失败: {e}"

    # Step 5: Call writer LLM (non-streaming)
    try:
        generated_text = await writer_client.send_message(resolved)
    except LLMError as e:
        return (
            f"Error: 正文模型 API 调用失败: {e}\n"
            f"请检查 writer slot 的 API key 和网络连接后重试。"
        )
    except Exception as e:
        return f"Error: 调用正文模型时发生意外错误: {e}"

    # Step 6: Write generated text to output file
    try:
        output_full.write_text(generated_text, encoding="utf-8")
    except Exception as e:
        return f"Error: 写入输出文件失败: {e}"

    state.broadcast("file_changed", {"path": output_path_str, "tool": "Generate", "instance_id": instance_dir.name})

    # Build summary
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


async def execute_skill_read(instance_dir: Path, args: dict[str, Any]) -> str:
    """Read a skill's SKILL.md content. Looks in instance .teahouse/skills/ first,
    then falls back to the system teahouse_skills/ directory."""
    name = args["name"]

    # Instance skills take priority
    instance_skill_dir = instance_dir / ".teahouse" / "skills" / name
    skill_dir = instance_skill_dir

    if not skill_dir.is_dir():
        # Fall back to system skills
        from .director_system import TEMPLATE_DIR
        system_skill_dir = TEMPLATE_DIR / "teahouse_skills" / name
        skill_dir = system_skill_dir

    if not skill_dir.is_dir():
        return f"Error: Skill '{name}' 不存在"
    skill_path = skill_dir / "SKILL.md"
    if not skill_path.exists():
        return f"Error: Skill '{name}' 缺少 SKILL.md"

    content = skill_path.read_text(encoding="utf-8")
    return f"## Skill: {name}\n\n{content.strip()}"


# ---------------------------------------------------------------------------
# FileOps tool executor
# ---------------------------------------------------------------------------


async def execute_file_ops(instance_dir: Path, args: dict[str, Any]) -> str:
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
        state.broadcast("file_changed", {"path": destination_str, "tool": "FileOps", "action": "move", "instance_id": instance_dir.name})
        return f"已移动：{path_str} → {destination_str}"

    if action == "delete":
        if not full.exists():
            return f"Error: 路径不存在：{path_str}"

        if full.is_dir():
            shutil.rmtree(full)
        else:
            full.unlink()

        state.broadcast("file_changed", {"path": path_str, "tool": "FileOps", "action": "delete", "instance_id": instance_dir.name})
        return f"已删除：{path_str}"

    return f"Error: 未知操作 '{action}'，支持 mkdir / move / delete"


# ---------------------------------------------------------------------------
# Text style rules — .teahouse/text-style-rules.yaml
# ---------------------------------------------------------------------------

TEHOUSE_DIR = ".teahouse"
TEXT_STYLE_RULES_FILE = "text-style-rules.yaml"


def _text_style_rules_path(instance_dir: Path) -> Path:
    """Get the path to text-style-rules.yaml, ensuring .teahouse/ exists."""
    teahouse_dir = instance_dir / TEHOUSE_DIR
    teahouse_dir.mkdir(parents=True, exist_ok=True)
    return teahouse_dir / TEXT_STYLE_RULES_FILE


def _load_text_style_rules(instance_dir: Path) -> list[dict]:
    """Load text style rules from disk. Returns empty list if file doesn't exist."""
    path = _text_style_rules_path(instance_dir)
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if data is None:
        return []
    return data.get("rules", [])


async def execute_batch_execute(instance_dir: Path, args: dict[str, Any]) -> str:
    """BatchExecute executor — reports the batch anchor record.

    The batch is expanded into its real sub-calls by app._tool_use_loop (mode B)
    before this executor runs. This executor only produces the *anchor* result for
    the BatchExecute call itself so the director sees a concrete "expanded N steps"
    record to tie the sub-results to. If expansion failed earlier (the call survived
    with only `path`), re-attempt the load to surface the real error.
    """
    from .script import load_batch, BatchError
    raw_path = str(args.get("path", "")).strip()
    total = args.get("total")

    if total is not None:
        # Anchor path: expansion already succeeded upstream; report the summary.
        return (
            f"BatchExecute 已展开共 {total} 步，按脚本行序执行。\n"
            f"后续各条结果均以 [BatchExecute X/{total}] 前缀标识其在批次中的序号。"
        )

    # Fallback: expansion failed (only path present). Re-attempt to surface why.
    try:
        steps = load_batch(instance_dir, raw_path)
    except BatchError as e:
        return f"Error: BatchExecute 未能展开脚本: {e}"
    return f"BatchExecute 已展开共 {len(steps)} 步。"


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
    try:
        diff_output = git_diff(instance_dir, path)
        if not diff_output.strip():
            return "没有差异（工作区与 HEAD 相同）。"
        return diff_output
    except Exception as e:
        return f"Git diff 失败: {e}"


async def execute_git_commit(instance_dir: Path, args: dict[str, Any], instance_id: str | None = None) -> str:
    """Execute git add -A + git commit with semantic type."""
    commit_type = args["type"]
    message = args["message"]

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
        result = _git_commit(instance_dir, git_message)
        files_str = ", ".join(result["files_changed"]) if result["files_changed"] else "(none)"
        state.broadcast("workspace_changed", {"tool": "GitCommit", "branch": result["branch"], "instance_id": instance_dir.name})

        # Update floor_count in DB for floor commits
        if commit_type == "floor" and instance_id:
            from .database.workspaces import update_floor_count
            await update_floor_count(instance_id, number)

        return (
            f"提交成功\n"
            f"  Commit: {result['commit_hash']}\n"
            f"  Branch: {result['branch']}\n"
            f"  文件: {files_str}"
        )
    except Exception as e:
        error_msg = str(e)
        if "nothing to commit" in error_msg.lower() or "nothing added" in error_msg.lower():
            return "没有需要提交的变更"
        return f"Git 提交失败: {error_msg}"


async def execute_git_branch(instance_dir: Path, args: dict[str, Any]) -> str:
    """Execute branch operations: list, create, switch, delete, rename."""
    action = args["action"]
    name = args.get("name")

    try:
        if action == "rename":
            new_name = args.get("new_name")
            if not name or not new_name:
                return "Error: rename 操作需要 name 和 new_name 参数"
            _git_branch_rename(instance_dir, name, new_name)
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "rename", "instance_id": instance_dir.name})
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
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "create", "instance_id": instance_dir.name})
            return f"分支 '{name}' 创建成功（基于当前 HEAD）"

        if action == "switch":
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "switch", "instance_id": instance_dir.name})
            return f"已切换到分支 '{name}'"

        if action == "delete":
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": "delete", "instance_id": instance_dir.name})
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


async def execute_git_checkout(instance_dir: Path, args: dict[str, Any]) -> str:
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

    state.broadcast("workspace_changed", {"tool": "GitCheckout", "branch": temp_name, "instance_id": instance_dir.name})

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


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

TOOL_EXECUTORS = {
    "Read": execute_read,
    "Write": execute_write,
    "Edit": execute_edit,
    "WriteLine": execute_edit_line,
    "Glob": execute_glob,
    "Grep": execute_grep,
    "Generate": execute_generate,
    "SkillRead": execute_skill_read,
    "FileOps": execute_file_ops,
    "TodoWrite": execute_todo_write,
    "BatchExecute": execute_batch_execute,
    "GetRuntimeVars": execute_get_runtime_vars,
    "SetRuntimeVar": execute_set_runtime_var,
    "GitCommit": execute_git_commit,
    "GitBranch": execute_git_branch,
    "GitCheckout": execute_git_checkout,
    "GitLog": execute_git_log,
    "GitStatus": execute_git_status,
    "GitDiff": execute_git_diff,
}


async def execute_slow_test(args: dict[str, Any], instance_dir: Path) -> str:
    """Wait 2 seconds, then return OK. For testing tool call rendering on the frontend."""
    import asyncio
    await asyncio.sleep(2)
    return "OK"


TOOL_EXECUTORS["SlowTest"] = execute_slow_test


async def execute_tool(name: str, args: dict[str, Any], instance_dir: Path, user_id: str | None = None, instance_id: str | None = None) -> str:
    """Execute a tool by name with the given args. Returns the result text.

    instance_id is the DB UUID — used for SSE broadcast filtering on the frontend.
    Falls back to plugin tool executors if the tool is not built-in.
    """
    executor = TOOL_EXECUTORS.get(name)
    if executor:
        try:
            if name == "Generate":
                result = await executor(instance_dir, args, user_id)
            elif name == "GitCommit":
                result = await executor(instance_dir, args, instance_id)
            else:
                result = await executor(instance_dir, args)
            return result
        except Exception as e:
            return f"Error executing {name}: {e}"

    # Check plugin tool executors
    try:
        from .plugins import get_tool_executors_from_plugins, find_plugin_context_for_tool
        plugin_execs = get_tool_executors_from_plugins()
        plugin_exec = plugin_execs.get(name)
        if plugin_exec:
            ctx = find_plugin_context_for_tool(name, user_id or "")
            try:
                result = await plugin_exec(args, ctx, instance_dir, user_id)
                return result
            except Exception as e:
                return f"Error executing plugin tool {name}: {e}"
    except Exception:
        pass

    return f"Error: Unknown tool: {name}"
