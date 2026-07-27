"""
LLM Model API routes.
"""
from __future__ import annotations

import json
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database.llm_models import (
    create_model, get_model, list_models, get_enabled_models,
    update_model, delete_model, delete_models_batch, batch_bind_profile,
)
from ..database.llm_providers import get_provider
from ..database.model_profiles import get_profile, match_profiles
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/llm/models", tags=["llm-models"])


# ===== Pydantic models =====

class CreateModelRequest(BaseModel):
    name: str
    provider_id: str
    model_name: str
    profile_id: Optional[str] = None


class UpdateModelRequest(BaseModel):
    name: Optional[str] = None
    provider_id: Optional[str] = None
    model_name: Optional[str] = None
    profile_id: Optional[str] = None
    is_enabled: Optional[bool] = None


class BatchDeleteRequest(BaseModel):
    model_ids: list[str]


class BatchBindRequest(BaseModel):
    bindings: dict[str, str]  # {model_id: profile_id}


class BatchToggleRequest(BaseModel):
    model_ids: list[str]
    is_enabled: bool


# ===== Helper =====

def _model_ownership_check(model, user_id):
    if not model or model["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Model not found")


def _enrich_model(model: dict) -> dict:
    """Enrich a model dict with rendered profile fields for display."""
    return model


# ===== Routes =====

@router.get("/")
async def api_list_models(user: UserInfo = Depends(require_user)):
    models = await list_models(user.user_id)
    return {"models": [_enrich_model(m) for m in models]}


@router.get("/enabled")
async def api_list_enabled_models(user: UserInfo = Depends(require_user)):
    models = await get_enabled_models(user.user_id)
    return {"models": [_enrich_model(m) for m in models]}


@router.post("/")
async def api_create_model(body: CreateModelRequest, user: UserInfo = Depends(require_user)):
    # Verify provider exists and belongs to user
    provider = await get_provider(body.provider_id)
    if not provider or provider["user_id"] != user.user_id:
        raise HTTPException(status_code=404, detail="Provider not found")

    # Auto-match profile if not specified
    profile_id = body.profile_id
    if not profile_id:
        matches = await match_profiles(body.model_name, user.user_id)
        if matches:
            profile_id = matches[0]["id"]

    model = await create_model(
        user_id=user.user_id,
        name=body.name,
        provider_id=body.provider_id,
        model_name=body.model_name,
        profile_id=profile_id,
    )
    return {"model": _enrich_model(model)}


@router.get("/{model_id}")
async def api_get_model(model_id: str, user: UserInfo = Depends(require_user)):
    model = await get_model(model_id)
    _model_ownership_check(model, user.user_id)
    return {"model": _enrich_model(model)}


@router.put("/{model_id}")
async def api_update_model(model_id: str, body: UpdateModelRequest, user: UserInfo = Depends(require_user)):
    model = await get_model(model_id)
    _model_ownership_check(model, user.user_id)

    kwargs = body.model_dump(exclude_none=True)

    # Validate provider if changing
    if "provider_id" in kwargs:
        provider = await get_provider(kwargs["provider_id"])
        if not provider or provider["user_id"] != user.user_id:
            raise HTTPException(status_code=404, detail="Provider not found")

    ok = await update_model(model_id, **kwargs)
    if not ok:
        raise HTTPException(status_code=400, detail="No fields to update")
    return {"model": _enrich_model(await get_model(model_id))}


@router.delete("/{model_id}")
async def api_delete_model(model_id: str, user: UserInfo = Depends(require_user)):
    model = await get_model(model_id)
    _model_ownership_check(model, user.user_id)
    await delete_model(model_id)
    return {"status": "ok"}


@router.delete("/")
async def api_delete_models_batch(body: BatchDeleteRequest, user: UserInfo = Depends(require_user)):
    if not body.model_ids:
        raise HTTPException(status_code=400, detail="model_ids must be a non-empty list")

    # Ownership check: verify all models belong to user
    for mid in body.model_ids:
        model = await get_model(mid)
        if model and model["user_id"] != user.user_id:
            raise HTTPException(status_code=404, detail=f"Model {mid} not found")

    deleted, not_found = await delete_models_batch(body.model_ids)
    return {"deleted": deleted, "not_found": not_found}


@router.patch("/batch-bind-profile")
async def api_batch_bind(body: BatchBindRequest, user: UserInfo = Depends(require_user)):
    if not body.bindings:
        raise HTTPException(status_code=400, detail="bindings must be a non-empty dict")

    # Verify ownership of all models
    for model_id in body.bindings:
        model = await get_model(model_id)
        if model and model["user_id"] != user.user_id:
            raise HTTPException(status_code=404, detail=f"Model {model_id} not found")

    updated = await batch_bind_profile(body.bindings)

    # Return updated models
    models = []
    for mid in updated:
        m = await get_model(mid)
        if m:
            models.append(_enrich_model(m))

    return {"updated": updated, "models": models}


@router.patch("/batch-toggle")
async def api_batch_toggle(body: BatchToggleRequest, user: UserInfo = Depends(require_user)):
    if not body.model_ids:
        raise HTTPException(status_code=400, detail="model_ids must be a non-empty list")

    updated = []
    for mid in body.model_ids:
        model = await get_model(mid)
        if not model or model["user_id"] != user.user_id:
            continue
        await update_model(mid, is_enabled=body.is_enabled)
        updated.append(mid)

    return {"updated": updated}


@router.post("/{model_id}/ping")
async def api_ping_model(model_id: str, user: UserInfo = Depends(require_user)):
    model = await get_model(model_id)
    _model_ownership_check(model, user.user_id)

    provider = await get_provider(model["provider_id"])
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    api_url = provider["api_url"]
    api_key = provider["api_key"]
    api_format = provider["api_format"]
    model_name = model["model_name"]

    # Build minimal request based on format
    if api_format == "anthropic":
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        body = {"model": model_name, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 1}
    else:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {"model": model_name, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 1}

    try:
        start = time.time()
        with httpx.Client(timeout=15.0) as client:
            response = client.post(api_url, headers=headers, json=body)
        latency = int((time.time() - start) * 1000)

        if response.status_code in (200, 201):
            return {"success": True, "latency": latency}
        else:
            try:
                err = response.json().get("error", {})
                msg = err.get("message", response.text) if isinstance(err, dict) else str(err)
            except Exception:
                msg = response.text[:200]
            return {"success": False, "error": msg, "status_code": response.status_code}
    except httpx.TimeoutException:
        return {"success": False, "error": "连接超时"}
    except Exception as e:
        return {"success": False, "error": str(e)}
