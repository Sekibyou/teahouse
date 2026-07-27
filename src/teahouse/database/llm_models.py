"""
LLM Model CRUD — model entries that reference a provider and a profile.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


async def create_model(
    user_id: str,
    name: str,
    provider_id: str,
    model_name: str,
    profile_id: Optional[str] = None,
    is_enabled: bool = True,
) -> dict:
    model_id = generate_uuid()
    now = current_timestamp()

    await execute(
        """INSERT INTO llm_models
           (id, user_id, name, provider_id, model_name, profile_id, is_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (model_id, user_id, name, provider_id, model_name, profile_id,
         1 if is_enabled else 0, now, now),
    )
    return await get_model(model_id)


async def get_model(model_id: str) -> Optional[dict]:
    row = await fetch_one(
        """SELECT m.*, p.name AS provider_name, p.api_format AS provider_api_format,
                  p.api_url AS provider_api_url
           FROM llm_models m
           JOIN llm_providers p ON m.provider_id = p.id
           WHERE m.id = ?""",
        (model_id,),
    )
    return dict(row) if row else None


async def list_models(user_id: str) -> list[dict]:
    rows = await fetch_all(
        """SELECT m.*, p.name AS provider_name, p.api_format AS provider_api_format,
                  p.api_url AS provider_api_url
           FROM llm_models m
           JOIN llm_providers p ON m.provider_id = p.id
           WHERE m.user_id = ?
           ORDER BY m.created_at""",
        (user_id,),
    )
    return [dict(r) for r in rows]


async def get_enabled_models(user_id: str) -> list[dict]:
    rows = await fetch_all(
        """SELECT m.*, p.name AS provider_name, p.api_format AS provider_api_format,
                  p.api_url AS provider_api_url
           FROM llm_models m
           JOIN llm_providers p ON m.provider_id = p.id
           WHERE m.user_id = ? AND m.is_enabled = 1
           ORDER BY m.created_at""",
        (user_id,),
    )
    return [dict(r) for r in rows]


async def update_model(
    model_id: str,
    name: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_name: Optional[str] = None,
    profile_id: Optional[str] = None,
    is_enabled: Optional[bool] = None,
) -> bool:
    fields = []
    values = []

    if name is not None:
        fields.append("name = ?"); values.append(name)
    if provider_id is not None:
        fields.append("provider_id = ?"); values.append(provider_id)
    if model_name is not None:
        fields.append("model_name = ?"); values.append(model_name)
    if profile_id is not None:
        fields.append("profile_id = ?"); values.append(profile_id)
    if is_enabled is not None:
        fields.append("is_enabled = ?"); values.append(1 if is_enabled else 0)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(model_id)

    cur = await execute(
        f"UPDATE llm_models SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def delete_model(model_id: str) -> bool:
    cur = await execute("DELETE FROM llm_models WHERE id = ?", (model_id,))
    return cur.rowcount > 0


async def delete_models_batch(model_ids: list[str]) -> tuple[list[str], list[str]]:
    """Batch delete models. Returns (deleted_ids, not_found_ids)."""
    deleted = []
    not_found = []
    for mid in model_ids:
        cur = await execute("DELETE FROM llm_models WHERE id = ?", (mid,))
        if cur.rowcount > 0:
            deleted.append(mid)
        else:
            not_found.append(mid)
    return deleted, not_found


async def batch_bind_profile(bindings: dict[str, str]) -> list[str]:
    """Batch bind profiles to models. bindings = {model_id: profile_id}. Returns updated model IDs."""
    now = current_timestamp()
    updated = []
    for model_id, profile_id in bindings.items():
        cur = await execute(
            "UPDATE llm_models SET profile_id = ?, updated_at = ? WHERE id = ?",
            (profile_id, now, model_id),
        )
        if cur.rowcount > 0:
            updated.append(model_id)
    return updated
