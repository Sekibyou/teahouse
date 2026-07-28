"""
Plugin API routes — per-user plugins: list, enable/disable, data CRUD, install, uninstall.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
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
from ..plugins import (
    _user_plugins_dir,
    _scan_dir,
    scan_and_register_user_plugins,
    load_plugin,
    unload_plugin,
    install_plugin_from_path,
    uninstall_plugin,
    PluginManifest,
)
from ..database.users import get_user_by_id
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


# ── Helpers ───────────────────────────────────────────────────────


async def _get_safe_name(user_id: str) -> str:
    u = await get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return u["safe_name"] or u["username"].lower().replace(" ", "_")


# ── Pydantic models ───────────────────────────────────────────────


class PluginDataBody(BaseModel):
    data: dict[str, str]


# ── Routes ────────────────────────────────────────────────────────


@router.get("")
async def api_list_plugins(user: UserInfo = Depends(require_user)):
    """List current user's plugins. Scans the user's plugin directory first."""
    # Refresh from disk
    safe_name = await _get_safe_name(user.user_id)
    await scan_and_register_user_plugins(user.user_id, safe_name)
    plugins = await get_plugins(user.user_id)
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
    p = await get_plugin(plugin_id, user.user_id)
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
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await set_enabled(plugin_id, user.user_id, True)

    # Load backend if present
    if p["has_backend"] and p.get("source_path"):
        try:
            m = PluginManifest.from_json(Path(p["source_path"]) / "plugin.json")
            m.source_path = p["source_path"]
            m.has_backend = True
            await load_plugin(m, user.user_id)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to load plugin: {e}")

    return {"status": "ok", "plugin_id": plugin_id, "enabled": True}


@router.post("/{plugin_id}/disable")
async def api_disable_plugin(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await set_enabled(plugin_id, user.user_id, False)
    unload_plugin(plugin_id, user.user_id)

    return {"status": "ok", "plugin_id": plugin_id, "enabled": False}


@router.delete("/{plugin_id}")
async def api_uninstall_plugin(plugin_id: str, user: UserInfo = Depends(require_user)):
    """Delete a plugin entirely: disk files + DB record + memory."""
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    safe_name = await _get_safe_name(user.user_id)
    await uninstall_plugin(user.user_id, plugin_id, safe_name)

    return {"status": "ok", "plugin_id": plugin_id, "message": "插件已卸载"}


@router.post("/import")
async def api_import_plugin(
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Upload a plugin zip and install into the user's plugins directory."""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="只支持 .zip 格式的插件包")

    import tempfile, os
    safe_name = await _get_safe_name(user.user_id)

    # Save uploaded file to temp
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        plugin_id = await install_plugin_from_path(user.user_id, safe_name, Path(tmp_path))
        # Scan to register in DB
        await scan_and_register_user_plugins(user.user_id, safe_name)
        return {"status": "ok", "plugin_id": plugin_id, "message": f"插件 '{plugin_id}' 已导入"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导入失败: {e}")
    finally:
        os.unlink(tmp_path)


# ── Plugin data ───────────────────────────────────────────────────


@router.get("/{plugin_id}/data")
async def api_get_data(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not p["enabled"]:
        raise HTTPException(status_code=400, detail="Plugin is not enabled")

    data = await get_plugin_data(plugin_id, user.user_id)
    return {"plugin_id": plugin_id, "data": data}


@router.put("/{plugin_id}/data")
async def api_set_data(plugin_id: str, body: PluginDataBody, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not p["enabled"]:
        raise HTTPException(status_code=400, detail="Plugin is not enabled")

    for key, value in body.data.items():
        await set_plugin_data(plugin_id, user.user_id, key, value)

    return {"status": "ok", "plugin_id": plugin_id}


@router.delete("/{plugin_id}/data/{key}")
async def api_delete_data(plugin_id: str, key: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await delete_plugin_data(plugin_id, user.user_id, key)
    return {"status": "ok"}


# ── Frontend file serving ─────────────────────────────────────────


@router.get("/{plugin_id}/frontend/{file_path:path}")
async def api_serve_plugin_frontend(
    plugin_id: str,
    file_path: str,
    user: UserInfo = Depends(require_user),
):
    """Serve static files from a plugin's frontend/ directory."""
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not p["has_frontend"]:
        raise HTTPException(status_code=404, detail="Plugin has no frontend")

    source_path = p.get("source_path", "")
    if not source_path:
        raise HTTPException(status_code=404, detail="Plugin source path unknown")

    target = Path(source_path) / "frontend" / file_path
    if not target.resolve().is_relative_to(Path(source_path).resolve()):
        raise HTTPException(status_code=400, detail="Path traversal detected")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(target)
