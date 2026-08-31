"""
User management API — for admin / super admin roles.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..database.users import (
    create_user,
    get_user_by_id,
    list_users,
    update_user,
    ROLE_SUPER,
    ROLE_ADMIN,
    ROLE_USER,
    ROLES,
)
from ..database.auth import UserInfo
from .auth import require_user, require_admin_or_super


router = APIRouter(prefix="/api/users", tags=["users"])

SUPERNAME = "admin"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    display_name: str = ""
    role: str = ROLE_USER


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    old_password: Optional[str] = None


# ---------------------------------------------------------------------------
# Permission helpers
# ---------------------------------------------------------------------------

def _forbid(msg: str) -> HTTPException:
    return HTTPException(status_code=403, detail=msg)


def _can_set_role(actor: UserInfo) -> bool:
    """Only super can grant/revoke admin or super (admin cannot appoint admins)."""
    return actor.role == ROLE_SUPER


async def _get_target(target_id: str) -> dict:
    user = await get_user_by_id(target_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _public(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "role": user["role"],
        "is_active": bool(user["is_active"]),
        "created_at": user["created_at"],
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def api_list_users(actor: UserInfo = Depends(require_user)):
    users = await list_users()
    # 普通用户只能看到并管理自己（改显示名/改密），看不到其他账户
    if actor.role == ROLE_USER:
        users = [u for u in users if u["id"] == actor.user_id]
    return [_public(u) for u in users]


@router.post("")
async def api_create_user(
    body: CreateUserRequest,
    actor: UserInfo = Depends(require_admin_or_super),
):
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"invalid role: {body.role}")
    if body.role != ROLE_USER and not _can_set_role(actor):
        raise _forbid("only the super admin can grant admin role")

    # Namespace collision: super admin username is reserved
    if body.username == SUPERNAME:
        raise HTTPException(status_code=409, detail=f"username {SUPERNAME!r} is reserved for the super admin")

    user = await create_user(body.username, body.password, body.display_name, role=body.role)
    if not user:
        raise HTTPException(status_code=409, detail="Username already exists")
    return _public(user)


@router.patch("/{target_id}")
async def api_update_user(
    target_id: str,
    body: UpdateUserRequest,
    actor: UserInfo = Depends(require_user),
):
    target = await _get_target(target_id)
    is_self = target["id"] == actor.user_id
    is_super = actor.role == ROLE_SUPER

    # Any role-change request is super-only... except it can never demote the
    # super account itself.
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(status_code=400, detail=f"invalid role: {body.role}")
        if not is_super:
            raise _forbid("only the super admin can change user roles")
        if target["role"] == ROLE_SUPER:
            raise _forbid("cannot change the super admin's role")
        await update_user(target["id"], role=body.role)

    # Non-super admin can only touch regular users; cannot touch fellow admins
    if not is_self and not is_super:
        if actor.role != ROLE_ADMIN or target["role"] != ROLE_USER:
            raise _forbid("admins can only manage regular users")

    if body.display_name is not None:
        await update_user(target["id"], display_name=body.display_name)
    if body.password is not None:
        if len(body.password) < 1:
            raise HTTPException(status_code=400, detail="password required")
        # A plain user changing their own password must prove the old password
        # (admins/super changing others, or themselves, are trusted bypass).
        if actor.role == ROLE_USER:
            from ..database.users import verify_password
            if not body.old_password or not verify_password(
                body.old_password, target["hashed_password"]
            ):
                raise HTTPException(status_code=400, detail="Old password incorrect")
        await update_user(target["id"], password=body.password)

    return _public(await _get_target(target_id))


@router.delete("/{target_id}")
async def api_delete_user(
    target_id: str,
    actor: UserInfo = Depends(require_admin_or_super),
):
    target = await _get_target(target_id)
    if target["role"] == ROLE_SUPER:
        raise _forbid("cannot delete the super admin")
    if target["id"] == actor.user_id:
        raise _forbid("cannot delete yourself")
    if actor.role == ROLE_ADMIN and target["role"] != ROLE_USER:
        raise _forbid("admins can only delete regular users")

    # Cascade: workspaces, api keys, llm configs are FK-referenced
    from ..database.connection import execute
    await execute("DELETE FROM users WHERE id = ?", (target["id"],))
    return {"status": "ok"}
