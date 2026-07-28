"""
Plugin registry CRUD + isolated encrypted data storage.

Plugin data is encrypted with the master key — same as LLM API keys.
Different plugins cannot access each other's data at the DB query level.
"""
from __future__ import annotations

import json
from typing import Optional

from .connection import current_timestamp, generate_uuid, execute, fetch_one, fetch_all
from .crypto import encrypt_value, decrypt_value

# Set by app startup via configure_plugin_crypto()
_master_key: str = ""


def configure_plugin_crypto(master_key: str) -> None:
    global _master_key
    _master_key = master_key


def _encrypt(plain: str) -> str:
    return encrypt_value(plain, _master_key)


def _decrypt(cipher: str) -> str:
    return decrypt_value(cipher, _master_key)


# ── Plugin registry ──────────────────────────────────────────────


async def upsert_plugin(
    pid: str,
    name: str,
    version: str,
    description: str = "",
    permissions: list[str] | None = None,
    has_backend: bool = False,
    has_frontend: bool = False,
) -> dict:
    """Insert or update a plugin detected during scanning."""
    now = current_timestamp()
    perms_json = json.dumps(permissions or [], ensure_ascii=False)
    existing = await fetch_one("SELECT * FROM plugins WHERE id = ?", (pid,))
    if existing:
        await execute(
            """UPDATE plugins SET name=?, version=?, description=?,
               permissions=?, has_backend=?, has_frontend=?, updated_at=?
               WHERE id=?""",
            (name, version, description, perms_json, int(has_backend), int(has_frontend), now, pid),
        )
    else:
        await execute(
            """INSERT INTO plugins (id, name, version, description, enabled,
               permissions, has_backend, has_frontend, created_at, updated_at)
               VALUES (?,?,?,?,0,?,?,?,?,?)""",
            (pid, name, version, description, perms_json, int(has_backend), int(has_frontend), now, now),
        )
    row = await fetch_one("SELECT * FROM plugins WHERE id = ?", (pid,))
    return dict(row) if row else {}


async def get_plugins() -> list[dict]:
    rows = await fetch_all("SELECT * FROM plugins ORDER BY name")
    return [_row_to_dict(r) for r in rows]


async def get_plugin(plugin_id: str) -> Optional[dict]:
    row = await fetch_one("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
    return _row_to_dict(row) if row else None


async def set_enabled(plugin_id: str, enabled: bool) -> bool:
    now = current_timestamp()
    await execute(
        "UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?",
        (int(enabled), now, plugin_id),
    )
    return True


def _row_to_dict(row: dict) -> dict:
    d = dict(row)
    if "permissions" in d and isinstance(d["permissions"], str):
        try:
            d["permissions"] = json.loads(d["permissions"])
        except json.JSONDecodeError:
            d["permissions"] = []
    return d


# ── Plugin data (encrypted) ──────────────────────────────────────


async def get_plugin_data(plugin_id: str, user_id: str) -> dict[str, str]:
    """Return all key-value pairs for a plugin+user, decrypted."""
    rows = await fetch_all(
        "SELECT key, value FROM plugin_data WHERE plugin_id = ? AND user_id = ?",
        (plugin_id, user_id),
    )
    result: dict[str, str] = {}
    for r in rows:
        try:
            result[r["key"]] = _decrypt(r["value"])
        except Exception:
            result[r["key"]] = ""
    return result


async def set_plugin_data(plugin_id: str, user_id: str, key: str, value: str) -> None:
    """Upsert a single key-value pair for a plugin+user."""
    now = current_timestamp()
    encrypted = _encrypt(value)
    existing = await fetch_one(
        "SELECT * FROM plugin_data WHERE plugin_id = ? AND user_id = ? AND key = ?",
        (plugin_id, user_id, key),
    )
    if existing:
        await execute(
            "UPDATE plugin_data SET value = ?, updated_at = ? WHERE plugin_id = ? AND user_id = ? AND key = ?",
            (encrypted, now, plugin_id, user_id, key),
        )
    else:
        await execute(
            "INSERT INTO plugin_data (plugin_id, user_id, key, value, updated_at) VALUES (?,?,?,?,?)",
            (plugin_id, user_id, key, encrypted, now),
        )


async def delete_plugin_data(plugin_id: str, user_id: str, key: str) -> bool:
    await execute(
        "DELETE FROM plugin_data WHERE plugin_id = ? AND user_id = ? AND key = ?",
        (plugin_id, user_id, key),
    )
    return True
