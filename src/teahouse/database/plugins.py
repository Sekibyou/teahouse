"""
Plugin registry CRUD + isolated encrypted data storage.

Plugins are per-user — each user has their own plugins in
data/{user_safe_name}/plugins/. Plugin data is encrypted with the
master key and keyed by (plugin_id, user_id).
"""
from __future__ import annotations

import json
from typing import Optional

from .connection import current_timestamp, generate_uuid, execute, fetch_one, fetch_all
from .crypto import encrypt_value, decrypt_value

_master_key: str = ""


def configure_plugin_crypto(master_key: str) -> None:
    global _master_key
    _master_key = master_key


def _encrypt(plain: str) -> str:
    return encrypt_value(plain, _master_key)


def _decrypt(cipher: str) -> str:
    return decrypt_value(cipher, _master_key)


# ── Plugin registry (per-user) ────────────────────────────────────


async def upsert_plugin(
    user_id: str,
    pid: str,
    name: str,
    version: str,
    description: str = "",
    permissions: list[str] | None = None,
    has_backend: bool = False,
    has_frontend: bool = False,
    source_path: str = "",
) -> dict:
    """Insert or update a plugin for a given user."""
    now = current_timestamp()
    perms_json = json.dumps(permissions or [], ensure_ascii=False)
    existing = await fetch_one(
        "SELECT * FROM plugins WHERE id = ? AND user_id = ?", (pid, user_id)
    )
    if existing:
        await execute(
            """UPDATE plugins SET name=?, version=?, description=?,
               permissions=?, has_backend=?, has_frontend=?, source_path=?, updated_at=?
               WHERE id=? AND user_id=?""",
            (name, version, description, perms_json, int(has_backend), int(has_frontend), source_path, now, pid, user_id),
        )
    else:
        await execute(
            """INSERT INTO plugins (id, user_id, name, version, description, enabled,
               permissions, has_backend, has_frontend, source_path, created_at, updated_at)
               VALUES (?,?,?,?,?,0,?,?,?,?,?,?)""",
            (pid, user_id, name, version, description, perms_json, int(has_backend), int(has_frontend), source_path, now, now),
        )
    row = await fetch_one("SELECT * FROM plugins WHERE id = ? AND user_id = ?", (pid, user_id))
    return dict(row) if row else {}


async def get_plugins(user_id: str) -> list[dict]:
    rows = await fetch_all(
        "SELECT * FROM plugins WHERE user_id = ? ORDER BY name", (user_id,)
    )
    return [_row_to_dict(r) for r in rows]


async def get_plugin(plugin_id: str, user_id: str) -> Optional[dict]:
    row = await fetch_one(
        "SELECT * FROM plugins WHERE id = ? AND user_id = ?", (plugin_id, user_id)
    )
    return _row_to_dict(row) if row else None


async def set_enabled(plugin_id: str, user_id: str, enabled: bool) -> bool:
    now = current_timestamp()
    await execute(
        "UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (int(enabled), now, plugin_id, user_id),
    )
    return True


async def delete_plugin(plugin_id: str, user_id: str) -> bool:
    """Delete a plugin record. Plugin data is cascade-deleted via FK."""
    await execute(
        "DELETE FROM plugins WHERE id = ? AND user_id = ?", (plugin_id, user_id)
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


async def delete_all_plugin_data(plugin_id: str, user_id: str) -> None:
    await execute(
        "DELETE FROM plugin_data WHERE plugin_id = ? AND user_id = ?",
        (plugin_id, user_id),
    )
