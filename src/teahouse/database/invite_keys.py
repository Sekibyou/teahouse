"""
Invite-key operations for invite-only registration.
"""
from __future__ import annotations

import secrets
from typing import Optional

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all


def generate_invite_key() -> str:
    """A random, unguessable invite key (URL-safe, 32 chars)."""
    return secrets.token_urlsafe(24)


async def create_invite_key(issued_by: str) -> dict:
    """Issue a fresh unused invite key. Returns the full row."""
    key = generate_invite_key()
    row_id = generate_uuid()
    now = current_timestamp()
    await execute(
        "INSERT INTO invite_keys (id, key, issued_by, created_at) VALUES (?, ?, ?, ?)",
        (row_id, key, issued_by, now),
    )
    return await fetch_one("SELECT * FROM invite_keys WHERE id = ?", (row_id,))


async def list_active_invite_keys() -> list[dict]:
    """All currently-usable keys (unused and un-revoked), newest first."""
    return await fetch_all(
        "SELECT * FROM invite_keys WHERE used_at IS NULL AND revoked_at IS NULL "
        "ORDER BY created_at DESC"
    )


async def get_invite_key_by_id(key_id: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM invite_keys WHERE id = ?", (key_id,))


async def consume_invite_key(key: str, used_by: str) -> bool:
    """Atomically mark an invite key as used.

    Only succeeds if the key exists and is still unused and un-revoked, so two
    concurrent registrations racing on the same key cannot both win. Returns True
    if this call won the key (and may proceed to create the user).

    The register route consumes with a placeholder owner first to win the key,
    then calls ``attribute_invite_key`` with the real user id once created.
    """
    cur = await execute(
        "UPDATE invite_keys SET used_at = ?, used_by = ? "
        "WHERE key = ? AND used_at IS NULL AND revoked_at IS NULL",
        (current_timestamp(), used_by, key),
    )
    return cur.rowcount > 0


async def attribute_invite_key(key: str, used_by: str) -> None:
    """Attach the real user id to a key already marked used by a placeholder.

    No-op if the key is gone or was already attributed by someone else.
    """
    await execute(
        "UPDATE invite_keys SET used_by = ? WHERE key = ? AND used_by = '__pending__'",
        (used_by, key),
    )


async def revoke_invite_key(key_id: str, revoked_by: str) -> bool:
    """Revoke an invite key (only if still unused). Returns True if revoked."""
    cur = await execute(
        "UPDATE invite_keys SET revoked_at = ?, revoked_by = ? "
        "WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
        (current_timestamp(), revoked_by, key_id),
    )
    return cur.rowcount > 0
