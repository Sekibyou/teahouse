"""
Plugin manager — scan, load, and provide context for plugins.

Plugins are directories under plugins/ containing a plugin.json manifest
and an optional backend.py with hooks + tool executors.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from importlib import import_module as _import_module
from pathlib import Path
from typing import Any

from .database.plugins import upsert_plugin, get_plugin_data, set_plugin_data
from .database.plugins import configure_plugin_crypto
from .state import state

# Default plugins directory
PLUGINS_DIR = Path("plugins")


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
    """Sandboxed context passed to plugin backend code.

    Plugin code can:
    - get_data / set_data — read/write its own encrypted key-value store
    - broadcast — push SSE events
    - master_key — for the plugin's own use (derived, not the raw master key)
    """

    def __init__(self, plugin_id: str) -> None:
        self.plugin_id = plugin_id

    async def get_data(self, user_id: str) -> dict[str, str]:
        return await get_plugin_data(self.plugin_id, user_id)

    async def set_data(self, user_id: str, key: str, value: str) -> None:
        await set_plugin_data(self.plugin_id, user_id, key, value)

    def broadcast(self, event: str, data: object) -> None:
        state.broadcast(event, data)


# ── Plugin registry ──────────────────────────────────────────────


loaded_plugins: dict[str, "LoadedPlugin"] = {}


@dataclass
class LoadedPlugin:
    manifest: PluginManifest
    context: PluginContext
    module: Any = None  # The imported backend.py module, if any
    tool_executors: dict[str, Any] = field(default_factory=dict)


def scan_plugins_dir(path: Path | None = None) -> list[PluginManifest]:
    """Walk the plugins directory and parse all plugin.json files.

    Returns a list of discovered manifests. Does NOT load them.
    """
    root = path or PLUGINS_DIR
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
            # Detect frontend/backend presence
            m.has_backend = (entry / "__init__.py").exists()
            if not m.has_backend:
                m.has_backend = (entry / "backend.py").exists()
            m.has_frontend = (entry / "frontend" / "index.html").exists()
            manifests.append(m)
        except Exception:
            pass  # Skip broken plugins silently
    return manifests


async def register_plugins_in_db(manifests: list[PluginManifest]) -> None:
    """Sync scanned manifests to the database (upsert)."""
    for m in manifests:
        await upsert_plugin(
            pid=m.id,
            name=m.name,
            version=m.version,
            description=m.description,
            permissions=m.permissions,
            has_backend=m.has_backend,
            has_frontend=m.has_frontend,
        )
        # Ensure enabled plugins get loaded
        from .database.plugins import get_plugin
        db_plugin = await get_plugin(m.id)
        if db_plugin and db_plugin.get("enabled"):
            await load_plugin(m)


async def load_plugin(manifest: PluginManifest) -> LoadedPlugin | None:
    """Load a plugin's backend module and register its tools.

    Only loads if has_backend=True and the plugin is not already loaded.
    """
    if manifest.id in loaded_plugins:
        return loaded_plugins[manifest.id]

    ctx = PluginContext(manifest.id)
    lp = LoadedPlugin(manifest=manifest, context=ctx)

    plugin_dir = PLUGINS_DIR / manifest.id

    # Try importing backend.py
    backend_path = plugin_dir / "backend.py"
    if backend_path.exists():
        module_name = f"_plugin_{manifest.id.replace('-', '_')}"
        spec = __import__("importlib.util").util.spec_from_file_location(module_name, str(backend_path))
        if spec and spec.loader:
            mod = __import__("importlib.util").util.module_from_spec(spec)
            sys.modules[module_name] = mod
            spec.loader.exec_module(mod)

            # Call on_load if defined
            if hasattr(mod, "on_load"):
                await mod.on_load(ctx)

            # Register tool executors
            if hasattr(mod, "register_tools"):
                tools = mod.register_tools()
                lp.module = mod
                for tool_def in tools:
                    name = tool_def["name"]
                    if hasattr(mod, f"execute_{name.lower()}"):
                        lp.tool_executors[name] = getattr(mod, f"execute_{name.lower()}")
                    elif name in mod.__dict__:
                        lp.tool_executors[name] = mod.__dict__[name]

    # Also look for explicit tool executors (function per tool)
    if manifest.tools and not lp.tool_executors and lp.module:
        for tool_def in manifest.tools:
            name = tool_def["name"]
            func_name = f"execute_{name.lower()}"
            if hasattr(lp.module, func_name):
                lp.tool_executors[name] = getattr(lp.module, func_name)

    loaded_plugins[manifest.id] = lp
    _merge_plugin_tools()
    return lp


async def load_enabled_plugins() -> None:
    """Called at startup — load all enabled plugins that have backends."""
    from .database.plugins import get_plugins
    all_plugins = await get_plugins()
    for p in all_plugins:
        if p.get("enabled") and p.get("has_backend"):
            manifest_path = PLUGINS_DIR / p["id"] / "plugin.json"
            if manifest_path.exists():
                try:
                    m = PluginManifest.from_json(manifest_path)
                    await load_plugin(m)
                except Exception:
                    pass


def get_tool_defs_from_plugins() -> list[dict]:
    """Collect tool definitions from all loaded plugins."""
    defs: list[dict] = []
    for lp in loaded_plugins.values():
        if lp.manifest.tools:
            defs.extend(lp.manifest.tools)
    return defs


def get_tool_executors_from_plugins() -> dict[str, Any]:
    """Collect tool executors from all loaded plugins."""
    execs: dict[str, Any] = {}
    for lp in loaded_plugins.values():
        execs.update(lp.tool_executors)
    return execs


# ── Tools integration ────────────────────────────────────────────


def _merge_plugin_tools() -> None:
    """Merge plugin-provided tools into the global TOOLS list and TOOL_EXECUTORS dict.

    Called after each plugin is loaded. Exported for use by tools.py and app.py.
    """
    pass  # Actual merging happens in tools.py via get_tool_defs_from_plugins()
