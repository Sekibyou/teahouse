"""
Auth API routes.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..database.auth import configure_jwt, login, validate_token, UserInfo
from ..database.users import (
    create_user,
    get_user_by_id,
    get_user_by_username,
    update_user,
    verify_password,
    ROLE_USER,
)

# use the shared in-memory config for the registration toggle
from ..state import state


def _user_payload(u: dict) -> dict:
    return {
        "user_id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "role": u.get("role") or "user",
    }


# ---------------------------------------------------------------------------
# FastAPI dependency — extract current user from Authorization header
# ---------------------------------------------------------------------------

async def require_user(request: Request) -> UserInfo:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    user = await validate_token(auth[7:])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


async def require_super(request: Request) -> UserInfo:
    """Require the super admin role (fixed username 'admin')."""
    user = await require_user(request)
    if user.role != "super":
        raise HTTPException(status_code=403, detail="Super admin privileges required")
    return user


async def require_admin_or_super(request: Request) -> UserInfo:
    """Require admin or super role (any user that can manage other users)."""
    user = await require_user(request)
    if user.role not in ("super", "admin"):
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def require_user_for_download(request: Request) -> UserInfo:
    """Auth identical to require_user, but ALSO accepts a `?token=` query param.

    Used by zip-download endpoints that open in a new tab via window.open(url),
    which cannot attach an Authorization header. Header takes precedence; the
    query token is a fallback for direct navigation.
    """
    token = None
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
    if not token:
        token = request.query_params.get("token")
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    user = await validate_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: str = ""


class UpdateMeRequest(BaseModel):
    display_name: Optional[str] = None
    old_password: Optional[str] = None
    new_password: Optional[str] = None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
async def api_login(body: LoginRequest):
    token = await login(body.username, body.password)
    if not token:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user = await get_user_by_username(body.username)
    return {
        "token": token,
        "user": _user_payload(user),
    }


@router.post("/register")
async def api_register(body: RegisterRequest):
    cfg = state.config
    if cfg is None or not cfg.auth.allow_registration:
        raise HTTPException(status_code=403, detail="注册功能未开放，请联系管理员在 teahouse.yaml 中开启")
    user = await create_user(body.username, body.password, body.display_name, role=ROLE_USER)
    if not user:
        raise HTTPException(status_code=409, detail="Username already exists")

    # Auto-register all built-in prototypes for the new user
    try:
        from ..database.workspaces import list_prototypes, create_prototype, list_builtin_prototype_dirs, read_prototype_readme, BUILTIN_PROTOTYPE_REGISTRY
        from pathlib import Path
        builtin_dirs = list_builtin_prototype_dirs()
        existing = await list_prototypes()
        for proto_dir in builtin_dirs:
            name = BUILTIN_PROTOTYPE_REGISTRY.get(proto_dir.name, proto_dir.name)
            readme = read_prototype_readme(proto_dir)
            description = "" if proto_dir.name in BUILTIN_PROTOTYPE_REGISTRY \
                else (readme.strip().split("\n")[0].lstrip("#").strip() if readme else name)
            source_path = str(proto_dir.resolve())

            if not any(p["is_builtin"] and Path(p["source_path"]).resolve() == proto_dir.resolve() for p in existing):
                await create_prototype(None, name, description, source_path, is_builtin=True)
    except Exception:
        pass

    token = await login(body.username, body.password)
    return {
        "token": token,
        "user": _user_payload(user),
    }


@router.get("/me")
async def api_get_me(user: UserInfo = Depends(require_user)):
    return {
        "user_id": user.user_id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
    }


@router.put("/me")
async def api_update_me(body: UpdateMeRequest, user: UserInfo = Depends(require_user)):
    updated = False
    if body.display_name is not None:
        await update_user(user.user_id, display_name=body.display_name)
        updated = True
    if body.new_password:
        if not body.old_password:
            raise HTTPException(status_code=400, detail="Old password required to change password")
        account = await get_user_by_id(user.user_id)
        if not account or not verify_password(body.old_password, account["hashed_password"]):
            raise HTTPException(status_code=400, detail="Old password incorrect")
        ok = await update_user(user.user_id, password=body.new_password)
        if not ok:
            raise HTTPException(status_code=400, detail="Password change failed")
        updated = True
    if not updated:
        raise HTTPException(status_code=400, detail="No fields to update")
    return {"status": "ok"}


@router.post("/logout")
async def api_logout():
    # JWT is stateless — frontend just discards the token
    return {"status": "ok"}
