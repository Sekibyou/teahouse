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

# Directories excluded entirely from tree display
TREE_EXCLUDE = {"__pycache__", ".git", ".DS_Store", "node_modules", "sessions"}

# Directories whose contents are summarized rather than expanded
FOLD_DIRS = {"floors", "skills"}
# Directories shown as name only (no file listing, no subdirectory expansion)
COMPACT_DIRS = {"current"}


def _summarize_dir(dir_path: Path, name: str) -> str:
    """Build a one-line summary for a folded or compact directory."""
    files = sorted([f for f in dir_path.iterdir() if f.is_file()])
    total = len(files)

    if name == "floors":
        floors = [f for f in files if re.match(r"^floor-\d+\.md$", f.name)]
        sums = [f for f in files if re.match(r"^sum-\d+\.md$", f.name)]
        newest_floor = floors[-1].name if floors else None
        newest_sum = sums[-1].name if sums else None
        parts = []
        if newest_floor:
            parts.append(f"Newest floor: {newest_floor}")
        if newest_sum:
            parts.append(f"Newest sum: {newest_sum}")
        parts.append(f"Total: {total} files")
        return f"floors/  ({'; '.join(parts)})"

    if name == "skills":
        subdirs = [d for d in dir_path.iterdir() if d.is_dir() and d.name not in TREE_EXCLUDE and not d.name.startswith(".")]
        return f"skills/  ({len(subdirs)} skills available, see skills list below)"

    return f"{name}/  ({total} files)"


def _scan_tree(instance_dir: Path) -> str:
    """Build a tree representation of the instance directory.

    Rules:
    - All root-level entries are shown (nothing hidden at root).
    - floors/ is folded into a one-line summary.
    - skills/ and current/ are shown as directory name only (compact).
    - Other directories (settings/, variables/, etc.) are fully expanded.
    """
    lines: list[str] = []
    root = instance_dir.resolve()

    def _walk(dir_path: Path, prefix: str = ""):
        entries = sorted(
            [e for e in dir_path.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
            key=lambda e: (not e.is_dir(), e.name),
        )
        for i, entry in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "

            if entry.is_dir() and entry.name in FOLD_DIRS:
                lines.append(f"{prefix}{connector}{_summarize_dir(entry, entry.name)}")
            elif entry.is_dir() and entry.name in COMPACT_DIRS:
                lines.append(f"{prefix}{connector}{entry.name}/")
            else:
                display_name = entry.name + ("/" if entry.is_dir() else "")
                lines.append(f"{prefix}{connector}{display_name}")
                if entry.is_dir():
                    extension = "    " if is_last else "│   "
                    _walk(entry, prefix + extension)

    _walk(root)
    return "\n".join(lines)


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
