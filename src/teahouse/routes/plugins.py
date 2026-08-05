"""
Plugin API routes — per-user plugins: list, enable/disable, data CRUD, install, uninstall.
"""
from __future__ import annotations

import os
import tempfile
import time
import uuid
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
    get_network_rules,
    get_network_rule,
    add_user_network_rule,
    set_network_rule_enabled,
    update_user_network_rule,
    delete_network_rule,
    seed_declared_network_rules,
)
from ..plugins import (
    _user_plugins_dir,
    _scan_dir,
    scan_and_register_user_plugins,
    load_plugin,
    unload_plugin,
    install_plugin_from_path,
    prevalidate_plugin_source,
    uninstall_plugin,
    PluginManifest,
    PluginContext,
    parse_network_rule,
    NetworkRuleError,
)
from ..database.users import get_user_by_id
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/plugins", tags=["plugins"])

# In-memory install-preview store: {preview_id: {path, created_at}}
# Preview keeps the uploaded zip in a system temp dir (never the user plugins
# dir); confirm consumes it. TTL-cleaned opportunistically.
_PREVIEW_TTL = 300  # seconds
_previews: dict[str, dict] = {}


def _preview_cleanup() -> None:
    now = time.time()
    stale = [k for k, v in _previews.items() if now - v["created_at"] > _PREVIEW_TTL]
    for k in stale:
        try:
            os.unlink(_previews[k]["path"])
        except OSError:
            pass
        _previews.pop(k, None)


def _detect_tool_conflicts(manifest: PluginManifest) -> list[str]:
    """Return tool names that collide with built-in tools (must be rejected).

    Cross-plugin conflicts with the user's other installed plugins are surfaced
    at install/scan time (a reinstall of the same id is fine and not flagged).
    """
    from ..tools import TOOL_EXECUTORS
    return [t["name"] for t in manifest.tools if t["name"] in TOOL_EXECUTORS]


async def _get_safe_name(user_id: str) -> str:
    u = await get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return u["safe_name"] or u["username"].lower().replace(" ", "_")


# ── Pydantic models ───────────────────────────────────────────────


class PluginDataBody(BaseModel):
    data: dict[str, str]


class NetworkRuleBody(BaseModel):
    scheme: str = "https"
    host: str
    port: Optional[int] = None


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


# ── Network allowlist (three-state: declared-enable / declared-disable / user) ──


@router.get("/{plugin_id}/network-rules")
async def api_get_network_rules(plugin_id: str, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    rules = await get_network_rules(plugin_id, user.user_id)
    return {
        "plugin_id": plugin_id,
        "rules": [
            {
                "id": r["id"],
                "scheme": r["scheme"],
                "host": r["host"],
                "port": r["port"],
                "source": r["source"],      # "declare" | "user"
                "enabled": bool(r["enabled"]),
            }
            for r in rules
        ],
    }


@router.post("/{plugin_id}/network-rules")
async def api_add_network_rule(plugin_id: str, body: NetworkRuleBody, user: UserInfo = Depends(require_user)):
    p = await get_plugin(plugin_id, user.user_id)
    if not p:
        raise HTTPException(status_code=404, detail="Plugin not found")

    try:
        rule = parse_network_rule({"scheme": body.scheme, "host": body.host, "port": body.port})
    except NetworkRuleError as e:
        raise HTTPException(status_code=400, detail=str(e))

    row = await add_user_network_rule(plugin_id, user.user_id, rule.scheme, rule.host, rule.port)
    return {"status": "ok", "rule": _rule_dict(row)}


@router.patch("/{plugin_id}/network-rules/{rule_id}")
async def api_update_network_rule(
    plugin_id: str,
    rule_id: str,
    body: NetworkRuleBody,
    user: UserInfo = Depends(require_user),
):
    rule = await get_network_rule(rule_id, user.user_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    if rule["source"] != "user":
        raise HTTPException(status_code=403, detail="插件声明的白名单项不可修改，只能启用/禁用；如需自定义请新增规则")

    try:
        parsed = parse_network_rule({"scheme": body.scheme, "host": body.host, "port": body.port})
    except NetworkRuleError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await update_user_network_rule(rule_id, user.user_id, parsed.scheme, parsed.host, parsed.port)
    updated = await get_network_rule(rule_id, user.user_id)
    return {"status": "ok", "rule": _rule_dict(updated)}


@router.post("/{plugin_id}/network-rules/{rule_id}/enable")
async def api_enable_network_rule(rule_id: str, plugin_id: str, user: UserInfo = Depends(require_user)):
    rule = await get_network_rule(rule_id, user.user_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await set_network_rule_enabled(rule_id, user.user_id, True)
    return {"status": "ok", "rule_id": rule_id, "enabled": True}


@router.post("/{plugin_id}/network-rules/{rule_id}/disable")
async def api_disable_network_rule(rule_id: str, plugin_id: str, user: UserInfo = Depends(require_user)):
    rule = await get_network_rule(rule_id, user.user_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await set_network_rule_enabled(rule_id, user.user_id, False)
    return {"status": "ok", "rule_id": rule_id, "enabled": False}


@router.delete("/{plugin_id}/network-rules/{rule_id}")
async def api_delete_network_rule(rule_id: str, plugin_id: str, user: UserInfo = Depends(require_user)):
    rule = await get_network_rule(rule_id, user.user_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    if rule["source"] != "user":
        raise HTTPException(status_code=403, detail="插件声明的白名单项不可删除")

    await delete_network_rule(rule_id, user.user_id)
    return {"status": "ok", "rule_id": rule_id}


def _rule_dict(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "scheme": row["scheme"],
        "host": row["host"],
        "port": row["port"],
        "source": row["source"],
        "enabled": bool(row["enabled"]),
    }


@router.post("/preview")
async def api_preview_plugin(
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Stage + validate a plugin zip WITHOUT installing. Returns manifest +
    conflicts + a short-lived preview_id that import/confirm consumes."""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="只支持 .zip 格式的插件包")

    _preview_cleanup()
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="插件包过大 (上限 20MB)")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip", prefix="teahouse_plugin_") as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        m = await prevalidate_plugin_source(Path(tmp_path))
    except NetworkRuleError as e:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass
        raise HTTPException(status_code=400, detail=f"插件包无效: {e}")

    conflicts = _detect_tool_conflicts(m)
    preview_id = uuid.uuid4().hex
    _previews[preview_id] = {"path": tmp_path, "created_at": time.time()}

    return {
        "preview_id": preview_id,
        "available": True,
        "manifest": _manifest_preview_dict(m),
        "conflicts": conflicts,
        "network_allowlist": [r.to_dict() for r in m.network_allowlist],
        "has_backend": m.has_backend,
        "has_frontend": m.has_frontend,
    }


class ConfirmInstallBody(BaseModel):
    preview_id: str


@router.post("/import/confirm")
async def api_import_plugin_confirm(
    body: ConfirmInstallBody,
    user: UserInfo = Depends(require_user),
):
    """Install a previously previewed zip. Re-validates everything (TOCTOU
    guard): manifest, network rules, backend syntax, tool conflicts."""
    _preview_cleanup()
    entry = _previews.pop(body.preview_id, None)
    if not entry:
        raise HTTPException(status_code=400, detail="preview 已过期或无效，请重新上传插件包")
    tmp_path = entry["path"]

    safe_name = await _get_safe_name(user.user_id)
    try:
        # Re-validate the actual bytes before persisting (TOCTOU).
        m = await prevalidate_plugin_source(Path(tmp_path))
        conflicts = _detect_tool_conflicts(m)
        if conflicts:
            raise HTTPException(
                status_code=400,
                detail=f"插件声明的工具与内置工具冲突，无法安装: {', '.join(conflicts)}",
            )

        plugin_id = await install_plugin_from_path(user.user_id, safe_name, Path(tmp_path))
        # Seed declared network allowlist rules (idempotent).
        await seed_declared_network_rules(
            plugin_id, user.user_id, [r.to_dict() for r in m.network_allowlist]
        )
        await scan_and_register_user_plugins(user.user_id, safe_name)
        return {"status": "ok", "plugin_id": plugin_id, "message": f"插件 '{plugin_id}' 已安装"}
    except HTTPException:
        raise
    except NetworkRuleError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"安装失败: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _manifest_preview_dict(m: PluginManifest) -> dict:
    return {
        "id": m.id,
        "name": m.name,
        "version": m.version,
        "description": m.description,
        "permissions": m.permissions,
        "tools": [
            {"name": t.get("name", ""), "description": t.get("description", ""), "parameters": t.get("parameters", {})}
            for t in m.tools
        ],
    }


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
