"""
LLM Slot Bindings API routes.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..database.llm_slots import (
    get_all_slot_bindings, set_slot_binding, set_all_slot_bindings, clear_slot_binding,
)
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/llm/slots", tags=["llm-slots"])


class SetSlotRequest(BaseModel):
    model_id: Optional[str] = None
    profile_id: Optional[str] = None
    prompt_preset_id: Optional[str] = None


class SetAllSlotsRequest(BaseModel):
    director: Optional[str] = None
    writer: Optional[str] = None
    director_profile_id: Optional[str] = None
    writer_profile_id: Optional[str] = None
    director_prompt_preset_id: Optional[str] = None


@router.get("/")
async def api_get_slots(user: UserInfo = Depends(require_user)):
    bindings = await get_all_slot_bindings(user.user_id)
    return {"slots": bindings}


@router.put("/")
async def api_set_all_slots(body: SetAllSlotsRequest, user: UserInfo = Depends(require_user)):
    bindings = {
        "director": {
            "model_id": body.director,
            "profile_id": getattr(body, "director_profile_id", None),
            "prompt_preset_id": getattr(body, "director_prompt_preset_id", None),
        },
        "writer": {
            "model_id": body.writer,
            "profile_id": getattr(body, "writer_profile_id", None),
            "prompt_preset_id": None,
        },
    }
    result = await set_all_slot_bindings(user.user_id, bindings)
    return {"slots": result}


@router.put("/{slot_id}")
async def api_set_slot(slot_id: str, body: SetSlotRequest, user: UserInfo = Depends(require_user)):
    try:
        await set_slot_binding(
            user.user_id, slot_id,
            model_id=body.model_id,
            profile_id=body.profile_id,
            prompt_preset_id=body.prompt_preset_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "slot_id": slot_id,
        "model_id": body.model_id,
        "profile_id": body.profile_id,
        "prompt_preset_id": body.prompt_preset_id,
    }


@router.delete("/{slot_id}")
async def api_clear_slot(slot_id: str, user: UserInfo = Depends(require_user)):
    ok = await clear_slot_binding(user.user_id, slot_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Slot not found")
    return {"status": "ok"}
