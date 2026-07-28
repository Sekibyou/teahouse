"""
Plugin API routes — list, enable/disable, plugin data CRUD.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from ..database.plugins import (
    get_plugins,
    get_plugin,
    set_enabled,
    get_plugin_data,
    set_plugin_data,
    delete_plugin_data,
)
from ..plugins import load_plugin, loaded_plugins, PluginManifest
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


# ── Pydantic models ──────────────────────────────────────────────


class PluginDataBody(BaseModel):
    data: dict[str, str]  # key → value map for bulk set


# ── Routes ───────────────────────────────────────────────────────


@router.get("")
async def api_list_plugins(user: UserInfo = Depends(require_user)):
    """List all detected plugins with their enabled status."""
    plugins = await get_plugins()
    return {
        "plugins": [
            {
                "id": p["id"],
                "name": p["name"],
                "version": p["version"],
                "description": p["description"],
                "enabled": bool(p["enabled"]),
                "permissions": p["permissions"],
                "has_backend": bool(p["has_backend"]),
                "has_frontend": bool(p["has_frontend"]),
            }
            for p in plugins
        ]
    }


@router.get("/{plugin_id}")
async def api_get_plugin(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    return {
        "id": p["id"],
        "name": p["name"],
        "version": p["version"],
        "description": p["description"],
        "enabled": bool(p["enabled"]),
        "permissions": p["permissions"],
        "has_backend": bool(p["has_backend"]),
        "has_frontend": bool(p["has_frontend"]),
    }


@router.post("/{plugin_id}/enable")
async def api_enable_plugin(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await set_enabled(plugin_id, True)

    # Load plugin backend if it has one and isn't already loaded
    if p["has_backend"] and plugin_id not in loaded_plugins:
        manifest_path = __import__("pathlib").Path("plugins") / plugin_id / "plugin.json"
        if manifest_path.exists():
            try:
                m = PluginManifest.from_json(manifest_path)
                await load_plugin(m)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to load plugin: {e}")

    return {"status": "ok", "plugin_id": plugin_id, "enabled": True}


@router.post("/{plugin_id}/disable")
async def api_disable_plugin(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await set_enabled(plugin_id, False)

    # Unload plugin from memory
    if plugin_id in loaded_plugins:
        del loaded_plugins[plugin_id]

    return {"status": "ok", "plugin_id": plugin_id, "enabled": False}


@router.get("/{plugin_id}/data")
async def api_get_data(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not p["enabled"]:
        raise HTTPException(status_code=400, detail="Plugin is not enabled")

    data = await get_plugin_data(plugin_id, user.user_id)
    return {"plugin_id": plugin_id, "data": data}


@router.put("/{plugin_id}/data")
async def api_set_data(plugin_id: str, body: PluginDataBody, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not p["enabled"]:
        raise HTTPException(status_code=400, detail="Plugin is not enabled")

    for key, value in body.data.items():
        await set_plugin_data(plugin_id, user.user_id, key, value)

    return {"status": "ok", "plugin_id": plugin_id}


@router.delete("/{plugin_id}/data/{key}")
async def api_delete_data(plugin_id: str, key: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await delete_plugin_data(plugin_id, user.user_id, key)
    return {"status": "ok"}
