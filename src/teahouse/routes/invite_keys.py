"""
Invite-key management API — for admin / super admin roles.

Lets admins issue invite keys (usable when auth.registration_mode == "invite"),
list currently-usable keys, and revoke keys that haven't been used yet. Keys are
decoupled from the registration mode so admins can pre-generate a batch before
flipping to invite mode.

Consumption semantics: on successful registration the key is marked used
(used_at/used_by), so it leaves the "unused" list but stays in the DB for audit.
The list here only shows unused + un-revoked keys (decision: no history view).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database.auth import UserInfo
from ..database.invite_keys import (
    create_invite_key,
    list_active_invite_keys,
    get_invite_key_by_id,
    revoke_invite_key,
)
from ..database.connection import fetch_all
from .auth import require_admin_or_super


router = APIRouter(prefix="/api/invite-keys", tags=["invite-keys"])


def _public(row: dict) -> dict:
    return {
        "id": row["id"],
        "key": row["key"],
        "issued_by": row["issued_by"],
        "issued_by_username": row.get("issued_by_username"),
        "created_at": row["created_at"],
    }


@router.get("")
async def api_list_invite_keys(actor: UserInfo = Depends(require_admin_or_super)):
    """List currently-usable invite keys (unused + un-revoked), newest first."""
    rows = await list_active_invite_keys()
    if not rows:
        return []
    # Resolve issuers in one query instead of one per key.
    ids = {r["issued_by"] for r in rows}
    placeholders = ",".join("?" for _ in ids)
    users = await fetch_all(
        f"SELECT id, username FROM users WHERE id IN ({placeholders})",
        tuple(ids),
    )
    username_by_id = {u["id"]: u["username"] for u in users}
    result = []
    for r in rows:
        item = _public(r)
        item["issued_by_username"] = username_by_id.get(r["issued_by"])
        result.append(item)
    return result


@router.post("")
async def api_create_invite_key(actor: UserInfo = Depends(require_admin_or_super)):
    """Issue a new invite key attributed to the calling admin/super."""
    row = await create_invite_key(actor.user_id)
    item = _public(row)
    item["issued_by_username"] = actor.username
    return item


@router.delete("/{key_id}")
async def api_revoke_invite_key(
    key_id: str,
    actor: UserInfo = Depends(require_admin_or_super),
):
    """Revoke an unused invite key (soft-delete). Already-used keys cannot be revoked."""
    row = await get_invite_key_by_id(key_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invite key not found")
    if row["used_at"] is not None:
        raise HTTPException(status_code=400, detail="Cannot revoke an already-used invite key")
    if not await revoke_invite_key(key_id, actor.user_id):
        raise HTTPException(status_code=400, detail="Invite key is no longer usable")
    return {"status": "ok"}
