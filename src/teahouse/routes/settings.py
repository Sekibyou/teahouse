"""
User-level runtime preference settings API routes.

Persisted per-user in the ``users.preferences`` JSON blob — these are
user-level LLM preferences (retry budget, tool-loop cap), NOT global config.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_MAX_RETRIES = 3
DEFAULT_MAX_TOOL_ROUNDS = 15


# ===== Pydantic models =====

class GlobalSettingsResponse(BaseModel):
    max_retries: int = DEFAULT_MAX_RETRIES
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS


class UpdateGlobalSettingsRequest(BaseModel):
    max_retries: int | None = Field(default=None, ge=0, le=10)
    max_tool_rounds: int | None = Field(default=None, ge=1, le=200)


async def _read_user_settings(user_id: str) -> dict:
    from ..database.users import get_preferences
    prefs = await get_preferences(user_id) or {}
    retries = prefs.get("max_retries")
    rounds = prefs.get("max_tool_rounds")
    return {
        "max_retries": retries if isinstance(retries, int) else DEFAULT_MAX_RETRIES,
        "max_tool_rounds": rounds if isinstance(rounds, int) else DEFAULT_MAX_TOOL_ROUNDS,
    }


# ===== Routes =====

@router.get("", response_model=GlobalSettingsResponse)
async def get_settings(user: UserInfo = Depends(require_user)):
    settings = await _read_user_settings(user.user_id)
    return GlobalSettingsResponse(**settings)


@router.put("", response_model=GlobalSettingsResponse)
async def update_settings(body: UpdateGlobalSettingsRequest, user: UserInfo = Depends(require_user)):
    from ..database.users import set_preference
    if body.max_retries is not None:
        await set_preference(user.user_id, "max_retries", body.max_retries)
    if body.max_tool_rounds is not None:
        await set_preference(user.user_id, "max_tool_rounds", body.max_tool_rounds)

    settings = await _read_user_settings(user.user_id)
    return GlobalSettingsResponse(**settings)
