"""
LLM Slot Bindings CRUD — user-level mapping of slot_id → model_id.
Fixed slots: 'mainstream', 'top_tier'.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import current_timestamp, execute, fetch_one, fetch_all


VALID_SLOTS = {"director", "writer"}


async def set_slot_binding(user_id: str, slot_id: str, model_id: Optional[str]) -> bool:
    """Upsert a single slot binding. model_id can be None to clear."""
    if slot_id not in VALID_SLOTS:
        raise ValueError(f"Invalid slot_id: {slot_id}. Must be one of {VALID_SLOTS}")

    now = current_timestamp()
    existing = await fetch_one(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ? AND slot_id = ?",
        (user_id, slot_id),
    )

    if existing:
        await execute(
            "UPDATE llm_slot_bindings SET model_id = ?, updated_at = ? WHERE user_id = ? AND slot_id = ?",
            (model_id, now, user_id, slot_id),
        )
    else:
        await execute(
            "INSERT INTO llm_slot_bindings (user_id, slot_id, model_id, updated_at) VALUES (?, ?, ?, ?)",
            (user_id, slot_id, model_id, now),
        )
    return True


async def set_all_slot_bindings(user_id: str, bindings: dict[str, Optional[str]]) -> dict:
    """Set all slot bindings at once. bindings = {slot_id: model_id | None}."""
    for slot_id in bindings:
        if slot_id not in VALID_SLOTS:
            raise ValueError(f"Invalid slot_id: {slot_id}")

    for slot_id, model_id in bindings.items():
        await set_slot_binding(user_id, slot_id, model_id)

    return await get_all_slot_bindings(user_id)


async def get_slot_binding(user_id: str, slot_id: str) -> Optional[dict]:
    if slot_id not in VALID_SLOTS:
        return None
    row = await fetch_one(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ? AND slot_id = ?",
        (user_id, slot_id),
    )
    return dict(row) if row else None


async def get_all_slot_bindings(user_id: str) -> dict[str, Optional[str]]:
    """Returns {slot_id: model_id | None} for all defined slots."""
    rows = await fetch_all(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ?",
        (user_id,),
    )
    result: dict[str, Optional[str]] = {s: None for s in VALID_SLOTS}
    for row in rows:
        slot_id = row["slot_id"]
        if slot_id in VALID_SLOTS:
            result[slot_id] = row["model_id"]
    return result


async def clear_slot_binding(user_id: str, slot_id: str) -> bool:
    """Clear a slot binding (set model_id to NULL)."""
    if slot_id not in VALID_SLOTS:
        return False
    await set_slot_binding(user_id, slot_id, None)
    return True
