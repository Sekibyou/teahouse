"""prose_vars — 统一变量存储 + 快照机制。

设计见 ``ignored/prose-vars-design.md``。摘要：

- **一类变量、两个文件**：
  - ``runtime/runtime_vars.jsonl``（gitignored）= 工作值 live，含草稿效应，被频繁重算。
  - ``runtime/runtime_vars_snapshot.jsonl``（tracked）= 权威快照，等于最后一次转正时刻的完整状态。
- 正文里的 ``<!-- teahouse-vars: [...] -->`` 块**永远保留在正文**、永不改写（缓存命中 + 示范效应）。
- **重算**分两模式：软（保留非正文变量的最新值，只回退"后缀提到过"的变量）／硬（整体回到快照）。
- **bootstrap**：live 缺失或损坏 → 硬重建。这也是导出/导入后重建初始变量的路径。
- 快照缺失（老实例 / 新原型）→ 以「当前正式楼层 F + 当前 live」为快照基底，等价于"从那时的状态起算"。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from .placeholder import validate_var_name

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

LIVE_REL = "runtime/runtime_vars.jsonl"
SNAPSHOT_REL = "runtime/runtime_vars_snapshot.jsonl"

_FLOORS_REL = "runtime/floors"

VALID_VAR_TYPES = {"number", "string", "boolean", "array"}

_BLOCK_RE = re.compile(r"<!--\s*teahouse-vars\s*:\s*([\s\S]*?)\s*-->")
_FLOOR_RE = re.compile(r"^floor-(\d+)\.md$")
_DRAFT_RE = re.compile(r"^floor-(\d+)-draft\.md$")

_MISSING = object()


# ---------------------------------------------------------------------------
# 取值原语（原先散在 database.workspaces，收拢到此供两边共用）
# ---------------------------------------------------------------------------


def infer_var_type(value) -> str:
    """Infer a declared ``type`` from a value (backward-compat for legacy entries).

    object cannot be represented by any maintainable type and is mapped to ``string``
    as the least-surprising fallback for legacy entries carrying non-scalar data.
    """
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "array"
    return "string"


def clamp_number(value, lo=None, hi=None):
    """Clamp a numeric value to [lo, hi]. Bounds that are None are ignored."""
    if hi is not None:
        value = min(value, hi)
    if lo is not None:
        value = max(value, lo)
    return value


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _type_ok(t: str, v) -> bool:
    if t not in VALID_VAR_TYPES:
        return True
    if t == "number":
        return _is_number(v)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "array":
        return isinstance(v, list)
    return True


def _type_name(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, list):
        return "array"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------


def _resolve(instance_dir: Path, rel: str) -> Path:
    full = (instance_dir / rel).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    return full


def live_path(instance_dir: Path) -> Path:
    return _resolve(instance_dir, LIVE_REL)


def snapshot_path(instance_dir: Path) -> Path:
    return _resolve(instance_dir, SNAPSHOT_REL)


# ---------------------------------------------------------------------------
# 读写原语
# ---------------------------------------------------------------------------


def _parse_var_lines(text: str) -> dict[str, dict]:
    """Parse the variable lines of a store (meta header / blank / bad lines skipped)."""
    out: dict[str, dict] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and "name" in entry and "value" in entry:
            out[entry["name"]] = entry
    return out


def _meta_from_text(text: str, key: str) -> dict:
    """First line carrying `key` as a dict, e.g. `_meta` / `_snapshot`."""
    for line in text.splitlines():
        st = line.strip()
        if not st:
            continue
        try:
            obj = json.loads(st)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and key in obj and isinstance(obj[key], dict):
            return obj[key]
        break  # 元信息只认首行
    return {}


def _read_var_dict(path: Path) -> dict[str, dict]:
    """Read a jsonl var file into ``{name: entry}``.

    Skips the meta line, blank lines and unparseable lines (a corrupt line must not
    silently drop the rest). Missing file behaves like an empty store.
    """
    if not path.exists():
        return {}
    try:
        return _parse_var_lines(path.read_text(encoding="utf-8"))
    except OSError:
        return {}


def _read_meta_line(path: Path, key: str) -> dict:
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    return _meta_from_text(text, key)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _dump_var_lines(vars: dict[str, dict]) -> str:
    return "\n".join(json.dumps(vars[k], ensure_ascii=False) for k in vars) + ("\n" if vars else "")


def read_live_dict(instance_dir: Path) -> dict[str, dict]:
    """Read the working store. Missing file → empty dict (no side effects)."""
    return _read_var_dict(live_path(instance_dir))


def read_live_meta(instance_dir: Path) -> dict:
    return _read_meta_line(live_path(instance_dir), "_meta")


def write_live(instance_dir: Path, vars: dict[str, dict], meta: dict) -> None:
    """Atomically write the working store with its ``_meta`` header line.

    A no-op when the content is unchanged (no write, no event). Otherwise it broadcasts
    ``file_changed`` for the store: the file is gitignored, so neither git status nor the
    file-tree poll can notice a content change — without this the UI keeps showing stale
    variable values after the engine rewrites it.
    """
    body = json.dumps({"_meta": meta}, ensure_ascii=False) + "\n" + _dump_var_lines(vars)
    path = live_path(instance_dir)
    try:
        if path.exists() and path.read_text(encoding="utf-8") == body:
            return
    except OSError:
        pass
    _atomic_write(path, body)
    from .state import state

    state.broadcast(
        "file_changed",
        {
            "path": LIVE_REL,
            "tool": "prose_vars",
            "type": "modified",
            "instance_id": instance_id_for(instance_dir),
        },
    )


# dir path -> instance UUID. The variable layer only ever holds the directory, but the
# frontend scopes its SSE events by instance id, so a name-only event can be dropped.
# Callers that know both (route resolution, tool dispatch) register here.
_INSTANCE_IDS: dict[str, str] = {}


def register_instance(instance_dir: Path | None, instance_id: str | None) -> None:
    """Remember `instance_id` for this instance directory (see ``instance_id_for``)."""
    if not instance_dir or not instance_id:
        return
    try:
        _INSTANCE_IDS[str(instance_dir.resolve())] = instance_id
    except OSError:
        pass


def instance_id_for(instance_dir: Path) -> str:
    """The registered instance UUID for this directory, else its name as a fallback."""
    try:
        return _INSTANCE_IDS.get(str(instance_dir.resolve())) or instance_dir.name
    except OSError:
        return instance_dir.name


def read_snapshot(instance_dir: Path) -> tuple[int, dict[str, dict]]:
    """Return ``(floor, vars)`` for the authoritative snapshot.

    When no snapshot exists yet (a legacy instance, or a fresh one that has not promoted
    yet) it is seeded ONCE from the working store at the current formal floor. The seed
    must happen before any draft effect reaches the working store, otherwise the store
    would later be read back as its own base and the drafts would be applied twice.
    """
    path = snapshot_path(instance_dir)
    if not path.exists():
        if not instance_dir.exists():
            return 0, {}
        floor = formal_floor(instance_dir)
        seed = read_live_dict(instance_dir)
        write_snapshot(instance_dir, floor, seed)
        return floor, seed
    meta = _read_meta_line(path, "_snapshot")
    try:
        floor = int(meta.get("floor", 0))
    except (TypeError, ValueError):
        floor = 0
    return floor, _read_var_dict(path)


def write_snapshot(instance_dir: Path, floor: int, vars: dict[str, dict]) -> None:
    body = json.dumps({"_snapshot": {"floor": floor}}, ensure_ascii=False) + "\n" + _dump_var_lines(vars)
    _atomic_write(snapshot_path(instance_dir), body)


def ensure_var_gitignore(instance_dir: Path) -> None:
    """Idempotent migration keeping the derived working store out of git.

    Appends ``runtime/runtime_vars.jsonl`` to the instance ``.gitignore`` and, when the
    file is already tracked (instances created before this mechanism), untracks it so
    the derived store never enters ``git status`` / ``git add -A`` / commits.
    """
    gi = instance_dir / ".gitignore"
    try:
        text = gi.read_text(encoding="utf-8") if gi.exists() else ""
    except OSError:
        return
    if LIVE_REL in {ln.strip() for ln in text.splitlines()}:
        return
    body = text if (not text or text.endswith("\n")) else text + "\n"
    try:
        gi.write_text(body + LIVE_REL + "\n", encoding="utf-8")
    except OSError:
        return
    from .git_utils import _git_run

    try:
        _git_run(["rm", "--cached", "--ignore-unmatch", "-q", LIVE_REL], instance_dir)
    except Exception:  # noqa: BLE001 — best-effort untrack; ignore a non-repo instance
        pass


# ---------------------------------------------------------------------------
# 楼层枚举
# ---------------------------------------------------------------------------


def _floors_dir(instance_dir: Path) -> Path:
    return instance_dir / _FLOORS_REL


def formal_floor(instance_dir: Path) -> int:
    """F = the highest N such that ``runtime/floors/floor-N.md`` exists (0 if none)."""
    d = _floors_dir(instance_dir)
    if not d.is_dir():
        return 0
    nums = [int(m.group(1)) for f in d.iterdir() if f.is_file() and (m := _FLOOR_RE.match(f.name))]
    return max(nums) if nums else 0


def suffix_paths(instance_dir: Path, floor: int) -> list[tuple[int, Path, bool]]:
    """Floor files with N > `floor`, ascending; a draft sorts after a formal file of
    the same N (defensive — promotion renames, so both should not coexist).

    Returns ``[(N, path, is_draft), ...]``.
    """
    d = _floors_dir(instance_dir)
    if not d.is_dir():
        return []
    found: list[tuple[int, Path, bool]] = []
    for f in sorted(d.iterdir()):
        if not f.is_file() or f.name.startswith("."):
            continue
        m = _DRAFT_RE.match(f.name)
        if m:
            n = int(m.group(1))
            if n > floor:
                found.append((n, f, True))
            continue
        m = _FLOOR_RE.match(f.name)
        if m:
            n = int(m.group(1))
            if n > floor:
                found.append((n, f, False))
    found.sort(key=lambda t: (t[0], t[2]))
    return found


def current_meta(instance_dir: Path) -> dict:
    """The ``_meta`` header for the working store right now.

    ``owned`` lists the variables the current suffix (the floors above F) mentions — the
    ones prose owns. It is what lets a later recompute roll a variable back when the floor
    that introduced it disappears: without it, deleting or moving a draft away would leave
    its values stuck in the working store forever.
    """
    floor = formal_floor(instance_dir)
    paths = suffix_paths(instance_dir, floor)
    actions, _errors = _parse_paths(paths)
    return {
        "floor": floor,
        "suffix_hash": _suffix_hash(paths),
        "owned": sorted(_mentioned(actions)),
    }


def _owned_meta(instance_dir: Path) -> set[str]:
    """The ``owned`` names recorded by the last recompute."""
    raw = read_live_meta(instance_dir).get("owned")
    return set(raw) if isinstance(raw, list) else set()


def _suffix_hash(paths: list[tuple[int, Path, bool]]) -> str:
    h = hashlib.sha256()
    for n, p, is_draft in paths:
        h.update(f"{n}:{'d' if is_draft else 'f'}:".encode("utf-8"))
        try:
            h.update(p.read_bytes())
        except OSError:
            h.update(b"<missing>")
        h.update(b"\x00")
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------
# 变量块解析（语法与旧 TS 实现一致）
# ---------------------------------------------------------------------------

_BLOCK_ACTION_TYPES = {"set", "add", "append", "pop", "x"}


@dataclass
class Action:
    type: str
    name: str
    value: object = _MISSING
    index: object = _MISSING


def repair_json_literal(json_str: str) -> str:
    """防御性修复正文 bot 写坏的 JSON 大字面量：``"value": True`` → ``"value": true``。

    覆盖范围刻意收窄——只在 ``"value"`` 字段值位置把裸的大写 True/False 换成小写，
    不会误伤字符串 ``"value": "False"``、嵌套对象或数组内嵌。
    """
    return re.sub(
        r'("value"\s*:\s*)(True|False)(?=[\s,\]\}])',
        lambda m: m.group(1) + m.group(2).lower(),
        json_str,
    )


def parse_block(text: str) -> tuple[list[Action], list[str]]:
    """Parse the first ``teahouse-vars`` block in `text`.

    Returns ``(actions, errors)``. A missing block yields ``([], [])`` — not an error.
    """
    if not text:
        return [], []
    m = _BLOCK_RE.search(text)
    if not m:
        return [], []
    try:
        arr = json.loads(repair_json_literal(m.group(1)))
    except Exception as e:  # noqa: BLE001 — any parse failure is a reported error
        return [], [f"teahouse-vars JSON 解析失败：{e}"]
    if not isinstance(arr, list):
        return [], ["teahouse-vars 顶层必须是 JSON 数组"]

    actions: list[Action] = []
    errors: list[str] = []
    for raw in arr:
        if not isinstance(raw, dict):
            errors.append("teahouse-vars 条目必须是对象")
            continue
        t = raw.get("type")
        name = raw.get("name")
        if not isinstance(t, str) or t not in _BLOCK_ACTION_TYPES:
            errors.append(f"未知操作类型 {t!r}")
            continue
        if not isinstance(name, str):
            errors.append(f"{t} 缺少合法的 name")
            continue
        if t == "x":
            if "index" not in raw or "value" not in raw:
                errors.append(f"x 需要 index 与 value（{name}）")
                continue
            actions.append(Action(t, name, raw.get("value"), raw.get("index")))
        else:
            if "value" not in raw:
                errors.append(f"{t} 缺少 value（{name}）")
                continue
            actions.append(Action(t, name, raw.get("value")))
    return actions, errors


# ---------------------------------------------------------------------------
# 应用
# ---------------------------------------------------------------------------


def _entry_bounds(entry: dict | None):
    if not entry:
        return None, None
    return entry.get("min"), entry.get("max")


def _clamp(entry: dict | None, v):
    if not _is_number(v):
        return v
    lo, hi = _entry_bounds(entry)
    if lo is None and hi is None:
        return v
    return clamp_number(v, lo, hi)


def _store(vars_store: dict[str, dict], name: str, value) -> None:
    entry = vars_store.get(name)
    if entry is None:
        vars_store[name] = {"name": name, "value": value}
    else:
        entry["value"] = value


def _apply_one(act: Action, vars_store: dict[str, dict]) -> str | None:
    """Apply one action in place. Returns an error string, or None on success."""
    name = act.name
    verr = validate_var_name(name)
    if verr:
        return verr

    entry = vars_store.get(name)
    declared = entry.get("type") if entry else None
    cur = entry.get("value") if entry is not None else _MISSING
    cur_is_set = cur is not _MISSING

    if act.type == "set":
        v = act.value
        if isinstance(v, dict):
            return f"{name} 为对象类型，正文不维护对象，请改用 set 其合法标量/数组"
        if declared and not _type_ok(declared, v):
            return f"变量「{name}」声明为 {declared}，收到值 {v!r}"
        _store(vars_store, name, _clamp(entry, v))
        return None

    if act.type == "add":
        delta = act.value
        if not _is_number(delta):
            return f"{name} 的 add.value 必须为数字（得到 {delta!r}）"
        if declared and declared != "number":
            return f"{name} 为 {declared}，add 仅支持 number"
        if cur_is_set and not _is_number(cur):
            return f"{name} 为 {_type_name(cur)}，add 仅支持 number"
        base = cur if cur_is_set else 0
        _store(vars_store, name, _clamp(entry, base + delta))
        return None

    if act.type == "append":
        if cur_is_set and not isinstance(cur, list):
            return f"{name} 为 {_type_name(cur)}，append 目标是 array"
        arr = list(cur) if isinstance(cur, list) else []
        arr.append(act.value)
        _store(vars_store, name, arr)
        return None

    if act.type == "pop":
        if not cur_is_set or not isinstance(cur, list):
            return f"{name} 为 {_type_name(cur) if cur_is_set else '未设置'}，pop 目标是 array"
        arr = list(cur)
        for i, e in enumerate(arr):
            if e == act.value:
                arr.pop(i)
                _store(vars_store, name, arr)
                return None
        return None  # 未找到——视为成功（幂等：目标已不存在）

    if act.type == "x":
        if not cur_is_set or not isinstance(cur, list):
            return f"{name} 为 {_type_name(cur) if cur_is_set else '未设置'}，x 目标是 array"
        raw_idx = act.index
        if not _is_number(raw_idx):
            return f"x 的 index 必须为数字（得到 {raw_idx!r}）"
        arr = list(cur)
        idx = int(raw_idx)
        if idx < 0:
            idx = len(arr) + idx
        if idx < 0 or idx >= len(arr):
            return f"{name} 下标 {raw_idx} 越界（长度 {len(arr)}）"
        arr[idx] = act.value
        _store(vars_store, name, arr)
        return None

    return f"未知操作类型 {act.type!r}"


def apply_actions(actions: list[Action], vars_store: dict[str, dict]) -> list[str]:
    errors: list[str] = []
    for act in actions:
        err = _apply_one(act, vars_store)
        if err:
            errors.append(err)
    return errors


# ---------------------------------------------------------------------------
# 重算
# ---------------------------------------------------------------------------


def _parse_paths(paths: list[tuple[int, Path, bool]]) -> tuple[list[Action], list[str]]:
    actions: list[Action] = []
    errors: list[str] = []
    for n, p, _ in paths:
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            errors.append(f"floor-{n}: 读取失败 {e}")
            continue
        acts, errs = parse_block(text)
        actions.extend(acts)
        errors.extend(f"floor-{n}: {e}" for e in errs)
    return actions, errors


def _mentioned(actions: list[Action]) -> set[str]:
    return {a.name for a in actions}


def _rollback(store: dict[str, dict], base_vars: dict[str, dict], names: set[str]) -> None:
    """Reset each named variable to its base value (dropping it when the base lacks it)."""
    for name in names:
        if name in base_vars:
            store[name] = dict(base_vars[name])
        else:
            store.pop(name, None)


def recompute_soft(instance_dir: Path) -> list[str]:
    """Recompute the working store from the snapshot + the floors above it.

    Non-prose variables keep their latest value (external writes, UI state). Prose-owned
    variables are rolled back to the snapshot and replayed — and "prose-owned" covers both
    the names the suffix mentions NOW and the names it owned at the last recompute, so a
    floor that was just deleted or moved away releases its variables instead of leaving
    them stuck at the removed draft's values.
    """
    base_floor, base_vars = read_snapshot(instance_dir)
    live = read_live_dict(instance_dir)
    paths = suffix_paths(instance_dir, base_floor)
    actions, errors = _parse_paths(paths)

    _rollback(live, base_vars, _owned_meta(instance_dir) | _mentioned(actions))
    errors.extend(apply_actions(actions, live))
    write_live(instance_dir, live, current_meta(instance_dir))
    return errors


def rebuild_hard(instance_dir: Path) -> list[str]:
    """Hard rebuild: live := snapshot, then replay the floors above it. Used for bootstrap
    (missing/corrupt live), branch switch and git discard.
    """
    base_floor, base_vars = read_snapshot(instance_dir)
    seed = {k: dict(v) for k, v in base_vars.items()}
    paths = suffix_paths(instance_dir, base_floor)
    actions, errors = _parse_paths(paths)
    errors.extend(apply_actions(actions, seed))
    write_live(instance_dir, seed, current_meta(instance_dir))
    return errors


def freeze_snapshot(instance_dir: Path, floor: int) -> list[str]:
    """Write the authoritative snapshot at `floor`: the state at the END of that floor,
    formal floors only — a draft above `floor` is deliberately excluded.

    Promotion calls this with the floor being promoted (whose block still lives in a
    draft file, hence the inclusive bound); `full_repair` calls it with F.

    External (non-prose) variables come from the working store, which is right at
    promotion — they exist *now*, and this floor is now. Variables any present block owns
    are rolled back to the base first, so a draft above `floor` cannot push its creations
    into this snapshot.
    """
    base_floor, base_vars = read_snapshot(instance_dir)
    all_paths = suffix_paths(instance_dir, base_floor)
    all_actions, errors = _parse_paths(all_paths)

    seed = read_live_dict(instance_dir)
    _rollback(seed, base_vars, _owned_meta(instance_dir) | _mentioned(all_actions))

    formal_actions, formal_errors = _parse_paths([p for p in all_paths if p[0] <= floor])
    errors.extend(formal_errors)
    errors.extend(apply_actions(formal_actions, seed))
    write_snapshot(instance_dir, floor, seed)
    return errors


def refresh(instance_dir: Path) -> list[str]:
    """Bring the working store up to date; return any block errors.

    Missing live → hard rebuild; stale suffix → soft recompute; otherwise a no-op.
    Call this after touching a floor file (it is also what the sandbox
    ``Teahouse.refresh`` bridge and every variable read go through).
    """
    if not instance_dir.exists():
        return []  # nothing to compute — and never materialize files for a stray path
    if not live_path(instance_dir).exists():
        return rebuild_hard(instance_dir)
    floor = formal_floor(instance_dir)
    paths = suffix_paths(instance_dir, floor)
    if read_live_meta(instance_dir).get("suffix_hash") != _suffix_hash(paths):
        return recompute_soft(instance_dir)
    return []


def load_store(instance_dir: Path) -> dict[str, dict]:
    """The single fresh-read entry point: bootstrap if needed, recompute if stale.

    Every read/write of variables goes through here so correctness does not depend on
    any external trigger firing (a missed trigger costs one stale read, never a silent
    wrong value).
    """
    refresh(instance_dir)
    return read_live_dict(instance_dir)


# ---------------------------------------------------------------------------
# 全量修复（手动兜底，导演工具 RepairVars）
# ---------------------------------------------------------------------------


def _snapshot_from_text(text: str) -> tuple[int, dict[str, dict]]:
    meta = _meta_from_text(text, "_snapshot")
    try:
        floor = int(meta.get("floor", 0))
    except (TypeError, ValueError):
        floor = 0
    return floor, _parse_var_lines(text)


def _snapshot_at(instance_dir: Path, commit: str) -> tuple[int, dict[str, dict]] | None:
    """Parse the recorded snapshot blob of one commit; None when unreadable."""
    from .git_utils import GitError, _git_run

    try:
        raw = _git_run(["show", f"{commit}:{SNAPSHOT_REL}"], instance_dir, strip=False)
    except GitError:
        return None
    return _snapshot_from_text(raw)


def oldest_usable_snapshot(
    instance_dir: Path, max_floor: int, limit: int = 40
) -> tuple[int, dict[str, dict], str | None, int]:
    """The OLDEST committed snapshot that can anchor this branch, as
    ``(floor, vars, commit, skipped)``.

    A snapshot whose recorded floor is *above* the branch's current formal floor cannot be
    an ancestor here — that happens when the number was inherited from a prototype whose
    floor count does not match the instance (an instance created from a 3-floor prototype
    then gutted to 2 floors). Using it would make the replay range empty and silently
    treat the working store as the answer, so such snapshots are skipped.

    ``(0, {}, None, skipped)`` when none is usable (or the path was never committed) —
    then the repair replays every formal floor from scratch.
    """
    from .git_utils import GitError, _git_run

    try:
        out = _git_run(["log", "--format=%H", "--", SNAPSHOT_REL], instance_dir)
    except GitError:
        return 0, {}, None, 0
    commits = [c for c in out.splitlines() if c.strip()][::-1]  # oldest first
    skipped = 0
    for commit in commits[:limit]:
        parsed = _snapshot_at(instance_dir, commit)
        if parsed is None:
            continue
        floor, vars_ = parsed
        if floor <= max_floor:
            return floor, vars_, commit, skipped
        skipped += 1
    return 0, {}, None, skipped


def full_repair(instance_dir: Path) -> tuple[list[str], dict]:
    """Rebuild the whole variable store from the oldest usable snapshot in git history.

    The normal path anchors at the LATEST snapshot and only replays the floors above it,
    so it is blind to anything at or below that anchor — a damaged or desynced snapshot,
    or an edit to an older formal floor's block. This rewinds to the oldest snapshot that
    can anchor this branch and re-derives everything forward, then re-freezes the snapshot
    at F so the repair is durable.

    The snapshot at F is the base plus the formal floors — with external (non-prose)
    variables taken from the engine's own record of state@F, i.e. the snapshot being
    replaced. It is deliberately NOT taken from the working store, which also carries
    drafts (and leftovers of since-deleted drafts) that do not belong to state@F: that is
    how a variable which did not exist at F used to end up in the authoritative snapshot.
    The working store is then rebuilt as that state plus the drafts above F, keeping its
    own external-only variables. Idempotent. Returns ``(errors, info)``.
    """
    floor = formal_floor(instance_dir)
    base_floor, base_vars, commit, skipped = oldest_usable_snapshot(instance_dir, floor)

    # Every floor above the oldest usable base: the formal ones plus any drafts above F.
    all_paths = suffix_paths(instance_dir, base_floor)
    all_actions, errors = _parse_paths(all_paths)
    owned = _owned_meta(instance_dir) | _mentioned(all_actions)

    old_live = read_live_dict(instance_dir)
    prev_vars = _read_var_dict(snapshot_path(instance_dir))

    # ---- Snapshot at F: base + formal floors; non-prose vars from the previous snapshot.
    seed: dict[str, dict] = {k: dict(v) for k, v in base_vars.items()}
    for name, entry in prev_vars.items():
        if name not in owned:
            seed[name] = dict(entry)
    formal_actions, formal_errors = _parse_paths([p for p in all_paths if p[0] <= floor])
    errors.extend(formal_errors)
    errors.extend(apply_actions(formal_actions, seed))
    write_snapshot(instance_dir, floor, {k: dict(v) for k, v in seed.items()})

    # ---- Working store: that state, plus its own external-only vars, plus the drafts.
    for name, entry in old_live.items():
        if name not in owned:
            seed[name] = dict(entry)
    draft_actions, draft_errors = _parse_paths([p for p in all_paths if p[0] > floor])
    errors.extend(draft_errors)
    errors.extend(apply_actions(draft_actions, seed))
    write_live(instance_dir, seed, current_meta(instance_dir))

    return errors, {
        "base_floor": base_floor,
        "base_commit": commit,
        "skipped": skipped,
        "floor": floor,
        "replayed": [n for n, _p, _d in all_paths if n <= floor],
        "drafts": [n for n, _p, _d in all_paths if n > floor],
        "vars": len(seed),
    }
