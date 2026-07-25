"""
Director system prompt assembler.

Assembles the Director's system prompt from:
1. Template files in director-system/ (role.md, behavior.md, tools.md, ...)
2. The instance's teahouse.md
3. A directory tree of the instance (always injected)
4. A skills catalogue (name + description from each SKILL.md frontmatter)

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

# Load order: files are concatenated in this order
TEMPLATE_FILES = [
    "role.md",
    "behavior.md",
    "tools.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"
SKILLS_DIR = "skills"

# Directories/files to exclude from the tree display
TREE_EXCLUDE = {"__pycache__", ".git", ".DS_Store", "node_modules", "current"}
TREE_EXCLUDE_PREFIX = ("current/",)


def _scan_skills(instance_dir: Path) -> str:
    """Scan skills directory and extract name + description from SKILL.md frontmatter.

    Returns a formatted markdown block listing available skills.
    """
    skills_dir = instance_dir / SKILLS_DIR
    if not skills_dir.is_dir():
        return "（实例中没有任何 Skill）"

    entries = []
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            entries.append(f"- **{entry.name}**：缺少 SKILL.md")
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
        return "（实例中没有任何 Skill）"

    return "可用 Skill：\n" + "\n".join(entries)


def _scan_tree(instance_dir: Path) -> str:
    """Build a tree representation of the instance directory.

    Excludes runtime/generated directories (current/, __pycache__, .git, etc.).
    """
    lines: list[str] = []
    root = instance_dir.resolve()

    def _walk(dir_path: Path, prefix: str = ""):
        entries = sorted(
            [e for e in dir_path.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
            key=lambda e: (not e.is_dir(), e.name),  # dirs first, then files
        )
        for i, entry in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "
            display_name = entry.name + ("/" if entry.is_dir() else "")
            lines.append(f"{prefix}{connector}{display_name}")
            if entry.is_dir():
                extension = "    " if is_last else "│   "
                _walk(entry, prefix + extension)

    _walk(root)
    return "\n".join(lines)


def assemble_system_prompt(instance_dir: Path) -> str:
    """Assemble the full system prompt for the Director.

    Reads template files from director-system/ in order,
    then appends: instance directory tree, skills catalogue, and teahouse.md.
    """
    parts: list[str] = []

    # 1. Template parts (role, behavior, tools)
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            parts.append(filepath.read_text(encoding="utf-8").strip())

    # 2. Instance directory tree
    tree = _scan_tree(instance_dir)
    parts.append(f"## 实例目录结构\n\n{tree}")

    # 3. Skills catalogue (name + description from SKILL.md)
    parts.append(_scan_skills(instance_dir))

    # 4. Instance teahouse.md
    teahouse_path = instance_dir / INSTANCE_TEAHOUSE
    if teahouse_path.exists():
        parts.append(teahouse_path.read_text(encoding="utf-8").strip())

    return "\n\n".join(parts)
