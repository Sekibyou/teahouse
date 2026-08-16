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
import json
import yaml
from pathlib import Path
from typing import Optional

from .placeholder import resolve_variables
from .database.workspaces import read_sandbox_vars as _read_sandbox_vars, build_type_map as _build_type_map

# ---------------------------------------------------------------------------
# Template directory — path relative to this file
# ---------------------------------------------------------------------------

TEMPLATE_DIR = Path(__file__).resolve().parent / "director-system"

TEMPLATE_FILES = [
    "behavior.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"
INSTANCE_SKILLS_DIR = "skills"

# Directories excluded entirely from tree display
TREE_EXCLUDE = {"__pycache__", ".git", ".DS_Store", "node_modules", "sessions", "building"}


def get_floors_stats(dir_path: Path) -> dict | None:
    """Return structured floors statistics for the WORKING floors history.

    The canonical floor history is `runtime/floors/`. Caller may pass
    that dir directly (already a "floors" dir), or an instance root — in which
    case the canonical location is resolved.

    Confirmed floors match `floor-<N>.md`; draft floors match
    `floor-<N>-draft.md` (in-progress, not yet finalized). `latest_floor` is the
    highest working floor number — it reflects the draft if the newest draft's
    number exceeds the newest confirmed floor.
    """
    # If given the floors dir itself (name == "floors"), use it directly and
    # derive the instance root; otherwise treat it as an instance root and
    # resolve the working floors location.
    if dir_path.name == "floors":
        canonical = dir_path
        instance_dir = dir_path.parents[1]  # floors -> runtime -> instance root
    else:
        instance_dir = dir_path
        canonical = dir_path / "runtime" / "floors"
        if not canonical.is_dir():
            canonical = dir_path / "floors"
    if not canonical.is_dir():
        return None

    files = [f for f in canonical.iterdir() if f.is_file() and not f.name.startswith(".")]

    # Confirmed numbers via regex on file name, drafts via -draft suffix.
    confirmed_nums = [int(f.stem.split("-")[1]) for f in files if re.match(r"^floor-\d+\.md$", f.name)]
    draft_nums = [int(f.stem.split("-")[1]) for f in files if re.match(r"^floor-\d+-draft\.md$", f.name)]

    total_confirmed = len(confirmed_nums)
    total_drafts = len(draft_nums)
    newest_confirmed = max(confirmed_nums) if confirmed_nums else None
    newest_draft = max(draft_nums) if draft_nums else None

    # `latest_floor` = highest working floor number. A draft saturates at its
    # own number (draft for a *future* floor), never above the newest confirmed.
    if newest_draft is not None and newest_confirmed is not None:
        latest_floor = max(newest_confirmed, newest_draft)
    elif newest_draft is not None:
        latest_floor = newest_draft
    else:
        latest_floor = newest_confirmed

    # Archive boundary ("summarized to floor N") is maintained by the backend in
    # <summary>/index.json on GitCommit(type=summary) — not derived
    # from file names. Falls back to "nothing summarized" for older instances.
    last_sum_start = None
    last_sum_end = None
    index_path = instance_dir / "summary" / "index.json"
    if index_path.is_file():
        try:
            idx = json.loads(index_path.read_text(encoding="utf-8"))
            last_sum_end = idx.get("summarized_through")
            entries = idx.get("entries") or []
            if entries:
                last_sum_start = entries[-1].get("start")
            if last_sum_start is None:
                last_sum_start = last_sum_end
        except Exception:
            last_sum_start = last_sum_end = None

    # Unsummarized counts only confirmed floors (unfinalized drafts don't accrue
    # archive debt). If no archive boundary, all confirmed floors are pending.
    unsummarized = 0
    if total_confirmed and last_sum_end is not None:
        unsummarized = max(0, total_confirmed - last_sum_end)
    elif total_confirmed and last_sum_end is None:
        unsummarized = max(0, total_confirmed - last_sum_start) if last_sum_start else total_confirmed

    if latest_floor is None:
        return None

    return {
        "latest_floor": latest_floor,
        "total_confirmed": total_confirmed,
        "total_drafts": total_drafts,
        "total_floors": total_confirmed + total_drafts,
        "last_summary_start": last_sum_start,
        "last_summary_end": last_sum_end,
        "unsummarized": unsummarized,
    }


def _floors_summary(dir_path: Path) -> str:
    """Build a one-line summary for the floors directory with stats."""
    stats = get_floors_stats(dir_path)
    if stats is None:
        return "floors/"

    floor_bits = [f"{stats['total_confirmed']} confirmed floors"]
    if stats["total_drafts"]:
        floor_bits.append(f"{stats['total_drafts']} draft{'s' if stats['total_drafts'] != 1 else ''}")
    parts = []
    parts.append(f"Latest floor: {stats['latest_floor']} ({', '.join(floor_bits)})")
    if stats["last_summary_start"] is not None:
        if stats["last_summary_start"] == stats["last_summary_end"]:
            parts.append(f"Last summary covered floor {stats['last_summary_start']}")
        else:
            parts.append(f"Last summary covered floors {stats['last_summary_start']}~{stats['last_summary_end']}")
    if stats["unsummarized"] > 0:
        parts.append(f"{stats['unsummarized']} confirmed floors unsummarized")

    return f"floors/  ({'; '.join(parts)})"


# Top-level instance dirs that are fully expanded in the tree (they hold the
# author-facing content a director works with). Everything else is one line.
FULLY_EXPAND_TREE = {"runtime", "settings", "skills"}


def _scan_tree(instance_dir: Path) -> str:
    """Build a listing of the instance root directory.

    - Root-level files and dirs are listed.
    - Content-rich top-level dirs (runtime/, settings/, skills/) are fully
      expanded; others (generate-config/, summary/, temp/, building/) collapse
      to one line. building/ is excluded (meta-workspace, not shipped content).
    - The working floor history under runtime/floors/ gets stats.
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

        if entry.is_dir() and entry.name in FULLY_EXPAND_TREE:
            lines.append(f"{connector}{entry.name}/")
            _scan_recursive(entry, lines, indent="    ")
        elif entry.is_dir():
            lines.append(f"{connector}{entry.name}/")
        else:
            lines.append(f"{connector}{entry.name}")

    lines.append("(This simplified tree shows only the instance root structure. Use Glob/Read tools to explore directory contents in full detail.)")
    lines.append("(Note: this tree and the floors/ stats are rebuilt fresh on every request — they are not a stale snapshot. Files, drafts, and the archive boundary always reflect current disk state, so re-check them if something seems outdated.)")

    return "\n".join(lines)


def _scan_recursive(dir_path: Path, lines: list[str], indent: str) -> None:
    """Recursively scan a content-rich top-level dir, fully expanding subdirs.

    runtime/floors/ is summarized via get_floors_stats; runtime/sandbox/disabled/
    is shown collapsed as a disable toggle. Everything else is expanded normally.
    """
    entries = sorted(
        [e for e in dir_path.iterdir() if e.name not in TREE_EXCLUDE and not e.name.startswith(".")],
        key=lambda e: (not e.is_dir(), e.name),
    )

    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.is_dir() and entry.name == "floors" and dir_path.name == "runtime":
            # runtime/floors/ — the context-engine's floor history
            lines.append(f"{indent}{connector}{_floors_summary(entry)}")
        elif entry.is_dir() and entry.name == "disabled" and dir_path.name == "sandbox":
            # runtime/sandbox/disabled/ — collapsed disable toggle
            count = sum(1 for f in entry.rglob("*") if f.is_file())
            lines.append(f"{indent}{connector}disabled/  ({count} file(s) disabled — sandbox ignores this dir)")
        elif entry.is_dir():
            lines.append(f"{indent}{connector}{entry.name}/")
            _scan_recursive(entry, lines, indent + "    ")
        else:
            lines.append(f"{indent}{connector}{entry.name}")


def _scan_skills(instance_dir: Path) -> str:
    """Scan system skills and instance skills, extract name + description from SKILL.md frontmatter.

    System skills (teahouse_skills/) are always loaded.
    Instance skills (skills/) are loaded on top — if a skill with the same
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

    The whole result is then resolved (via resolve_variables): `${name}` sandbox
    variable snapshots and `{{path}}` file slices are inlined — this is the no-cache
    injection that lets the director see current state without a Read round-trip.
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

    text = "\n\n".join(parts)

    # Resolve sandbox variables + file slices across the whole prompt (no-cache).
    var_map = _build_var_map(instance_dir)
    if "{{" in text or "${" in text:
        text = resolve_variables(text, var_map, instance_dir, type_map=_build_type_map(instance_dir))

    return text


# ---------------------------------------------------------------------------
# Template-based prompt preset resolution
# ---------------------------------------------------------------------------


def _build_var_map(instance_dir: Path) -> dict:
    """Flat name→value map: sandbox variables + a fresh ${...} snapshot.

    Also merges none of the internal `teahouse.*` keys here — those are supplied by
    the caller (build_template_variables for presets) where they truly exist. For the
    plain assemble path there may be no preset binding, so we only expose sandbox vars.
    """
    try:
        items = _read_sandbox_vars(instance_dir, None)
    except Exception:
        return {}
    return {item["name"]: item["value"] for item in items}


def build_template_variables(instance_dir: Path, tools_usage_text: str = "") -> dict[str, str]:
    """Compute the variable values available for prompt preset templates.

    Returns a flat name→value map usable as the var_map for ${...} resolution:
      - `teahouse.behavior` / `teahouse.tools_usage` / `teahouse.file_tree` /
        `teahouse.available_skills` — system-internal values, only present while
        assembling this preset (elsewhere they are missing → render literally).
      - All sandbox variables merged in (the ${name} no-cache snapshot).
    teahouse.md is intentionally NOT here — preset templates reference it as a file
    slice `{{teahouse.md}}`.
    """
    variables: dict[str, str] = {}

    # behavior.md — system-internal, only resolvable during preset assembly
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            variables["teahouse.behavior"] = filepath.read_text(encoding="utf-8").strip()
            break
    else:
        variables["teahouse.behavior"] = ""

    variables["teahouse.tools_usage"] = tools_usage_text.strip()
    variables["teahouse.file_tree"] = _scan_tree(instance_dir)
    variables["teahouse.available_skills"] = _scan_skills(instance_dir)

    # Sandbox variables (no-cache snapshot)
    try:
        items = _read_sandbox_vars(instance_dir, None)
    except Exception:
        items = []
    for item in items:
        variables[item["name"]] = item["value"]

    return variables


def resolve_preset_template(yaml_text: str, variables: dict[str, str], instance_dir: Path) -> tuple[str, list[dict]]:
    """Parse a YAML preset template and resolve variables + file slices.

    Returns (system_prompt, fake_messages_list).

    Fake messages can be specified in two ways:
    1. `messages:` key — a list of {role, content} dicts (same format as Generate config)
    2. Top-level `user:` and/or `assistant:` keys — shorthand for a single exchange

    `variables` is the var_map from build_template_variables (teahouse.* internal +
    sandbox vars). system: and fake-message contents are resolved via resolve_variables
    (both ${} and {{}}), so `{{teahouse.md}}` file slices work alongside ${...}.
    """
    data = yaml.safe_load(yaml_text) or {}
    type_map = _build_type_map(instance_dir)

    # Resolve system template with ${variable} + {{path}} substitution
    system_template = data.get("system", "") or ""
    system_prompt = resolve_variables(system_template, variables, instance_dir, type_map=type_map)

    # Collect fake messages: explicit `messages` key takes priority,
    # then fall back to top-level `user`/`assistant` shorthand
    fake_messages_raw = data.get("messages")

    if isinstance(fake_messages_raw, list):
        fake_messages = []
        for msg in fake_messages_raw:
            if isinstance(msg, dict) and "role" in msg:
                content = msg.get("content", "") or ""
                fake_messages.append({
                    "role": msg["role"],
                    "content": resolve_variables(str(content), variables, instance_dir, type_map=type_map),
                })
    else:
        fake_messages = []
        user_text = data.get("user")
        assistant_text = data.get("assistant")
        if user_text:
            fake_messages.append({"role": "user", "content": resolve_variables(str(user_text).strip(), variables, instance_dir, type_map=type_map)})
        if assistant_text:
            fake_messages.append({"role": "assistant", "content": resolve_variables(str(assistant_text).strip(), variables, instance_dir, type_map=type_map)})

    return system_prompt, fake_messages
