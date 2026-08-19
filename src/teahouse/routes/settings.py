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
DEFAULT_MAX_PARSE_DEPTH = 10

# Placeholder parse-depth is consumed in hot paths (Generate @mention snapshot,
# director system-prompt assembly) that import this helper directly; keeping it
# here (not in app.py) avoids an app <-> tools import cycle.
async def _user_max_parse_depth(user_id: str | None) -> int:
    """Per-user placeholder resolution depth (users.preferences). Falls back to default 10."""
    if user_id:
        from ..database.users import get_preferences
        prefs = await get_preferences(user_id) or {}
        v = prefs.get("max_parse_depth")
        if isinstance(v, int):
            return int(v)
    return DEFAULT_MAX_PARSE_DEPTH


# ===== Pydantic models =====

class GlobalSettingsResponse(BaseModel):
    max_retries: int = DEFAULT_MAX_RETRIES
    max_tool_rounds: int = DEFAULT_MAX_TOOL_ROUNDS
    max_parse_depth: int = DEFAULT_MAX_PARSE_DEPTH


class UpdateGlobalSettingsRequest(BaseModel):
    max_retries: int | None = Field(default=None, ge=0, le=10)
    max_tool_rounds: int | None = Field(default=None, ge=1, le=200)
    max_parse_depth: int | None = Field(default=None, ge=0, le=30)


async def _read_user_settings(user_id: str) -> dict:
    from ..database.users import get_preferences
    prefs = await get_preferences(user_id) or {}
    retries = prefs.get("max_retries")
    rounds = prefs.get("max_tool_rounds")
    parse_depth = prefs.get("max_parse_depth")
    return {
        "max_retries": retries if isinstance(retries, int) else DEFAULT_MAX_RETRIES,
        "max_tool_rounds": rounds if isinstance(rounds, int) else DEFAULT_MAX_TOOL_ROUNDS,
        "max_parse_depth": parse_depth if isinstance(parse_depth, int) else DEFAULT_MAX_PARSE_DEPTH,
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
    if body.max_parse_depth is not None:
        await set_preference(user.user_id, "max_parse_depth", body.max_parse_depth)

    settings = await _read_user_settings(user.user_id)
    return GlobalSettingsResponse(**settings)
