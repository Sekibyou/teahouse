"""
LLM Slot Bindings CRUD — user-level mapping of slot_id → model_id/profile_id/prompt_preset_id.
Fixed slots: 'director', 'writer'.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import current_timestamp, execute, fetch_one, fetch_all


VALID_SLOTS = {"director", "writer"}


async def set_slot_binding(
    user_id: str,
    slot_id: str,
    model_id: Optional[str] = None,
    profile_id: Optional[str] = None,
    prompt_preset_id: Optional[str] = None,
) -> bool:
    """Upsert a single slot binding. All *_id fields are optional — omit to keep existing or pass None to clear."""
    if slot_id not in VALID_SLOTS:
        raise ValueError(f"Invalid slot_id: {slot_id}. Must be one of {VALID_SLOTS}")

    now = current_timestamp()
    existing = await fetch_one(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ? AND slot_id = ?",
        (user_id, slot_id),
    )

    if existing:
        await execute(
            "UPDATE llm_slot_bindings SET model_id = ?, profile_id = ?, prompt_preset_id = ?, updated_at = ? WHERE user_id = ? AND slot_id = ?",
            (model_id, profile_id, prompt_preset_id, now, user_id, slot_id),
        )
    else:
        await execute(
            "INSERT INTO llm_slot_bindings (user_id, slot_id, model_id, profile_id, prompt_preset_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, slot_id, model_id, profile_id, prompt_preset_id, now),
        )
    return True


async def set_all_slot_bindings(
    user_id: str,
    bindings: dict[str, dict[str, Optional[str]]],
) -> dict:
    """Set all slot bindings at once. bindings = {slot_id: {model_id, profile_id, prompt_preset_id}}."""
    for slot_id in bindings:
        if slot_id not in VALID_SLOTS:
            raise ValueError(f"Invalid slot_id: {slot_id}")

    for slot_id, fields in bindings.items():
        await set_slot_binding(
            user_id, slot_id,
            model_id=fields.get("model_id"),
            profile_id=fields.get("profile_id"),
            prompt_preset_id=fields.get("prompt_preset_id"),
        )

    return await get_all_slot_bindings(user_id)


async def get_slot_binding(user_id: str, slot_id: str) -> Optional[dict]:
    if slot_id not in VALID_SLOTS:
        return None
    row = await fetch_one(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ? AND slot_id = ?",
        (user_id, slot_id),
    )
    return dict(row) if row else None


async def get_all_slot_bindings(user_id: str) -> dict[str, dict[str, Optional[str]]]:
    """Returns {slot_id: {model_id, profile_id, prompt_preset_id}} for all defined slots."""
    rows = await fetch_all(
        "SELECT * FROM llm_slot_bindings WHERE user_id = ?",
        (user_id,),
    )
    result: dict[str, dict[str, Optional[str]]] = {
        s: {"model_id": None, "profile_id": None, "prompt_preset_id": None}
        for s in VALID_SLOTS
    }
    for row in rows:
        slot_id = row["slot_id"]
        if slot_id in VALID_SLOTS:
            result[slot_id] = {
                "model_id": row["model_id"],
                "profile_id": row["profile_id"],
                "prompt_preset_id": row.get("prompt_preset_id"),
            }
    return result


async def clear_slot_binding(user_id: str, slot_id: str) -> bool:
    """Clear a slot binding (set all fields to NULL)."""
    if slot_id not in VALID_SLOTS:
        return False
    await set_slot_binding(user_id, slot_id, None, None, None)
    return True


async def get_slot_binding_resolved(user_id: str, slot_id: str) -> Optional[dict]:
    """Return a fully resolved slot binding with joined model/provider/profile/prompt_preset data."""
    if slot_id not in VALID_SLOTS:
        return None

    row = await fetch_one(
        """SELECT
            s.slot_id, s.model_id, s.profile_id, s.prompt_preset_id,
            m.name as model_name, m.model_name as model_api_name, m.provider_id as model_provider_id, m.is_enabled,
            p.name as provider_name, p.api_url, p.encrypted_api_key, p.api_format, p.is_enabled as provider_enabled,
            mp.name as profile_name, mp.temperature, mp.max_tokens, mp.max_context, mp.top_p, mp.frequency_penalty, mp.presence_penalty,
            dpp.name as preset_name, dpp.template_yaml as preset_template_yaml
        FROM llm_slot_bindings s
        LEFT JOIN llm_models m ON s.model_id = m.id
        LEFT JOIN llm_providers p ON m.provider_id = p.id
        LEFT JOIN model_profiles mp ON s.profile_id = mp.id
        LEFT JOIN director_prompt_presets dpp ON s.prompt_preset_id = dpp.id
        WHERE s.user_id = ? AND s.slot_id = ?""",
        (user_id, slot_id),
    )
    return dict(row) if row else None

