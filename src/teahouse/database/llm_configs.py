"""
LLM configuration CRUD — encrypted API key storage.
"""
from __future__ import annotations

from typing import Optional

from ..database.connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all
from ..database.crypto import encrypt_value, decrypt_value


# Master key is set at startup from teahouse.yaml
_master_key: str = ""


def configure_crypto(master_key: str) -> None:
    global _master_key
    _master_key = master_key


def _encrypt(plain: str) -> str:
    return encrypt_value(plain, _master_key)


def _decrypt(cipher: str) -> str:
    return decrypt_value(cipher, _master_key)


# ===== CRUD =====

async def create_llm_config(
    user_id: str,
    label: str,
    api_url: str,
    api_key: str,
    model_name: str,
    api_format: str = "openai",
    max_tokens: int = 8192,
    temperature: float = 0.7,
    is_default: bool = False,
) -> dict:
    config_id = generate_uuid()
    now = current_timestamp()
    encrypted = _encrypt(api_key)

    await execute(
        """INSERT INTO llm_configs
           (id, user_id, label, api_url, encrypted_api_key, api_format,
            model_name, max_tokens, temperature, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (config_id, user_id, label, api_url, encrypted, api_format,
         model_name, max_tokens, temperature, 1 if is_default else 0, now, now),
    )
    return await get_llm_config(config_id)


async def get_llm_config(config_id: str) -> Optional[dict]:
    row = await fetch_one("SELECT * FROM llm_configs WHERE id = ?", (config_id,))
    return _decrypt_config(row) if row else None


async def get_default_llm_config(user_id: str) -> Optional[dict]:
    """Get the default LLM config for a user (is_default=1), or the first enabled one."""
    row = await fetch_one(
        "SELECT * FROM llm_configs WHERE user_id = ? AND is_default = 1 AND is_enabled = 1 LIMIT 1",
        (user_id,),
    )
    if row:
        return _decrypt_config(row)
    # fallback: first enabled
    row = await fetch_one(
        "SELECT * FROM llm_configs WHERE user_id = ? AND is_enabled = 1 ORDER BY created_at LIMIT 1",
        (user_id,),
    )
    return _decrypt_config(row) if row else None


async def list_llm_configs(user_id: str) -> list[dict]:
    rows = await fetch_all(
        "SELECT * FROM llm_configs WHERE user_id = ? ORDER BY created_at",
        (user_id,),
    )
    return [_decrypt_config(r) for r in rows]


async def update_llm_config(
    config_id: str,
    label: Optional[str] = None,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model_name: Optional[str] = None,
    api_format: Optional[str] = None,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    is_default: Optional[bool] = None,
    is_enabled: Optional[bool] = None,
) -> bool:
    fields = []
    values = []

    if label is not None:
        fields.append("label = ?"); values.append(label)
    if api_url is not None:
        fields.append("api_url = ?"); values.append(api_url)
    if api_key is not None:
        fields.append("encrypted_api_key = ?"); values.append(_encrypt(api_key))
    if model_name is not None:
        fields.append("model_name = ?"); values.append(model_name)
    if api_format is not None:
        fields.append("api_format = ?"); values.append(api_format)
    if max_tokens is not None:
        fields.append("max_tokens = ?"); values.append(max_tokens)
    if temperature is not None:
        fields.append("temperature = ?"); values.append(temperature)
    if is_default is not None:
        fields.append("is_default = ?"); values.append(1 if is_default else 0)
    if is_enabled is not None:
        fields.append("is_enabled = ?"); values.append(1 if is_enabled else 0)

    if not fields:
        return False

    fields.append("updated_at = ?")
    values.append(current_timestamp())
    values.append(config_id)

    cur = await execute(
        f"UPDATE llm_configs SET {', '.join(fields)} WHERE id = ?",
        tuple(values),
    )
    return cur.rowcount > 0


async def delete_llm_config(config_id: str) -> bool:
    cur = await execute("DELETE FROM llm_configs WHERE id = ?", (config_id,))
    return cur.rowcount > 0


def _decrypt_config(row: dict) -> dict:
    row["api_key"] = _decrypt(row.pop("encrypted_api_key"))
    return row
