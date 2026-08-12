"""
Model Profile API routes.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..database.model_profiles import (
    create_profile, get_profile, list_profiles,
    update_profile, delete_profile, match_profiles, ensure_builtin_profile,
)
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/llm/profiles", tags=["llm-profiles"])


# ===== Pydantic models =====

class CreateProfileRequest(BaseModel):
    name: str
    match_pattern: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 50000
    max_context: int = 131072
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None


class UpdateProfileRequest(BaseModel):
    name: Optional[str] = None
    match_pattern: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    max_context: Optional[int] = None
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None


# ===== Helper =====

def _profile_ownership_check(profile, user_id):
    if not profile or profile["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Profile not found")


def _validate_regex(pattern: str):
    try:
        re.compile(pattern)
    except re.error as e:
        raise HTTPException(status_code=400, detail=f"Invalid regex pattern: {e}")


# ===== Routes =====

@router.get("/")
async def api_list_profiles(user: UserInfo = Depends(require_user)):
    await ensure_builtin_profile(user.user_id)
    profiles = await list_profiles(user.user_id)
    return {"profiles": profiles}


@router.post("/")
async def api_create_profile(body: CreateProfileRequest, user: UserInfo = Depends(require_user)):
    if body.match_pattern:
        _validate_regex(body.match_pattern)
    profile = await create_profile(
        user_id=user.user_id,
        name=body.name,
        match_pattern=body.match_pattern.strip() if body.match_pattern else None,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        top_p=body.top_p,
        frequency_penalty=body.frequency_penalty,
        presence_penalty=body.presence_penalty,
    )
    return {"profile": profile}


@router.get("/match")
async def api_match_profiles(
    model_name: str = Query(..., description="Model name to match against profile patterns"),
    user: UserInfo = Depends(require_user),
):
    matches = await match_profiles(model_name, user.user_id)
    return {"matches": matches}


@router.get("/{profile_id}")
async def api_get_profile(profile_id: str, user: UserInfo = Depends(require_user)):
    profile = await get_profile(profile_id)
    _profile_ownership_check(profile, user.user_id)
    return {"profile": profile}


@router.put("/{profile_id}")
async def api_update_profile(profile_id: str, body: UpdateProfileRequest, user: UserInfo = Depends(require_user)):
    profile = await get_profile(profile_id)
    _profile_ownership_check(profile, user.user_id)
    if profile.get("is_builtin"):
        raise HTTPException(status_code=403, detail="Cannot edit built-in profile")

    if body.match_pattern is not None and body.match_pattern:
        _validate_regex(body.match_pattern)

    kwargs = body.model_dump(exclude_none=True)
    if "match_pattern" in kwargs and kwargs["match_pattern"] is not None:
        kwargs["match_pattern"] = kwargs["match_pattern"].strip() or None

    ok = await update_profile(profile_id, **kwargs)
    if not ok:
        raise HTTPException(status_code=400, detail="No fields to update")
    return {"profile": await get_profile(profile_id)}


@router.delete("/{profile_id}")
async def api_delete_profile(profile_id: str, user: UserInfo = Depends(require_user)):
    profile = await get_profile(profile_id)
    _profile_ownership_check(profile, user.user_id)
    if profile.get("is_builtin"):
        raise HTTPException(status_code=403, detail="Cannot delete built-in profile")
    await delete_profile(profile_id)
    return {"status": "ok"}