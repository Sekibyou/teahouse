"""
Model Profile CRUD — parameter presets with optional regex match_pattern.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


async def create_profile(
    user_id: str,
    name: str,
    match_pattern: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 50000,
    max_context: int = 131072,
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    is_builtin: bool = False,
) -> dict:
    profile_id = generate_uuid()
    now = current_timestamp()

    await execute(
        """INSERT INTO model_profiles
           (id, user_id, name, match_pattern, temperature, max_tokens,
            max_context, top_p, frequency_penalty, presence_penalty, is_builtin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, user_id, name, match_pattern, temperature, max_tokens,
         max_context, top_p, frequency_penalty, presence_penalty, int(is_builtin), now, now),
    )
    return await get_profile(profile_id)


async def get_profile(profile_id: str) -> Optional[dict]:
    row = await fetch_one("SELECT * FROM model_profiles WHERE id = ?", (profile_id,))
    return dict(row) if row else None


async def list_profiles(user_id: str) -> list[dict]:
    rows = await fetch_all(
        "SELECT * FROM model_profiles WHERE user_id = ? ORDER BY created_at",
        (user_id,),
    )
    return [dict(r) for r in rows]


async def update_profile(
    profile_id: str,
    name: Optional[str] = None,
    match_pattern: Optional[str] = None,  # None = no change; explicitly set to "" to clear
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    max_context: Optional[int] = None,
    top_p: Optional[float] = None,
    frequency_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
) -> bool:
    fields = []
    values = []

    if name is not None:
        fields.append("name = ?"); values.append(name)
    if match_pattern is not None:
        # Allow clearing by passing empty string, but treat None as "no change"
        fields.append("match_pattern = ?"); values.append(match_pattern if match_pattern else None)
    if temperature is not None:
        fields.append("temperature = ?"); values.append(temperature)
    if max_tokens is not None:
        fields.append("max_tokens = ?"); values.append(max_tokens)
    if max_context is not None:
        fields.append("max_context = ?"); values.append(max_context)
    if top_p is not None:
        fields.append("top_p = ?"); values.append(top_p)
    if frequency_penalty is not None:
        fields.append("frequency_penalty = ?"); values.append(frequency_penalty)
    if presence_penalty is not None:
        fields.append("presence_penalty = ?"); values.append(presence_penalty)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(profile_id)

    cur = await execute(
        f"UPDATE model_profiles SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def delete_profile(profile_id: str) -> bool:
    # Nullify profile_id on models that reference this profile
    await execute(
        "UPDATE llm_models SET profile_id = NULL, updated_at = ? WHERE profile_id = ?",
        (current_timestamp(), profile_id),
    )
    cur = await execute("DELETE FROM model_profiles WHERE id = ?", (profile_id,))
    return cur.rowcount > 0


async def match_profiles(model_name: str, user_id: str) -> list[dict]:
    """Return profiles whose match_pattern regex matches the given model_name."""
    import re
    profiles = await list_profiles(user_id)


async def ensure_builtin_profile(user_id: str) -> dict:
    """Ensure a built-in default profile exists. Returns it."""
    row = await fetch_one(
        "SELECT * FROM model_profiles WHERE user_id = ? AND is_builtin = 1 LIMIT 1",
        (user_id,),
    )
    if row:
        return dict(row)
    return await create_profile(
        user_id=user_id,
        name="默认",
        temperature=0.7,
        max_tokens=50000,
    )


async def get_builtin_profile(user_id: str) -> Optional[dict]:
    row = await fetch_one(
        "SELECT * FROM model_profiles WHERE user_id = ? AND is_builtin = 1 LIMIT 1",
        (user_id,),
    )
    return dict(row) if row else None
    matches = []
    for p in profiles:
        if not p.get("match_pattern"):
            continue
        try:
            if re.search(p["match_pattern"], model_name, re.IGNORECASE):
                matches.append(p)
        except re.error:
            continue
    return matches
