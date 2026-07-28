"""
Plugin manager — per-user plugin discovery, loading, and sandboxed context.

Each user has their own plugins in data/{safe_name}/plugins/.
Plugins are scanned at startup for each user, and independently enabled/disabled.
"""
from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .database.plugins import upsert_plugin, get_plugin_data, set_plugin_data, get_plugins, get_plugin
from .database.plugins import configure_plugin_crypto
from .state import state


# ── Data structures ──────────────────────────────────────────────


@dataclass
class PluginManifest:
    id: str
    name: str = ""
    version: str = "0.1.0"
    description: str = ""
    permissions: list[str] = field(default_factory=list)
    tools: list[dict] = field(default_factory=list)
    has_backend: bool = False
    has_frontend: bool = False
    source_path: str = ""

    @classmethod
    def from_json(cls, path: Path) -> "PluginManifest":
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            version=data.get("version", "0.1.0"),
            description=data.get("description", ""),
            permissions=data.get("permissions", []),
            tools=data.get("tools", []),
        )


class PluginContext:
    """Sandboxed context passed to plugin backend code."""

    def __init__(self, plugin_id: str) -> None:
        self.plugin_id = plugin_id

    async def get_data(self, user_id: str) -> dict[str, str]:
        return await get_plugin_data(self.plugin_id, user_id)

    async def set_data(self, user_id: str, key: str, value: str) -> None:
        await set_plugin_data(self.plugin_id, user_id, key, value)

    def broadcast(self, event: str, data: object) -> None:
        state.broadcast(event, data)


# ── Plugin registry (per-user loaded state) ───────────────────────


@dataclass
class LoadedPlugin:
    manifest: PluginManifest
    context: PluginContext
    user_id: str
    module: Any = None
    tool_executors: dict[str, Any] = field(default_factory=dict)


# Keyed by (user_id, plugin_id)
loaded_plugins: dict[str, LoadedPlugin] = {}

ROOT_PLUGINS_DIR = Path("plugins")  # global plugin templates (not user-specific)


def _loaded_key(user_id: str, plugin_id: str) -> str:
    return f"{user_id}:{plugin_id}"


def _user_plugins_dir(user_safe_name: str) -> Path:
    return Path(state.workspace_base) / user_safe_name / "plugins"


def _scan_dir(root: Path) -> list[PluginManifest]:
    """Scan a single directory for plugin.json manifests."""
    manifests: list[PluginManifest] = []
    if not root.is_dir():
        return manifests
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        manifest_path = entry / "plugin.json"
        if not manifest_path.exists():
            continue
        try:
            m = PluginManifest.from_json(manifest_path)
            m.has_backend = (entry / "backend.py").exists()
            m.has_frontend = (entry / "frontend" / "index.html").exists()
            m.source_path = str(entry.resolve())
            manifests.append(m)
        except Exception:
            pass
    return manifests


async def scan_and_register_user_plugins(user_id: str, safe_name: str) -> list[PluginManifest]:
    """Scan a user's plugin directory and sync to DB. Returns discovered manifests."""
    user_dir = _user_plugins_dir(safe_name)
    manifests = _scan_dir(user_dir)

    for m in manifests:
        await upsert_plugin(
            user_id=user_id,
            pid=m.id,
            name=m.name,
            version=m.version,
            description=m.description,
            permissions=m.permissions,
            has_backend=m.has_backend,
            has_frontend=m.has_frontend,
            source_path=m.source_path,
        )
        # Reload if already enabled
        db_p = await get_plugin(m.id, user_id)
        if db_p and db_p.get("enabled"):
            await load_plugin(m, user_id)

    return manifests


async def load_plugin(manifest: PluginManifest, user_id: str) -> LoadedPlugin | None:
    """Load a plugin's backend module and register its tools."""
    key = _loaded_key(user_id, manifest.id)
    if key in loaded_plugins:
        return loaded_plugins[key]

    ctx = PluginContext(manifest.id)
    lp = LoadedPlugin(manifest=manifest, context=ctx, user_id=user_id)

    plugin_dir = Path(manifest.source_path)
    backend_path = plugin_dir / "backend.py"
    if backend_path.exists():
        module_name = f"_plugin_{user_id}_{manifest.id.replace('-', '_')}"
        spec = __import__("importlib.util").util.spec_from_file_location(module_name, str(backend_path))
        if spec and spec.loader:
            mod = __import__("importlib.util").util.module_from_spec(spec)
            sys.modules[module_name] = mod
            spec.loader.exec_module(mod)

            if hasattr(mod, "on_load"):
                await mod.on_load(ctx)

            if hasattr(mod, "register_tools"):
                tools = mod.register_tools()
                lp.module = mod
                for tool_def in tools:
                    name = tool_def["name"]
                    executor = None
                    if hasattr(mod, f"execute_{name.lower()}"):
                        executor = getattr(mod, f"execute_{name.lower()}")
                    elif name in mod.__dict__ and callable(mod.__dict__[name]):
                        executor = mod.__dict__[name]
                    if executor:
                        lp.tool_executors[name] = executor

    if manifest.tools and not lp.tool_executors and lp.module:
        for tool_def in manifest.tools:
            name = tool_def["name"]
            func_name = f"execute_{name.lower()}"
            if hasattr(lp.module, func_name):
                lp.tool_executors[name] = getattr(lp.module, func_name)

    loaded_plugins[key] = lp
    return lp


def unload_plugin(plugin_id: str, user_id: str) -> None:
    """Unload a plugin from memory."""
    key = _loaded_key(user_id, plugin_id)
    loaded_plugins.pop(key, None)


async def load_all_enabled_plugins() -> None:
    """Called at startup — load all enabled plugins for all users."""
    # This is called once at startup, but now plugins are per-user.
    # We need to iterate all users. For simplicity, scan the workspace base.
    base = Path(state.workspace_base)
    if not base.is_dir():
        return
    for user_dir in base.iterdir():
        if not user_dir.is_dir():
            continue
        plugins_dir = user_dir / "plugins"
        if not plugins_dir.is_dir():
            continue
        safe_name = user_dir.name
        # We need user_id — look it up from DB
        from .database.users import get_user_by_safe_name
        user = await get_user_by_safe_name(safe_name)
        if not user:
            continue
        manifests = _scan_dir(plugins_dir)
        for m in manifests:
            await upsert_plugin(
                user_id=user["id"],
                pid=m.id,
                name=m.name,
                version=m.version,
                description=m.description,
                permissions=m.permissions,
                has_backend=m.has_backend,
                has_frontend=m.has_frontend,
                source_path=m.source_path,
            )
            db_p = await get_plugin(m.id, user["id"])
            if db_p and db_p.get("enabled"):
                await load_plugin(m, user["id"])


def get_tool_defs_from_plugins() -> list[dict]:
    """Collect tool definitions from all loaded plugins (across all users)."""
    defs: list[dict] = []
    seen: set[str] = set()
    for lp in loaded_plugins.values():
        for t in lp.manifest.tools:
            if t["name"] not in seen:
                defs.append(t)
                seen.add(t["name"])
    return defs


def get_tool_executors_from_plugins() -> dict[str, Any]:
    """Collect tool executors from all loaded plugins (across all users)."""
    execs: dict[str, Any] = {}
    for lp in loaded_plugins.values():
        execs.update(lp.tool_executors)
    return execs


def find_plugin_context_for_tool(tool_name: str, user_id: str) -> PluginContext | None:
    """Find the PluginContext for the loaded plugin that owns a given tool.
    Prefer plugins belonging to the given user_id.
    """
    for lp in loaded_plugins.values():
        if tool_name in lp.tool_executors:
            if lp.user_id == user_id:
                return lp.context
    # Fallback: any user's context
    for lp in loaded_plugins.values():
        if tool_name in lp.tool_executors:
            return lp.context
    return None


# ── Install / uninstall helpers ───────────────────────────────────


async def install_plugin_from_path(user_id: str, safe_name: str, source: Path) -> str:
    """Install a plugin from a directory or zip into the user's plugins directory.

    Returns the plugin id.
    """
    import zipfile, tempfile

    user_dir = _user_plugins_dir(safe_name)

    if source.suffix == ".zip":
        # Extract zip into user's plugins dir
        with zipfile.ZipFile(source, "r") as zf:
            # Find the top-level directory name (plugin id)
            names = zf.namelist()
            root_name = names[0].split("/")[0] if names else source.stem
            dest = user_dir / root_name
            if dest.exists():
                shutil.rmtree(dest)
            zf.extractall(user_dir)
    elif source.is_dir():
        dest = user_dir / source.name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(source, dest)
    else:
        raise ValueError(f"Unsupported source type: {source}")

    return dest.name


async def uninstall_plugin(user_id: str, plugin_id: str, safe_name: str) -> None:
    """Remove a plugin: delete from disk, DB, and memory."""
    # 1. Unload from memory
    unload_plugin(plugin_id, user_id)

    # 2. Delete from filesystem (use source_path from DB to find the directory)
    from .database.plugins import get_plugin, delete_plugin
    p = await get_plugin(plugin_id, user_id)
    if p and p.get("source_path"):
        plugin_dir = Path(p["source_path"])
        if plugin_dir.exists():
            shutil.rmtree(plugin_dir)

    # 3. Delete from DB (plugin_data cascade-deletes)
    await delete_plugin(plugin_id, user_id)
