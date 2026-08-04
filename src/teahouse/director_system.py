"""
Director system prompt assembler.

Assembles the Director's system prompt from:
1. behavior.md — system-level behavior rules
2. Tools usage guide from tools.json (loaded separately, passed in)
3. The instance's teahouse.md — role, config, skill routing
4. A flat directory listing of the instance (floors/ has special stats)
5. A skills catalogue (name + description from each SKILL.md frontmatter)

All template content lives in markdown files, not in Python code.
"""
from __future__ import annotations

import re
import yaml
from pathlib import Path
from string import Template
from typing import Optional

# ---------------------------------------------------------------------------
# Template directory — path relative to this file
# ---------------------------------------------------------------------------

TEMPLATE_DIR = Path(__file__).resolve().parent / "director-system"

TEMPLATE_FILES = [
    "behavior.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"
INSTANCE_SKILLS_DIR = ".teahouse/skills"

# Directories excluded entirely from tree display
TREE_EXCLUDE = {"__pycache__", ".git", ".DS_Store", "node_modules", "sessions"}


def get_floors_stats(dir_path: Path) -> dict | None:
    """Return structured floors statistics, or None if no floors exist.

    dir_path may be either the instance root or the floors/ subdirectory.
    """
    # Allow caller to pass either instance root or floors/ directly
    if dir_path.name != "floors":
        dir_path = dir_path / "floors"
    if not dir_path.is_dir():
        return None

    files = sorted([f for f in dir_path.iterdir() if f.is_file() and not f.name.startswith(".")])
    floors = sorted([f for f in files if re.match(r"^floor-\d+\.md$", f.name)])
    sums = sorted([f for f in files if re.match(r"^sum-\d+(-\d+)?\.md$", f.name)])

    newest_floor_num = int(floors[-1].stem.split("-")[1]) if floors else None
    total_floors = len(floors)

    last_sum_start = None
    last_sum_end = None
    if sums:
        newest_sum = sums[-1]
        sum_parts = newest_sum.stem.split("-")[1:]
        if len(sum_parts) == 2:
            last_sum_start = int(sum_parts[0])
            last_sum_end = int(sum_parts[1])
        elif len(sum_parts) == 1:
            last_sum_start = last_sum_end = int(sum_parts[0])

    unsummarized = 0
    if newest_floor_num and last_sum_end is not None:
        unsummarized = max(0, newest_floor_num - last_sum_end)
    elif newest_floor_num and last_sum_end is None:
        unsummarized = newest_floor_num

    if newest_floor_num is None:
        return None

    return {
        "latest_floor": newest_floor_num,
        "total_floors": total_floors,
        "last_summary_start": last_sum_start,
        "last_summary_end": last_sum_end,
        "unsummarized": unsummarized,
    }


def _floors_summary(dir_path: Path) -> str:
    """Build a one-line summary for the floors directory with stats."""
    stats = get_floors_stats(dir_path)
    if stats is None:
        return "floors/"

    parts = []
    parts.append(f"Latest floor: {stats['latest_floor']:03d} ({stats['total_floors']} floors)")
    if stats["last_summary_start"] is not None:
        if stats["last_summary_start"] == stats["last_summary_end"]:
            parts.append(f"Last summary covered floor {stats['last_summary_start']}")
        else:
            parts.append(f"Last summary covered floors {stats['last_summary_start']}~{stats['last_summary_end']}")
    if stats["unsummarized"] > 0:
        parts.append(f"{stats['unsummarized']} floors unsummarized")

    return f"floors/  ({'; '.join(parts)})"


def _scan_tree(instance_dir: Path) -> str:
    """Build a listing of the instance root directory.

    - Root-level files and dirs are listed (including .teahouse/).
    - Normal directories are shown as a single line, but .teahouse/ and
      _prototype/.teahouse/ are fully expanded.
    - floors/ gets special stats.
    - Use Glob to explore inside directories when needed.
    """
    lines: list[str] = []
    root = instance_dir.resolve()

    entries = sorted(
        [e for e in root.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
        key=lambda e: (not e.is_dir(), e.name),
    )

    # .teahouse/ is a special dir that should appear in the tree
    teahouse_dir = root / ".teahouse"
    if teahouse_dir.is_dir():
        entries.append(teahouse_dir)

    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.is_dir() and entry.name == "floors":
            lines.append(f"{connector}{_floors_summary(entry)}")
        elif entry.is_dir() and entry.name == ".teahouse":
            lines.append(f"{connector}.teahouse/")
            _scan_teahouse_dir(entry, lines, indent="    ", prototype=False)
        elif entry.is_dir() and entry.name == "_prototype":
            lines.append(f"{connector}_prototype/")
            _scan_prototype_dir(entry, lines, indent="    ")
        elif entry.is_dir():
            lines.append(f"{connector}{entry.name}/")
        else:
            lines.append(f"{connector}{entry.name}")

    has_prototype = any(entry.is_dir() and entry.name == "_prototype" for entry in entries)
    if has_prototype:
        lines.append("(This simplified tree shows only the instance root and _prototype/ structure. Use Glob/Read tools to explore directory contents in full detail.)")
    else:
        lines.append("(This simplified tree shows only the instance root structure. Use Glob/Read tools to explore directory contents in full detail.)")

    return "\n".join(lines)


def _scan_teahouse_dir(dir_path: Path, lines: list[str], indent: str, *, prototype: bool) -> None:
    """Recursively scan .teahouse/ directory, fully expanding all subdirectories.

    output/floors/ is summarized via get_floors_stats; output/sandbox/ is expanded
    as normal files; output_disabled/ is shown collapsed as a disable toggle.
    """
    entries = sorted(
        [e for e in dir_path.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
        key=lambda e: (not e.is_dir(), e.name),
    )

    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.is_dir() and entry.name == "floors" and dir_path.name == "output":
            # .teahouse/output/floors/ — the context-engine's floor history
            lines.append(f"{indent}{connector}{_floors_summary(entry)}")
        elif entry.is_dir() and entry.name == "output_disabled":
            # sandbox disable toggle — collapsed, shows only a file count
            count = sum(1 for f in entry.rglob("*") if f.is_file())
            lines.append(f"{indent}{connector}output_disabled/  ({count} file(s) disabled — sandbox ignores this dir)")
        elif entry.is_dir() and entry.name == "vars" and dir_path.name == ".teahouse":
            # sandbox variables — collapsed, sandbox-only write. Director reads via GetSandboxVars.
            count = sum(1 for f in entry.rglob("*") if f.is_file())
            lines.append(f"{indent}{connector}vars/  ({count} file(s) — sandbox-owned state, read via GetSandboxVars, do not edit)")
        elif entry.is_dir():
            lines.append(f"{indent}{connector}{entry.name}/")
            _scan_teahouse_dir(entry, lines, indent + "    ", prototype=prototype)
        else:
            lines.append(f"{indent}{connector}{entry.name}")


def _scan_prototype_dir(dir_path: Path, lines: list[str], indent: str) -> None:
    """Scan _prototype/ — normal dirs get single-line, .teahouse/ is fully expanded, floors/ gets prototype-specific stats."""
    entries = sorted(
        [e for e in dir_path.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
        key=lambda e: (not e.is_dir(), e.name),
    )

    # .teahouse/ is a special dir that should appear in the tree
    teahouse_dir = dir_path / ".teahouse"
    if teahouse_dir.is_dir():
        entries.append(teahouse_dir)

    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.is_dir() and entry.name == "floors":
            stats = get_floors_stats(entry)
            if stats:
                lines.append(f"{indent}{connector}floors/  ({stats['total_floors']} floors total) after packing as prototype becomes initial floors, placed under .teahouse/output/floors/")
            else:
                lines.append(f"{indent}{connector}floors/")
        elif entry.is_dir() and entry.name == ".teahouse":
            lines.append(f"{indent}{connector}.teahouse/")
            _scan_teahouse_dir(entry, lines, indent + "    ", prototype=True)
        elif entry.is_dir():
            lines.append(f"{indent}{connector}{entry.name}/")
        else:
            lines.append(f"{indent}{connector}{entry.name}")


def _scan_skills(instance_dir: Path) -> str:
    """Scan system skills and instance skills, extract name + description from SKILL.md frontmatter.

    System skills (teahouse_skills/) are always loaded.
    Instance skills (.teahouse/skills/) are loaded on top — if a skill with the same
    name exists in both, the instance version overrides the system version.
    """
    system_skills_dir = TEMPLATE_DIR / "teahouse_skills"
    instance_skills_dir = instance_dir / INSTANCE_SKILLS_DIR

    # Collect skill dirs: system first, then instance (instance overrides)
    skill_dirs: dict[str, Path] = {}

    if system_skills_dir.is_dir():
        for entry in system_skills_dir.iterdir():
            if entry.is_dir():
                skill_dirs[entry.name] = entry

    if instance_skills_dir.is_dir():
        for entry in instance_skills_dir.iterdir():
            if entry.is_dir():
                skill_dirs[entry.name] = entry  # instance overrides

    if not skill_dirs:
        return "（没有任何 Skill）"

    entries = []
    for name in sorted(skill_dirs):
        entry = skill_dirs[name]
        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            entries.append(f"- **{name}**：缺少 SKILL.md")
            continue

        content = skill_md.read_text(encoding="utf-8")

        # Extract name from YAML frontmatter (--- ... ---)
        m = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
        if not m:
            entries.append(f"- **{entry.name}**：无元数据")
            continue

        frontmatter = m.group(1)
        name_match = re.search(r"^name:\s*(.+)$", frontmatter, re.MULTILINE)
        desc_match = re.search(r"^description:\s*(.+)$", frontmatter, re.MULTILINE)
        name = (name_match and name_match.group(1).strip()) or entry.name
        desc = (desc_match and desc_match.group(1).strip()) or "（无描述）"
        entries.append(f"- **{name}**：{desc}")

    if not entries:
        return "（没有任何 Skill）"

    return "可用 Skill：\n" + "\n".join(entries)


def assemble_system_prompt(instance_dir: Path, tools_usage_text: str = "") -> str:
    """Assemble the full system prompt for the Director.

    teahouse.md comes first — it defines the director's role, configuration,
    and skill routing. It is the author's primary customization point.

    Then behavior.md, tools usage guide, instance directory listing,
    and skills catalogue.
    """
    parts: list[str] = []

    # 1. Instance teahouse.md — role, config, skill routing (THE customisation point)
    teahouse_path = instance_dir / INSTANCE_TEAHOUSE
    if teahouse_path.exists():
        parts.append(f"————根目录下 teahouse.md 内容开始————\n\n{teahouse_path.read_text(encoding='utf-8').strip()}\n\n————根目录下 teahouse.md 内容结束————")

    # 2. Behavior rules
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            name = filepath.stem
            parts.append(f"————{name} 开始————\n\n{filepath.read_text(encoding='utf-8').strip()}\n\n————{name} 结束————")

    # 3. Tools usage guide (from tools.json, loaded by caller)
    if tools_usage_text:
        parts.append(f"————工具使用指南开始————\n\n{tools_usage_text.strip()}\n\n————工具使用指南结束————")

    # 4. Instance directory tree
    tree = _scan_tree(instance_dir)
    parts.append(f"————当前文件结构树开始————\n\n{tree}\n\n————当前文件结构树结束————")

    # 5. Skills catalogue (name + description from SKILL.md)
    skills = _scan_skills(instance_dir)
    parts.append(f"————可用 Skill 列表开始————\n\n{skills}\n\n————可用 Skill 列表结束————")

    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Template-based prompt preset resolution
# ---------------------------------------------------------------------------


def build_template_variables(instance_dir: Path, tools_usage_text: str = "") -> dict[str, str]:
    """Compute the variable values available for prompt preset templates.

    Returns a dict with keys: teahouse, behavior, tools_usage, file_tree, available_skills
    """
    variables: dict[str, str] = {}

    # teahouse.md — 注入实例根目录下的 teahouse.md
    teahouse_path = instance_dir / INSTANCE_TEAHOUSE
    if teahouse_path.exists():
        variables["teahouse"] = teahouse_path.read_text(encoding="utf-8").strip()
    else:
        variables["teahouse"] = ""

    # behavior.md — 注入后端的 src/teahouse/director-system/behavior.md
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            variables["behavior"] = filepath.read_text(encoding="utf-8").strip()
            break
    else:
        variables["behavior"] = ""

    # tools_usage
    variables["tools_usage"] = tools_usage_text.strip()

    # file_tree
    variables["file_tree"] = _scan_tree(instance_dir)

    # available_skills
    variables["available_skills"] = _scan_skills(instance_dir)

    return variables


def resolve_preset_template(yaml_text: str, variables: dict[str, str]) -> tuple[str, list[dict]]:
    """Parse a YAML preset template and resolve variables.

    Returns (system_prompt, fake_messages_list).

    Fake messages can be specified in two ways:
    1. `messages:` key — a list of {role, content} dicts (same format as Generate config)
    2. Top-level `user:` and/or `assistant:` keys — shorthand for a single exchange
    """
    data = yaml.safe_load(yaml_text) or {}

    # Resolve system template with {{variable}} substitution
    system_template = data.get("system", "") or ""
    tmpl = Template(system_template)
    system_prompt = tmpl.safe_substitute(**variables)

    # Collect fake messages: explicit `messages` key takes priority,
    # then fall back to top-level `user`/`assistant` shorthand
    fake_messages_raw = data.get("messages")

    if isinstance(fake_messages_raw, list):
        fake_messages = [
            {"role": msg["role"], "content": msg.get("content", "") or ""}
            for msg in fake_messages_raw
            if isinstance(msg, dict) and "role" in msg
        ]
    else:
        fake_messages = []
        user_text = data.get("user")
        assistant_text = data.get("assistant")
        if user_text:
            fake_messages.append({"role": "user", "content": str(user_text).strip()})
        if assistant_text:
            fake_messages.append({"role": "assistant", "content": str(assistant_text).strip()})

    return system_prompt, fake_messages
