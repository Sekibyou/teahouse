"""
Director system prompt assembler.

Assembles the Director's system prompt from:
1. Template files in director-system/ (role.md, behavior.md)
2. Tools usage guide from tools.json (loaded separately, passed in)
3. The instance's teahouse.md
4. A directory tree of the instance (always injected)
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

# Load order: files are concatenated in this order
TEMPLATE_FILES = [
    "role.md",
    "behavior.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"
SKILLS_DIR = "skills"

# Directories excluded entirely from tree display
TREE_EXCLUDE = {"__pycache__", ".git", ".DS_Store", "node_modules", "sessions"}

# Directories whose contents are summarized rather than expanded
FOLD_DIRS = {"floors", "skills"}
# Directories shown as name only (no file listing, no subdirectory expansion)
COMPACT_DIRS = {"temp"}


def _summarize_dir(dir_path: Path, name: str) -> str:
    """Build a one-line summary for a folded or compact directory."""
    files = sorted([f for f in dir_path.iterdir() if f.is_file() and not f.name.startswith(".")])
    total = len(files)

    if name == "floors":
        floors = sorted([f for f in files if re.match(r"^floor-\d+\.md$", f.name)])
        sums = sorted([f for f in files if re.match(r"^sum-\d+(-\d+)?\.md$", f.name)])

        # Floor stats
        newest_floor_num = int(floors[-1].stem.split("-")[1]) if floors else None
        total_floors = len(floors)

        # Summary stats — parse number(s) from filename
        last_sum_start = None
        last_sum_end = None
        if sums:
            newest_sum = sums[-1]
            stem = newest_sum.stem  # e.g. "sum-015-020" or "sum-005"
            sum_parts = stem.split("-")[1:]  # ["015", "020"] or ["005"]
            if len(sum_parts) == 2:
                last_sum_start = int(sum_parts[0])
                last_sum_end = int(sum_parts[1])
            elif len(sum_parts) == 1:
                last_sum_start = last_sum_end = int(sum_parts[0])

        # Unsummarized floors count
        unsummarized = 0
        if newest_floor_num and last_sum_end is not None:
            unsummarized = max(0, newest_floor_num - last_sum_end)
        elif newest_floor_num and last_sum_end is None:
            unsummarized = newest_floor_num

        parts = []
        if newest_floor_num:
            parts.append(f"Latest floor: {newest_floor_num:03d} ({total_floors} floors)")
        if last_sum_start is not None:
            if last_sum_start == last_sum_end:
                parts.append(f"Last summary covered floor {last_sum_start}")
            else:
                parts.append(f"Last summary covered floors {last_sum_start}~{last_sum_end}")
        if unsummarized > 0:
            parts.append(f"{unsummarized} floors unsummarized")
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
    - skills/ and temp/ are shown as directory name only (compact).
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


def _get_rendered_line_spans(instance_dir: Path) -> dict[str, tuple[int, int]]:
    """Get line number spans for each block in output-rendered.txt.
    Returns {uuid: (start_line, end_line)} (1-indexed, inclusive).
    """
    rendered_file = instance_dir / ".teahouse" / "output-rendered.txt"
    if not rendered_file.exists():
        return {}
    spans = {}
    for i, line in enumerate(rendered_file.read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("<") and not line.startswith("</") and line.endswith(">"):
            uuid = line[1:-1]
            spans[uuid] = [i, None]
        elif line.startswith("</") and line.endswith(">"):
            uuid = line[2:-1]
            if uuid in spans:
                spans[uuid][1] = i
    return {k: (v[0], v[1]) for k, v in spans.items() if v[1] is not None}


def _scan_output_blocks(instance_dir: Path) -> str:
    """Read .teahouse/output-blocks.yaml and build a summary for the system prompt.

    Includes uuid, label, note, content_type, and (if present) rendered line spans
    from output-rendered.txt so the director can Read specific sections.
    """
    teahouse_dir = instance_dir / ".teahouse"
    blocks_file = teahouse_dir / "output-blocks.yaml"
    if not blocks_file.exists():
        return "当前活跃输出块：无"

    import yaml
    data = yaml.safe_load(blocks_file.read_text(encoding="utf-8"))
    if data is None:
        return "当前活跃输出块：无"

    blocks = data.get("blocks", [])
    if not blocks:
        return "当前活跃输出块：无"

    # Load rendered line spans for blocks with placeholders
    spans = _get_rendered_line_spans(instance_dir)

    lines = ["当前活跃输出块（详情见 output-blocks.yaml / output-rendered.txt）："]
    for b in blocks:
        uuid = b["uuid"]
        ct = b.get("content_type", "rich_text")
        base = f"  - uuid: {uuid} | label: {b['label']} | type: {ct} | note: {b['note']}"
        if uuid in spans:
            s, e = spans[uuid]
            base += f" | rendered: L{s}-L{e}"
        lines.append(base)
    return "\n".join(lines)


def assemble_system_prompt(instance_dir: Path, tools_usage_text: str = "") -> str:
    """Assemble the full system prompt for the Director.

    Reads template files from director-system/ in order,
    injects the tools usage guide, then appends: instance directory tree,
    skills catalogue, output blocks list, and teahouse.md.
    """
    parts: list[str] = []

    # 1. Template parts (role, behavior)
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            parts.append(filepath.read_text(encoding="utf-8").strip())

    # 2. Tools usage guide (from tools.json, loaded by caller)
    if tools_usage_text:
        parts.append(tools_usage_text.strip())

    # 3. Instance directory tree
    tree = _scan_tree(instance_dir)
    parts.append(f"## 实例目录结构\n\n{tree}")

    # 4. Skills catalogue (name + description from SKILL.md)
    parts.append(_scan_skills(instance_dir))

    # 5. Output blocks list
    parts.append(_scan_output_blocks(instance_dir))

    # 6. Instance teahouse.md
    teahouse_path = instance_dir / INSTANCE_TEAHOUSE
    if teahouse_path.exists():
        parts.append(teahouse_path.read_text(encoding="utf-8").strip())

    return "\n\n".join(parts)
