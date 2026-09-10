"""
Director system prompt assembler.

The director's system prompt is assembled from a user-configured prompt preset. A
built-in preset is auto-created and auto-bound to the director slot, so there is no
code-level fallback assembler. The preset template pulls in:
1. teahouse.md — file slice `{{teahouse.md}}`
2. behavior.md / tools usage / file tree / skills — via `teahouse.*` system values,
   spliced in after placeholder resolution as literal plain text

All template content lives in markdown files, not in Python code.
"""
from __future__ import annotations

import re
import json
import yaml
from pathlib import Path
from typing import Optional

from .placeholder import resolve_variables, MAX_RESOLVE_DEPTH
from .database.workspaces import read_sandbox_vars as _read_sandbox_vars, build_type_map as _build_type_map

# ---------------------------------------------------------------------------
# Template directory — path relative to this file
# ---------------------------------------------------------------------------

TEMPLATE_DIR = Path(__file__).resolve().parent / "director-system"

TEMPLATE_FILES = [
    "behavior.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"
INSTANCE_DM_YAML = "dm.yaml"
INSTANCE_SKILLS_DIR = "skills"

# Constant "structure guidance" file backing `${teahouse.file_tree}`. The var name
# is kept for backward compatibility with user-written presets, but its content is
# now a fixed description of the engine's top-level convention — NOT a live scan.
# Anything per-turn (usage, big-file warnings) goes through `user_tail` instead, so
# the system prompt stays byte-stable and the prompt cache prefix survives.
STRUCTURE_FILE = "structure.md"

# `${teahouse.user_input}` — the round's raw user text. Placeholder inside a
# `user_tail` template; substituted as a literal (never re-parsed).
USER_INPUT_PLACEHOLDER = "${teahouse.user_input}"

# Appended when a `user_tail` template omits `${teahouse.user_input}`: the author's
# content stays on top, the raw user line is dropped below this divider.
USER_TAIL_SUFFIX = (
    "\n\n————————————\n\n"
    "以上内容为挂载于最新用户消息上的信息。\n\n"
    "用户的原始输入是：\n\n" + USER_INPUT_PLACEHOLDER
)


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


def _load_structure() -> str:
    """Constant structure guidance backing `${teahouse.file_tree}`.

    No disk scan: the engine's top-level layout is fixed by convention, so this is
    just documentation. The var name is kept for backward compatibility with
    user-written presets that still reference `${teahouse.file_tree}`.
    """
    path = TEMPLATE_DIR / STRUCTURE_FILE
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return (
        "(instance root is fixed by engine convention: runtime/ settings/ "
        "generate-config/ summary/ skills/ temp/ — use Glob to explore contents)"
    )


def format_big_files(big: list[tuple[str, int]]) -> str:
    """Render the big-file warning for `${teahouse.big_files}`.

    Returns "" when there is nothing to warn about, so the placeholder stays empty
    for most turns and never churns the prompt cache.
    """
    if not big:
        return ""
    lines = ["⚠️ 大文件预警（单个文件一次 Read 即接近上半场预算，读取前请先规划/分段）："]
    for rel, chars in big:
        lines.append(f"  - {rel}：约 {chars // 3:,} token（{chars:,} 字符）")
    lines.append("（.sessions/、.git 等内部目录不参与预警）")
    return "\n".join(lines)


def _scan_big_files(instance_dir: Path) -> list[tuple[str, int]]:
    """Collect (relative_path, char_count) for text files exceeding
    BIG_INPUT_CHAR_LIMIT chars, walking the instance excluding internal dirs.
    Binary assets (runtime/assets/ images/fonts/audio, or any non-text extension)
    are skipped — the director reads those via readAsset, not Read, so a big PNG
    is no context-cost warning. Returned sorted by size (largest first).

    char_count is the **true character count** (``len`` of the utf-8 decoded
    text), consistent with the enqueue-spill and execute_read thresholds —
    byte size would over-count Chinese-heavy files (~3 bytes/char).
    """
    from .compact import BIG_INPUT_CHAR_LIMIT

    # Extensions the director reads as text via Read. Anything else (png/jpg/
    # webp/gif/ttf/woff/mp3/zip/7z etc.) is a binary resource, never a Read cost.
    TEXT_EXTS = {
        ".md", ".txt", ".yaml", ".yml", ".json", ".jsonl", ".py", ".js", ".jsx",
        ".ts", ".tsx", ".css", ".html", ".toml", ".ini", ".cfg", ".csv", ".log",
    }

    out: list[tuple[str, int]] = []
    root = instance_dir.resolve()
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            # Only text the director reads via Read is a context cost; binary
            # assets (png/jpg/webp/ttf/woff/mp3/zip…) never reach the LLM through
            # a Read, so they are skipped even if huge. Files under runtime/assets/
            # that ARE text (.md/.json from an unpacked tavern card) still count.
            if p.suffix.lower() not in TEXT_EXTS:
                continue
            if p.name == "event_log.jsonl":
                continue  # developer diagnostics, not director content
            rel_lib = p.relative_to(root)
            parts = rel_lib.parts
            if any(
                part in (".sessions", ".git") or part.startswith(".")
                for part in parts
            ):
                continue
            chars = len(p.read_text(encoding="utf-8"))  # true char count
            if chars > BIG_INPUT_CHAR_LIMIT:
                out.append((str(rel_lib), chars))
        except (OSError, ValueError):
            continue
    out.sort(key=lambda x: -x[1])
    return out


def _scan_skills(instance_dir: Path) -> str:
    """Scan system skills and instance skills, extract name + description from SKILL.md frontmatter.

    System skills (teahouse_skills/) are always loaded and take priority: they are
    the on-demand API/convention reference (必需品), so an instance skill of the
    same name must not silently shadow them. Instance skills fill in the rest.
    """
    system_skills_dir = TEMPLATE_DIR / "teahouse_skills"
    instance_skills_dir = instance_dir / INSTANCE_SKILLS_DIR

    # Collect skill dirs: instance first, then system (system wins on name clash)
    skill_dirs: dict[str, Path] = {}

    if instance_skills_dir.is_dir():
        for entry in instance_skills_dir.iterdir():
            if entry.is_dir():
                skill_dirs[entry.name] = entry

    if system_skills_dir.is_dir():
        for entry in system_skills_dir.iterdir():
            if entry.is_dir():
                skill_dirs[entry.name] = entry  # system overrides

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


def build_template_variables(instance_dir: Path, tools_usage_text: str = "") -> dict[str, str]:
    """Compute the variable values available for prompt preset templates.

    Returns a flat name→value map usable as the var_map for ${...} resolution:
      - `teahouse.behavior` / `teahouse.tools_usage` / `teahouse.file_tree` /
        `teahouse.available_skills` — static system-internal values, only present
        while assembling this preset (elsewhere they are missing → render literally).
        `teahouse.file_tree` is a CONSTANT structure guidance (no disk scan) so the
        system-prompt prefix stays cache-stable.
      - All sandbox variables merged in (the ${name} no-cache snapshot).
    teahouse.md is intentionally NOT here — preset templates reference it as a file
    slice `{{teahouse.md}}`.

    Per-turn dynamic values (`teahouse.user_input` / `teahouse.usage` /
    `teahouse.big_files`) are deliberately NOT here — they belong to `user_tail` and
    are added in `render_user_tail` (see there).
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
    variables["teahouse.file_tree"] = _load_structure()
    variables["teahouse.available_skills"] = _scan_skills(instance_dir)

    # Sandbox variables (no-cache snapshot)
    try:
        items = _read_sandbox_vars(instance_dir, None)
    except Exception:
        items = []
    for item in items:
        variables[item["name"]] = item["value"]

    return variables


def _resolve_text(
    text: str,
    variables: dict[str, str],
    instance_dir: Path,
    max_depth: int,
    type_map: dict | None = None,
) -> str:
    """Resolve `${}` + `{{}}` in `text`, then splice `teahouse.*` values as literals.

    The `teahouse.*` values are pulled out of the var_map *before* `resolve_variables`
    runs (so `${teahouse.behavior}` survives verbatim — a missing key renders
    literally), then substituted as plain text by a regex pass *after* resolution
    converges. Their content therefore never re-expands, so source files (behavior.md,
    tool-usage guides, or raw user input) need no escaping.

    Shared by the system prompt, preset fake messages, and `user_tail` so the
    "splice teahouse.* literally, last" invariant lives in one place.
    """
    teahouse_values = {k: v for k, v in variables.items() if k.startswith("teahouse.")}
    plain_var_map = {k: v for k, v in variables.items() if not k.startswith("teahouse.")}
    if teahouse_values:
        splice_re = re.compile(r"\$\{(" + "|".join(re.escape(k) for k in teahouse_values) + r")\}")
    else:
        splice_re = re.compile(r"(?!)")  # never matches

    tm = type_map if type_map is not None else _build_type_map(instance_dir)
    resolved = resolve_variables(text, plain_var_map, instance_dir, max_depth=max_depth, type_map=tm)
    return splice_re.sub(lambda m: teahouse_values[m.group(1)], resolved)


def estimate_usage_text(messages: list[dict], system_prompt: str, max_context: int) -> str:
    """A one-line context-usage report for `${teahouse.usage}`.

    Two escalation tiers, both naming the `PruneContext` tool (the delivery channel
    for the proactive-prune trigger — the tool only estimates by default, so
    pointing at it costs nothing):
      - `>= PRUNE_HINT_RATIO` (0.50, from compact.py) → advance warning.
      - `>= POST_COMPACT_RATIO` (0.70) → explicit (auto-compact would fire at the
        end of the cycle).
    The hint tier sits BELOW the compact threshold on purpose: user_tail is injected
    once per round, so the agent needs a round of lead time to act before compact.
    """
    from .compact import estimate_context_tokens, POST_COMPACT_RATIO, PRUNE_HINT_RATIO

    est = estimate_context_tokens(messages, system_prompt)
    if not max_context:
        return f"上下文用量：约 {est:,} tokens。"
    pct = est / max_context
    compact_at = int(max_context * POST_COMPACT_RATIO)
    base = f"上下文用量：约 {est:,} tokens / {max_context:,}（{pct:.0%}）。"
    if est >= compact_at:
        return base + (
            f"已达自动压缩阈值（{compact_at:,} tokens），本轮结束可能触发压缩。"
            "请用 `PruneContext` 卸载过期的旧工具内容（先 dry_run 看候选，确认后带 ids 一次批量执行）。"
        )
    if est >= int(max_context * PRUNE_HINT_RATIO):
        return base + (
            f"接近自动压缩阈值（{compact_at:,} tokens）。"
            "可先用 `PruneContext` 提前卸载过期的旧工具内容（先 dry_run 看候选，确认后带 ids 执行），避免触发压缩。"
        )
    return base


def render_user_tail(
    template: str,
    instance_dir: Path,
    messages: list[dict],
    system_prompt: str,
    max_context: int,
    user_input: str,
    max_depth: int = MAX_RESOLVE_DEPTH,
) -> str:
    """Render a preset `user_tail` template into the trailing user message's content.

    `template` is the RAW (unresolved) string from the preset. If it omits
    `${teahouse.user_input}`, `USER_TAIL_SUFFIX` is appended so the raw user line is
    still carried below the author's content. Resolution happens ONCE, after the
    decision — so `${teahouse.user_input}` splices correctly in both branches.

    Called per-turn from `app.py`; the result is never persisted.
    """
    variables = build_template_variables(instance_dir, "")
    variables["teahouse.user_input"] = user_input or ""
    variables["teahouse.usage"] = estimate_usage_text(messages, system_prompt, max_context)
    variables["teahouse.big_files"] = format_big_files(_scan_big_files(instance_dir))

    raw = template if USER_INPUT_PLACEHOLDER in template else template + USER_TAIL_SUFFIX
    return _resolve_text(raw, variables, instance_dir, max_depth)


def resolve_preset_template(yaml_text: str, variables: dict[str, str], instance_dir: Path, max_depth: int = MAX_RESOLVE_DEPTH) -> tuple[str, list[dict], str | None]:
    """Parse a YAML preset template and resolve variables + file slices.

    Returns (system_prompt, fake_messages_list, user_tail).

    Fake messages can be specified in two ways:
    1. `messages:` key — a list of {role, content} dicts (same format as Generate config)
    2. Top-level `user:` and/or `assistant:` keys — shorthand for a single exchange

    `user_tail` (optional) is the RAW template that wraps the trailing user message
    each turn — see `render_user_tail`. It is returned unresolved because it depends
    on per-turn data (user input, context usage) unknown at assembly time. It is NOT
    a fake message (those are prepended and role-tagged; `user_tail` wraps the real
    trailing turn and is never persisted).

    `variables` is the var_map from build_template_variables (teahouse.* internal +
    sandbox vars). system: and fake-message contents are resolved via `_resolve_text`
    (both ${} and {{}}), so `{{teahouse.md}}` file slices work alongside ${...}.
    """
    data = yaml.safe_load(yaml_text) or {}
    type_map = _build_type_map(instance_dir)

    def _resolve(content: str) -> str:
        return _resolve_text(str(content), variables, instance_dir, max_depth, type_map)

    # Resolve system template with ${variable} + {{path}} substitution
    system_template = data.get("system", "") or ""
    system_prompt = _resolve(system_template)

    # Collect fake messages: explicit `messages` key takes priority,
    # then fall back to top-level `user`/`assistant` shorthand
    fake_messages_raw = data.get("messages")

    if isinstance(fake_messages_raw, list):
        fake_messages = []
        for msg in fake_messages_raw:
            if isinstance(msg, dict) and "role" in msg:
                fake_messages.append({
                    "role": msg["role"],
                    "content": _resolve(msg.get("content", "") or ""),
                })
    else:
        fake_messages = []
        user_text = data.get("user")
        assistant_text = data.get("assistant")
        if user_text:
            fake_messages.append({"role": "user", "content": _resolve(user_text).strip()})
        if assistant_text:
            fake_messages.append({"role": "assistant", "content": _resolve(assistant_text).strip()})

    # Optional per-turn wrapper for the trailing user message (raw, unresolved).
    user_tail_raw = data.get("user_tail")
    user_tail = str(user_tail_raw) if user_tail_raw is not None else None

    return system_prompt, fake_messages, user_tail


# ---------------------------------------------------------------------------
# DM（运行时导演）—— 实例级提示词
# ---------------------------------------------------------------------------
#
# 导演的提示词是**全局的**（跟随用户的 prompt preset）；DM 的提示词是**实例内唯一**的：
# 实例根目录的 `dm.yaml`，格式仿导演提示词（system + 可选 messages/user/assistant），
# 同样支持 `${teahouse.*}`（含 DM 专属的 tools_usage）、`${}` 变量、`{{}}` 切片。
# 存在该文件即启用 DM（见 ignored/dm-design.md）。


def dm_enabled(instance_dir: Path) -> bool:
    """DM 是否启用 —— 实例根目录存在 dm.yaml。"""
    return (instance_dir / INSTANCE_DM_YAML).is_file()


# 引擎级「呈现契约」——**无条件**追加到 DM 系统提示词末尾（作者 dm.yaml 写不写都生效）。
# 作者提示词负责人格与风格；这一块负责两条不可协商的机制：玩家只看到 Output、
# 以及扮演回合（只呈现）与局外回合（可写元文本）的分工。
_DM_CONTRACT = """
[系统约定 · 呈现契约]
玩家在游玩视图**只看到 `Output` 写入的内容**。你这一回合的普通文本（以及思考、工具调用）玩家在游玩视图**看不到**——那是局外说明，只在 DM 控制台可见。
所以：凡是要让玩家看到的旁白 / 台词 / 骰子结果，**必须调用 `Output(chara, content, kind?)` 呈现**，不要用纯文本代替。一轮可多次调用。
玩家本轮的扮演发言已由系统自动写入呈现记录（不要重复 Output 玩家的话）。
只有最新批次能用 `OutputEdit(seq, old_string, new_string)` 修改；更早批次已成历史、不可改。

[两种输入 —— 决定你这一回合该怎么回]
玩家的每条消息开头都带一行系统前缀，标明它属于哪一类：

- `[[TH-SYS presence N]]` —— **扮演**（剧情推进）。这一回合你的回复**只能包含工具调用**（主要是 `Output`），**不要输出任何正文文本**——一字的说明、小结、旁白都别写在正文里。要让玩家看到的一律放进 `Output`；其余什么都不说。
  **典型反例（全错，都出现在正文里）**：
    「已呈现（本轮已呈现：旁白 ×2、老板娘台词 ×1）…」
    「现状要点（供后续参考）：掌柜姓胡…」
    「等待玩家下一步：住单间 / 挤通铺 / 不睡直接去公会。」
    「未掷骰、未存档…」「已把所在地更新为…」
  状态变化（所在地、数值、进度）用 `SetRuntimeVar` **静默**处理，不要用文字复述。
- `[[TH-SYS ooc]]` —— **局外**（玩家在跟你商量，不是在扮演）。**这类回合才适合**产出文本：状态小结、待办、设定问答、你要提醒作者的事等，直接写在你的回复正文里（只进 DM 控制台，玩家看不到）。
  若这一轮也顺势推进了剧情，照常用 `Output` 呈现那部分。

一句话：**扮演回合 = 只调工具、不写正文；局外回合 = 可以写元文本**。
""".strip()


async def resolve_dm_system(
    instance_dir: Path,
    user_id: str | None,
    max_depth: int = MAX_RESOLVE_DEPTH,
) -> Optional[tuple[str, list[dict], str | None]]:
    """组装 DM 的 system prompt。返回 (system_prompt, fake_messages, user_tail)；未启用 → None。

    工具指南只注入 DM 白名单（`tools.DM_TOOLS`）的 usage，避免把导演的全量工具
    说明塞进 DM 上下文。末尾**无条件**追加引擎级「呈现契约」（见 `_DM_CONTRACT`）。
    `user_tail` 为未解析的尾部包裹模板（与导演预设同语义，见 `render_user_tail`）。
    """
    p = instance_dir / INSTANCE_DM_YAML
    if not p.is_file():
        return None
    from .tools import load_tools_usage, DM_TOOLS

    yaml_text = p.read_text(encoding="utf-8")
    tools_usage = await load_tools_usage(user_id=user_id, only=DM_TOOLS)
    variables = build_template_variables(instance_dir, tools_usage)
    system_prompt, fake_messages, user_tail = resolve_preset_template(
        yaml_text, variables, instance_dir, max_depth=max_depth
    )
    system_prompt = (system_prompt.rstrip() + "\n\n" + _DM_CONTRACT).strip()
    return system_prompt, fake_messages, user_tail
