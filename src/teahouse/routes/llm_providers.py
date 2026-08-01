"""
LLM Provider API routes.
"""
from __future__ import annotations

import json
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..database.llm_providers import (
    create_provider, get_provider, list_providers,
    update_provider, delete_provider,
)
from ..database.llm_models import (
    create_model, get_model,
)
from ..database.model_profiles import match_profiles
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/llm/providers", tags=["llm-providers"])


# ===== Pydantic models =====

class CreateProviderRequest(BaseModel):
    name: str
    api_url: str
    api_key: str
    api_format: str = "openai"
    model_fetch_url: str = ""


class UpdateProviderRequest(BaseModel):
    name: Optional[str] = None
    api_url: Optional[str] = None
    api_key: Optional[str] = None
    api_format: Optional[str] = None
    is_enabled: Optional[bool] = None
    model_fetch_url: Optional[str] = None


class ImportModelsRequest(BaseModel):
    model_profiles: dict[str, str]  # {model_name: profile_id}


# ===== URL normalization =====

VALID_FORMATS = {"openai", "openai_strict", "anthropic"}


def normalize_api_url(url: str, api_format: str) -> str:
    url = url.strip().rstrip("/")
    if api_format == "anthropic":
        if "/messages" in url:
            return url
        if url.endswith("/v1"):
            return url + "/messages"
        return url + "/v1/messages"
    else:
        if "/chat/completions" in url:
            return url
        if url.endswith("/v1"):
            return url + "/chat/completions"
        return url + "/v1/chat/completions"


# ===== Helper =====

def _provider_ownership_check(provider, user_id):
    if not provider or provider["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Provider not found")


# ===== Routes =====

@router.get("/")
async def api_list_providers(user: UserInfo = Depends(require_user)):
    providers = await list_providers(user.user_id)
    return {"providers": providers}


@router.post("/")
async def api_create_provider(body: CreateProviderRequest, user: UserInfo = Depends(require_user)):
    if body.api_format not in VALID_FORMATS:
        raise HTTPException(status_code=400, detail=f"Invalid api_format. Must be one of {VALID_FORMATS}")
    api_url = normalize_api_url(body.api_url, body.api_format)
    provider = await create_provider(
        user_id=user.user_id,
        name=body.name,
        api_url=api_url,
        api_key=body.api_key,
        api_format=body.api_format,
        model_fetch_url=body.model_fetch_url,
    )
    return {"provider": provider}


@router.get("/{provider_id}")
async def api_get_provider(provider_id: str, user: UserInfo = Depends(require_user)):
    provider = await get_provider(provider_id)
    _provider_ownership_check(provider, user.user_id)
    return {"provider": provider}


@router.put("/{provider_id}")
async def api_update_provider(provider_id: str, body: UpdateProviderRequest, user: UserInfo = Depends(require_user)):
    provider = await get_provider(provider_id)
    _provider_ownership_check(provider, user.user_id)

    kwargs = body.model_dump(exclude_none=True)

    # Normalize URL if api_format or api_url changed
    new_format = kwargs.get("api_format", provider["api_format"])
    if "api_url" in kwargs:
        kwargs["api_url"] = normalize_api_url(kwargs["api_url"], new_format)
    if "api_format" in kwargs and kwargs["api_format"] not in VALID_FORMATS:
        raise HTTPException(status_code=400, detail=f"Invalid api_format. Must be one of {VALID_FORMATS}")

    ok = await update_provider(provider_id, **kwargs)
    if not ok:
        raise HTTPException(status_code=400, detail="No fields to update")
    return {"provider": await get_provider(provider_id)}


@router.delete("/{provider_id}")
async def api_delete_provider(provider_id: str, user: UserInfo = Depends(require_user)):
    provider = await get_provider(provider_id)
    _provider_ownership_check(provider, user.user_id)
    await delete_provider(provider_id)
    return {"status": "ok"}


@router.get("/{provider_id}/available-models")
async def api_available_models(
    provider_id: str,
    user: UserInfo = Depends(require_user),
    url: Optional[str] = Query(None, description="Override the model fetch URL"),
):
    provider = await get_provider(provider_id)
    _provider_ownership_check(provider, user.user_id)

    api_url = url or provider["api_url"]
    api_key = provider["api_key"]
    api_format = provider["api_format"]

    return {"models": _fetch_available_models(api_url, api_key, api_format, is_custom_url=bool(url))}


@router.post("/{provider_id}/import-models")
async def api_import_models(provider_id: str, body: ImportModelsRequest, user: UserInfo = Depends(require_user)):
    provider = await get_provider(provider_id)
    _provider_ownership_check(provider, user.user_id)

    if not body.model_profiles:
        raise HTTPException(status_code=400, detail="model_profiles must be a non-empty dict")

    created = []
    skipped = []

    from ..database.llm_models import list_models
    existing_models = await list_models(user.user_id)
    existing_names = {m["model_name"] for m in existing_models if m["provider_id"] == provider_id}

    for model_name, profile_id in body.model_profiles.items():
        model_name = model_name.strip()
        if not model_name:
            continue
        if model_name in existing_names:
            skipped.append(model_name)
            continue

        # Auto-match profile if profile_id is empty or no explicit profile
        actual_profile_id = profile_id if profile_id else None
        if not actual_profile_id:
            matches = await match_profiles(model_name, user.user_id)
            if matches:
                actual_profile_id = matches[0]["id"]

        model = await create_model(
            user_id=user.user_id,
            name=model_name,  # display name = model_name by default
            provider_id=provider_id,
            model_name=model_name,
            profile_id=actual_profile_id,
        )
        created.append(model)
        existing_names.add(model_name)

    return {"created": created, "skipped": skipped}


# ===== Provider model fetching =====

def _fetch_available_models(api_url: str, api_key: str, api_format: str, is_custom_url: bool = False) -> list[dict]:
    """Fetch available models from a provider's API."""
    # Only hardcode for Anthropic's official API — it has no /v1/models endpoint
    if "api.anthropic.com" in api_url:
        return [
            {"id": "claude-opus-4-5", "name": "Claude Opus 4.5"},
            {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"},
            {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"},
            {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
            {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku"},
            {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus"},
            {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku"},
        ]

    if "generativelanguage.googleapis.com" in api_url:
        return [
            {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash"},
            {"id": "gemini-2.0-flash-exp", "name": "Gemini 2.0 Flash (Experimental)"},
            {"id": "gemini-1.5-pro", "name": "Gemini 1.5 Pro"},
            {"id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash"},
            {"id": "gemini-1.0-pro", "name": "Gemini 1.0 Pro"},
        ]

    # For all other providers (OpenAI-compatible + third-party Anthropic-compatible):
    try:
        if is_custom_url:
            models_url = api_url
        else:
            for suffix in ["/v1/chat/completions", "/chat/completions", "/v1/messages", "/messages"]:
                if api_url.endswith(suffix):
                    base_url = api_url[:-len(suffix)].rstrip("/")
                    break
            else:
                base_url = api_url.rstrip("/")
            models_url = base_url + "/v1/models"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        with httpx.Client(timeout=10.0) as client:
            response = client.get(models_url, headers=headers)
            if response.status_code == 200:
                data = response.json()
                models = []
                for model in data.get("data", []):
                    model_id = model.get("id", "")
                    if not model_id:
                        continue
                    if "openai.com" in api_url:
                        if not any(kw in model_id for kw in ["gpt-", "o1-", "o3-", "o4-"]):
                            continue
                    models.append({"id": model_id, "name": model_id})
                return models
    except Exception:
        pass

    return []
