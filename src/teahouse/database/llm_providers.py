"""
LLM Provider CRUD — encrypted API key storage.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all
from ..database.crypto import encrypt_value, decrypt_value


_master_key: str = ""


def configure_crypto(master_key: str) -> None:
    global _master_key
    _master_key = master_key


def _encrypt(plain: str) -> str:
    return encrypt_value(plain, _master_key)


def _decrypt(cipher: str) -> str:
    return decrypt_value(cipher, _master_key)


# ===== CRUD =====


async def create_provider(
    user_id: str,
    name: str,
    api_url: str,
    api_key: str,
    api_format: str = "openai",
    model_fetch_url: str = "",
) -> dict:
    provider_id = generate_uuid()
    now = current_timestamp()
    encrypted = _encrypt(api_key)

    await execute(
        """INSERT INTO llm_providers
           (id, user_id, name, api_url, encrypted_api_key, api_format, model_fetch_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (provider_id, user_id, name, api_url, encrypted, api_format, model_fetch_url, now, now),
    )
    return await get_provider(provider_id)


async def get_provider(provider_id: str) -> Optional[dict]:
    row = await fetch_one("SELECT * FROM llm_providers WHERE id = ?", (provider_id,))
    return _decrypt_provider(row) if row else None


async def list_providers(user_id: str) -> list[dict]:
    rows = await fetch_all(
        "SELECT * FROM llm_providers WHERE user_id = ? ORDER BY created_at",
        (user_id,),
    )
    return [_decrypt_provider(r) for r in rows]


async def update_provider(
    provider_id: str,
    name: Optional[str] = None,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    api_format: Optional[str] = None,
    is_enabled: Optional[bool] = None,
    model_fetch_url: Optional[str] = None,
) -> bool:
    fields = []
    values = []

    if name is not None:
        fields.append("name = ?"); values.append(name)
    if api_url is not None:
        fields.append("api_url = ?"); values.append(api_url)
    if api_key is not None:
        fields.append("encrypted_api_key = ?"); values.append(_encrypt(api_key))
    if api_format is not None:
        fields.append("api_format = ?"); values.append(api_format)
    if is_enabled is not None:
        fields.append("is_enabled = ?"); values.append(1 if is_enabled else 0)
    if model_fetch_url is not None:
        fields.append("model_fetch_url = ?"); values.append(model_fetch_url)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(provider_id)

    cur = await execute(
        f"UPDATE llm_providers SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def delete_provider(provider_id: str) -> bool:
    cur = await execute("DELETE FROM llm_providers WHERE id = ?", (provider_id,))
    return cur.rowcount > 0


def _decrypt_provider(row: dict) -> dict:
    row = dict(row)
    row["api_key"] = _decrypt(row.pop("encrypted_api_key"))
    return row
