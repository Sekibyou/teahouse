"""
Session management — tracks the user's currently active instance.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..database.auth import UserInfo, validate_token
from ..database.connection import execute, fetch_one, generate_uuid, current_timestamp


router = APIRouter(prefix="/api/session", tags=["session"])


async def require_user(request: Request) -> UserInfo:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    user = await validate_token(auth[7:])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


class SetActiveRequest(BaseModel):
    instance_id: str


async def _ensure_session_table() -> None:
    await execute("""
        CREATE TABLE IF NOT EXISTS active_sessions (
            user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            instance_id TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        )
    """)


@router.get("/active")
async def get_active_instance(user: UserInfo = Depends(require_user)):
    await _ensure_session_table()
    row = await fetch_one(
        "SELECT s.instance_id, i.name, i.dir_path FROM active_sessions s JOIN instances i ON i.id = s.instance_id WHERE s.user_id = ?",
        (user.user_id,),
    )
    if not row:
        return {"instance": None}
    return {
        "instance": {
            "id": row["instance_id"],
            "name": row["name"],
            "dir_path": row["dir_path"],
        }
    }


@router.put("/active")
async def set_active_instance(body: SetActiveRequest, user: UserInfo = Depends(require_user)):
    await _ensure_session_table()

    # Verify the instance belongs to this user
    inst = await fetch_one(
        "SELECT id FROM instances WHERE id = ? AND user_id = ?",
        (body.instance_id, user.user_id),
    )
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    await execute(
        "INSERT OR REPLACE INTO active_sessions (user_id, instance_id, updated_at) VALUES (?, ?, ?)",
        (user.user_id, body.instance_id, current_timestamp()),
    )
    return {"status": "ok", "instance_id": body.instance_id}
