"""
Director Prompt Preset API routes.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database.director_prompt_presets import (
    create_preset, get_preset, list_presets,
    update_preset, delete_preset, ensure_builtin_preset,
)
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/llm/prompt-presets", tags=["llm-prompt-presets"])


class CreatePresetRequest(BaseModel):
    name: str
    template_yaml: str
    match_pattern: Optional[str] = None


class UpdatePresetRequest(BaseModel):
    name: Optional[str] = None
    template_yaml: Optional[str] = None
    match_pattern: Optional[str] = None


class PresetResponse(BaseModel):
    preset: dict


class PresetsResponse(BaseModel):
    presets: list[dict]


@router.get("/", response_model=PresetsResponse)
async def list_all(user: UserInfo = Depends(require_user)):
    await ensure_builtin_preset(user.user_id)
    presets = await list_presets(user.user_id)
    return {"presets": presets}


@router.post("/", response_model=PresetResponse)
async def create(body: CreatePresetRequest, user: UserInfo = Depends(require_user)):
    preset = await create_preset(user.user_id, body.name, body.template_yaml, match_pattern=body.match_pattern)
    return {"preset": preset}


@router.get("/{preset_id}", response_model=PresetResponse)
async def get(preset_id: str, user: UserInfo = Depends(require_user)):
    preset = await get_preset(preset_id)
    if not preset or preset.get("user_id") != user.user_id:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"preset": preset}


@router.put("/{preset_id}", response_model=PresetResponse)
async def update(preset_id: str, body: UpdatePresetRequest, user: UserInfo = Depends(require_user)):
    preset = await get_preset(preset_id)
    if not preset or preset.get("user_id") != user.user_id:
        raise HTTPException(status_code=404, detail="Preset not found")
    if preset.get("is_builtin"):
        raise HTTPException(status_code=403, detail="Cannot edit built-in preset")

    await update_preset(preset_id, name=body.name, template_yaml=body.template_yaml, match_pattern=body.match_pattern)
    preset = await get_preset(preset_id)
    return {"preset": preset}


@router.delete("/{preset_id}")
async def delete(preset_id: str, user: UserInfo = Depends(require_user)):
    preset = await get_preset(preset_id)
    if not preset or preset.get("user_id") != user.user_id:
        raise HTTPException(status_code=404, detail="Preset not found")
    if preset.get("is_builtin"):
        raise HTTPException(status_code=403, detail="Cannot delete built-in preset")

    await delete_preset(preset_id)
    return {"status": "deleted"}
