"""
Director tool definitions and executors.

Each tool is defined as an OpenAI-compatible function-calling schema,
with a corresponding async executor that operates on an instance's file system.

Following Claude Code's harness design: exact string matching for Edit,
path traversal protection, atomic operations with clear success/failure.
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Any

from .placeholder import resolve_messages_placeholders


# ---------------------------------------------------------------------------
# Tool schemas (OpenAI-compatible function calling)
# ---------------------------------------------------------------------------

TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "Read",
            "description": "读取文件内容。不指定 offset/limit 则读取整个文件。offset 从 1 开始。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径，相对于实例根目录。例如: settings/world.yaml, floors/floor-001.md",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "起始行号，从 1 开始。不指定则从文件开头读取。",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最大读取行数。不指定则读取 offset 之后的所有行。",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Write",
            "description": "写入文件内容（覆盖式）。如果文件已存在则完全覆盖，不存在则创建。会创建必要的父目录。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径，相对于实例根目录。例如: floors/floor-003.md",
                    },
                    "content": {
                        "type": "string",
                        "description": "写入的文件内容",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Edit",
            "description": "对文件执行精确字符串替换。old_string 必须在文件中唯一且精确匹配（包括空白字符和换行符），否则操作失败且文件状态不变。替换后文件自动保存，无需再次调用 Read 验证。如果确实需要全局替换所有匹配项，请设置 replace_all=true。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径，相对于实例根目录",
                    },
                    "old_string": {
                        "type": "string",
                        "description": "被替换的精确字符串，必须完全匹配文件中的内容且唯一（除非 replace_all=true）",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "替换后的字符串",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "是否替换所有匹配项。默认 false（只在 old_string 唯一时替换）。设为 true 则替换所有出现位置。",
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "WriteLine",
            "description": "替换文件中的指定行。每次调用只能替换一行（start_line 与 end_line 相同）。如需修改多行，请多次调用。注意：new_content 中的 \\n 会被自动处理，无需手动添加换行符。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径，相对于实例根目录",
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "起始行号，从 1 开始。如果只替换一行，start_line 和 end_line 设为相同值。",
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "结束行号（包含）。如果只替换一行，与 start_line 相同。不指定则仅替换 start_line 这一行。",
                    },
                    "new_content": {
                        "type": "string",
                        "description": "替换后的新行内容。如果是多行替换，请包含完整的多行文本。",
                    },
                },
                "required": ["path", "start_line", "new_content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Glob",
            "description": "按 glob 模式匹配实例中的文件路径。例如: **/*.md 匹配所有 markdown 文件, floors/floor-*.md 匹配楼层文件, * 匹配当前目录下的所有文件和目录。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "glob 模式，相对于实例根目录",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Generate",
            "description": "【实验性工具】构造正文生成请求。content 中可使用 {{path}} 占位符引用文件内容，支持切片语法：{{path:N-M}}（行号范围）、{{path:from=\"A\" to=\"B\"}}（锚点范围）、{{path:10-30 from=\"A\" to=\"B\"}}（混合）。替换后的完整请求输出到 current/generate-output.json 以供调试。当前处于实验阶段，不会真正调用 LLM。请直接向用户汇报本工具返回的结果。",
            "parameters": {
                "type": "object",
                "properties": {
                    "messages": {
                        "type": "array",
                        "items": {
                            "type": "object",
                        },
                        "description": "消息数组，每项包含 role 和 content。content 中可包含 {{path}} 占位符。",
                    },
                },
                "required": ["messages"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "SkillRead",
            "description": "读取指定 Skill 的教学内容，获得完整的方法论和 SOP。Skill 的名称和描述已在系统提示词中列出。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Skill 名称，例如 generate-floor、summarize",
                    },
                },
                "required": ["name"],
            },
        },
    },
]


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


async def execute_write(instance_dir: Path, args: dict[str, Any]) -> str:
    """Write content to a file (overwrite). Creates parent directories if needed."""
    path = args["path"]
    content = args["content"]

    full = _validate_path(instance_dir, path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    return f"Successfully wrote {len(content.encode('utf-8'))} bytes to {path}"


async def execute_edit(instance_dir: Path, args: dict[str, Any]) -> str:
    """Edit a file by exact string replacement. Follows Claude Code harness rules:
    - old_string must appear exactly once in the file (unless replace_all=True)
    - Must match whitespace exactly
    - Atomic: on failure, file is unchanged
    """
    path = args["path"]
    old_string = args["old_string"]
    new_string = args["new_string"]
    replace_all = args.get("replace_all", False)

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
        return f"Successfully replaced all {count} occurrences in {path}"
    else:
        new_content = content.replace(old_string, new_string, 1)
        full.write_text(new_content, encoding="utf-8")
        return f"Successfully applied edit to {path}"


async def execute_edit_line(instance_dir: Path, args: dict[str, Any]) -> str:
    """Edit a file by replacing a range of lines. Use after Read to confirm line numbers."""
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

    # If replacing a single line and the new content doesn't end with a newline,
    # append the original line ending so the next line doesn't merge into this one.
    if start_line == end_line and not decoded.endswith("\n") and total > start_line:
        decoded += lines[start_line - 1][-1] if lines[start_line - 1][-1] in ("\n", "\r") else "\n"

    # Replace the range [start_line-1, end_line) with decoded content.
    before = "".join(lines[: start_line - 1])
    after = "".join(lines[end_line:])
    new_file = before + decoded + after

    full.write_text(new_file, encoding="utf-8")
    return f"Successfully replaced lines {start_line}–{end_line} in {path}"


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


async def execute_generate(instance_dir: Path, args: dict[str, Any]) -> str:
    """Generate tool — debug version.

    1. Resolve {{path}} placeholders in messages
    2. Write the resolved messages to current/generate-output.json
    3. Return a random verification string
    """
    messages = args.get("messages", [])

    # Resolve placeholders
    resolved = resolve_messages_placeholders(messages, instance_dir)

    # Write output to current/generate-output.json
    output_path = instance_dir / "current" / "generate-output.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(resolved, ensure_ascii=False, indent=2), encoding="utf-8")

    # Generate random verification string
    token = secrets.token_hex(4)  # 8 hex chars
    return (
        f"【实验性工具 Generate 已执行】\n"
        f"占位符替换后的 messages 已写入 current/generate-output.json\n"
        f"验证令牌：{token}\n\n"
        f"请在聊天中直接向用户汇报以上验证令牌。"
    )


SKILLS_DIR = "skills"


async def execute_skill_read(instance_dir: Path, args: dict[str, Any]) -> str:
    """Read a skill's SKILL.md content."""
    name = args["name"]
    skill_dir = instance_dir / SKILLS_DIR / name
    skill_path = skill_dir / "SKILL.md"

    if not skill_dir.is_dir():
        return f"Error: Skill '{name}' 不存在"
    if not skill_path.exists():
        return f"Error: Skill '{name}' 缺少 SKILL.md"

    content = skill_path.read_text(encoding="utf-8")
    return f"## Skill: {name}\n\n{content.strip()}"


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

TOOL_EXECUTORS = {
    "Read": execute_read,
    "Write": execute_write,
    "Edit": execute_edit,
    "WriteLine": execute_edit_line,
    "Glob": execute_glob,
    "Generate": execute_generate,
    "SkillRead": execute_skill_read,
}


async def execute_tool(name: str, args: dict[str, Any], instance_dir: Path) -> str:
    """Execute a tool by name with the given args. Returns the result text."""
    executor = TOOL_EXECUTORS.get(name)
    if not executor:
        return f"Error: Unknown tool: {name}"
    try:
        return await executor(instance_dir, args)
    except Exception as e:
        return f"Error executing {name}: {e}"
