"""DM 呈现层 —— `runtime/dm-output.jsonl` 的读写。

DM 的每一轮发言（以及玩家的扮演发言）都追加到这里，作为**玩家可见呈现的唯一事实来源**
（沙盒据此渲染气泡）。与 `.sessions/dm.jsonl` 分离：

- `.sessions/dm.jsonl`：完整对话 + 工具调用 + reasoning，gitignored，只喂 LLM。
- `runtime/dm-output.jsonl`：玩家可见的气泡，tracked，只喂沙盒渲染 / 归档。

约束（见 ignored/dm-design.md）：
- append-only，但**最新批次**可改（`OutputEdit`）——下一轮 user 消息开新批次后冻结。
- 不允许删除。
- `seq` 全局自增，由本模块分配；`batch` 由"开新批次"（玩家扮演发言）决定。

一条记录：`{chara, seq, batch, content, kind?}`
"""
from __future__ import annotations

import json
from pathlib import Path

DM_OUTPUT_REL = "runtime/dm-output.jsonl"

# `user` 为玩家保留值；其余任意字符串（角色名 / narrator / dice …）。
RESERVED_CHARA_USER = "user"


def dm_output_path(instance_dir: Path) -> Path:
    return instance_dir / DM_OUTPUT_REL


def read_messages(instance_dir: Path) -> list[dict]:
    """读全部消息，按文件顺序。坏行跳过。"""
    p = dm_output_path(instance_dir)
    if not p.is_file():
        return []
    out: list[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def _write_all(instance_dir: Path, records: list[dict]) -> None:
    p = dm_output_path(instance_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records),
        encoding="utf-8",
    )


def _int_field(rec: dict, key: str) -> int | None:
    v = rec.get(key)
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    return None


def max_seq(records: list[dict]) -> int:
    return max((_int_field(r, "seq") or 0 for r in records), default=0)


def max_batch(records: list[dict]) -> int:
    return max((_int_field(r, "batch") or 0 for r in records), default=0)


def append_message(
    instance_dir: Path,
    chara: str,
    content: str,
    kind: str | None = None,
) -> dict:
    """追加一条到**当前批次**（`max(batch)`；文件为空则开批次 1）。返回写入的记录。

    `seq` 自增；`batch` 不显式指定——始终落在当前（最新）批次，这样 DM 一轮内的
    多条发言与触发该轮的 user 消息同批、可一起修改。
    """
    records = read_messages(instance_dir)
    batch = max_batch(records) or 1
    rec: dict = {
        "chara": str(chara),
        "seq": max_seq(records) + 1,
        "batch": batch,
        "content": str(content),
    }
    if kind:
        rec["kind"] = str(kind)
    records.append(rec)
    _write_all(instance_dir, records)
    return rec


def append_user_message(instance_dir: Path, content: str) -> dict:
    """玩家**扮演**发言：开新批次并追加（返回新记录）。

    开新批次 = 上一批次从此冻结（视为已确认）。DM 栏的局外发言不走这里。
    """
    records = read_messages(instance_dir)
    rec = {
        "chara": RESERVED_CHARA_USER,
        "seq": max_seq(records) + 1,
        "batch": max_batch(records) + 1,
        "content": str(content),
    }
    records.append(rec)
    _write_all(instance_dir, records)
    return rec


def edit_message(
    instance_dir: Path,
    seq: int,
    old_string: str | None,
    new_string: str,
) -> tuple[bool, str]:
    """改**最新批次内** `seq` 指定的一条。返回 (ok, error)。

    - `old_string` 为空/None → 整体覆写。
    - 非空 → 锚点替换（同 Edit：必须在目标内唯一）。
    - 目标不在最新批次 → 拒绝（历史不可改）。
    """
    records = read_messages(instance_dir)
    if not records:
        return False, "output 为空，无可修改的消息"
    current_batch = max_batch(records)
    idx = next((i for i, r in enumerate(records) if _int_field(r, "seq") == seq), -1)
    if idx < 0:
        return False, f"未找到 seq={seq} 的消息"
    rec = records[idx]
    rec_batch = _int_field(rec, "batch")
    if rec_batch != current_batch:
        return False, (
            f"seq={seq} 属于批次 {rec_batch}，已冻结（当前可改批次 {current_batch}）"
            f"——历史不可改"
        )
    cur = rec.get("content", "")
    if not isinstance(cur, str):
        cur = str(cur)
    if not old_string:
        rec["content"] = new_string
    else:
        n = cur.count(old_string)
        if n == 0:
            return False, f"old_string 未在 seq={seq} 的内容中匹配到"
        if n > 1:
            return False, f"old_string 在 seq={seq} 中出现 {n} 次，不唯一（请给更多上下文）"
        rec["content"] = cur.replace(old_string, new_string, 1)
    _write_all(instance_dir, records)
    return True, ""


def latest_user_seq(instance_dir: Path) -> int | None:
    """最近一条玩家扮演发言的 seq（游玩输入包裹层用）。无则 None。"""
    records = read_messages(instance_dir)
    for rec in reversed(records):
        if rec.get("chara") == RESERVED_CHARA_USER:
            return _int_field(rec, "seq")
    return None
