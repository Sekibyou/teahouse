"""
LLM config API routes.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database.llm_configs import (
    create_llm_config, get_llm_config, list_llm_configs,
    update_llm_config, delete_llm_config,
)
from ..routes.auth import require_user, UserInfo


router = APIRouter(prefix="/api/llm-configs", tags=["llm-configs"])


class CreateLLMConfigRequest(BaseModel):
    label: str
    api_url: str
    api_key: str
    model_name: str
    api_format: str = "openai"
    max_tokens: int = 8192
    temperature: float = 0.7
    is_default: bool = False


class UpdateLLMConfigRequest(BaseModel):
    label: Optional[str] = None
    api_url: Optional[str] = None
    api_key: Optional[str] = None
    model_name: Optional[str] = None
    api_format: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    is_default: Optional[bool] = None
    is_enabled: Optional[bool] = None


@router.get("/")
async def api_list_configs(user: UserInfo = Depends(require_user)):
    """List all LLM configs for the current user."""
    configs = await list_llm_configs(user.user_id)
    return {"configs": configs}


@router.post("/")
async def api_create_config(body: CreateLLMConfigRequest, user: UserInfo = Depends(require_user)):
    config = await create_llm_config(
        user_id=user.user_id,
        label=body.label,
        api_url=body.api_url,
        api_key=body.api_key,
        model_name=body.model_name,
        api_format=body.api_format,
        max_tokens=body.max_tokens,
        temperature=body.temperature,
        is_default=body.is_default,
    )
    return {"config": config}


@router.get("/{config_id}")
async def api_get_config(config_id: str, user: UserInfo = Depends(require_user)):
    config = await get_llm_config(config_id)
    if not config or config["user_id"] != user.user_id:
        raise HTTPException(status_code=404, detail="Config not found")
    return {"config": config}


@router.put("/{config_id}")
async def api_update_config(config_id: str, body: UpdateLLMConfigRequest, user: UserInfo = Depends(require_user)):
    config = await get_llm_config(config_id)
    if not config or config["user_id"] != user.user_id:
        raise HTTPException(status_code=404, detail="Config not found")
    ok = await update_llm_config(config_id, **body.model_dump(exclude_none=True))
    if not ok:
        raise HTTPException(status_code=400, detail="No fields to update")
    return {"config": await get_llm_config(config_id)}


@router.delete("/{config_id}")
async def api_delete_config(config_id: str, user: UserInfo = Depends(require_user)):
    config = await get_llm_config(config_id)
    if not config or config["user_id"] != user.user_id:
        raise HTTPException(status_code=404, detail="Config not found")
    await delete_llm_config(config_id)
    return {"status": "ok"}
