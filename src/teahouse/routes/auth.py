"""
Auth API routes.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..database.auth import configure_jwt, login, validate_token, UserInfo
from ..database.users import create_user, get_user_by_username, update_user


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
        "user": {
            "user_id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
        },
    }


@router.post("/register")
async def api_register(body: RegisterRequest):
    user = await create_user(body.username, body.password, body.display_name)
    if not user:
        raise HTTPException(status_code=409, detail="Username already exists")

    # Auto-create built-in blank prototype (only once globally, but idempotent)
    try:
        from ..database.workspaces import list_prototypes, create_prototype, register_builtin_prototype_source_path
        from pathlib import Path
        existing = await list_prototypes(user["id"])
        if not any(p["is_builtin"] for p in existing):
            source_path = register_builtin_prototype_source_path(Path("data"))
            await create_prototype(None, "空白模板", "默认空白原型，包含基础目录结构", source_path, is_builtin=True)
    except Exception:
        pass

    token = await login(body.username, body.password)
    return {
        "token": token,
        "user": {
            "user_id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
        },
    }


@router.get("/me")
async def api_get_me(user: UserInfo = Depends(require_user)):
    return {
        "user_id": user.user_id,
        "username": user.username,
        "display_name": user.display_name,
    }


@router.put("/me")
async def api_update_me(body: UpdateMeRequest, user: UserInfo = Depends(require_user)):
    updated = False
    if body.display_name is not None:
        await update_user(user.user_id, display_name=body.display_name)
        updated = True
    if body.old_password and body.new_password:
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
