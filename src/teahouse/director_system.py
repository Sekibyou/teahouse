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
from pathlib import Path
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
    """Build a flat listing of the instance root directory.

    - Root-level files are listed.
    - All directories are shown as a single line each (not expanded).
    - floors/ gets special stats (latest floor, summary coverage, unsummarized count).
    - Use Glob to explore inside directories when needed.
    """
    lines: list[str] = []
    root = instance_dir.resolve()

    entries = sorted(
        [e for e in root.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
        key=lambda e: (not e.is_dir(), e.name),
    )

    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.is_dir() and entry.name == "floors":
            lines.append(f"{connector}{_floors_summary(entry)}")
        elif entry.is_dir():
            lines.append(f"{connector}{entry.name}/")
        else:
            lines.append(f"{connector}{entry.name}")

    return "\n".join(lines)


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
