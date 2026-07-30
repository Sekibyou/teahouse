"""
Application-level settings API routes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
import yaml

from ..config import Config
from ..routes.auth import require_user, UserInfo
from ..state import state

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ===== Pydantic models =====

class GlobalSettingsResponse(BaseModel):
    max_retries: int = 3


class UpdateGlobalSettingsRequest(BaseModel):
    max_retries: int | None = Field(default=None, ge=0, le=10)


# ===== Routes =====

@router.get("", response_model=GlobalSettingsResponse)
async def get_settings(_user: UserInfo = Depends(require_user)):
    cfg = state.config
    llm = cfg.llm if cfg else None
    return GlobalSettingsResponse(
        max_retries=llm.max_retries if llm else 3,
    )


@router.put("", response_model=GlobalSettingsResponse)
async def update_settings(body: UpdateGlobalSettingsRequest, _user: UserInfo = Depends(require_user)):
    cfg = state.config
    if not cfg:
        raise HTTPException(status_code=500, detail="Config not loaded")

    path = Config.default_path()
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    if body.max_retries is not None:
        data.setdefault("llm", {})["max_retries"] = body.max_retries

    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    # Reload config so the change takes immediate effect
    state.config = Config.load_or_create(path)

    llm = state.config.llm
    return GlobalSettingsResponse(
        max_retries=llm.max_retries if llm else 3,
    )
