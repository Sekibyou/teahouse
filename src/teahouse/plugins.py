"""
Plugin manager — per-user plugin discovery, loading, and sandboxed context.

Each user has their own plugins in data/{safe_name}/plugins/.
Plugins are scanned at startup for each user, and independently enabled/disabled.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .database.plugins import upsert_plugin, get_plugin_data, set_plugin_data, get_plugin
from .database.plugins import configure_plugin_crypto
from .state import state


# ── Data structures ──────────────────────────────────────────────


@dataclass
class NetworkRule:
    """A single network allowlist rule. host supports `*.sub.example.com` wildcard."""
    scheme: str = "https"
    host: str = ""
    port: int | None = None

    def to_dict(self) -> dict:
        return {"scheme": self.scheme, "host": self.host, "port": self.port}


@dataclass
class PluginManifest:
    id: str
    name: str = ""
    version: str = "1.0.0"
    description: str = ""
    permissions: list[str] = field(default_factory=list)
    tools: list[dict] = field(default_factory=list)
    network_allowlist: list[NetworkRule] = field(default_factory=list)
    config: list[dict] = field(default_factory=list)
    i18n: dict = field(default_factory=dict)
    has_backend: bool = False
    has_frontend: bool = False
    source_path: str = ""

    @classmethod
    def from_json(cls, path: Path) -> "PluginManifest":
        data = json.loads(path.read_text(encoding="utf-8"))
        rules = [
            parse_network_rule(r)
            for r in data.get("network_allowlist", [])
            if isinstance(r, dict)
        ]
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            version=data.get("version", "1.0.0"),
            description=data.get("description", ""),
            permissions=data.get("permissions", []),
            tools=data.get("tools", []),
            network_allowlist=rules,
            config=data.get("config", []),
            i18n=data.get("i18n", {}),
        )


class PluginContext:
    """Sandboxed context passed to plugin backend code.

    This is the plugin's *only* gateway to the host. It deliberately exposes a
    small, hard-bounded API surface:
      - file I/O confined to the instance dir (_validate_path)
      - network confined to the plugin's enabled allowlist
      - key/value data confined to this plugin's own namespace
    The plugin backend cannot reach files, the DB, or the network any other way.
    """

    def __init__(self, plugin_id: str, user_id: str = "", instance_dir: Path | None = None) -> None:
        self.plugin_id = plugin_id
        self.user_id = user_id
        self._instance_dir = instance_dir
        # DB UUID of the bound instance, threaded in via bind_instance. Used for
        # SSE file_changed instance filtering on the frontend.
        self.instance_id = ""

    def bind_instance(self, instance_dir: Path, instance_id: str = "") -> None:
        """Bind (or re-bind) the instance this plugin runs against. Idempotent.
        instance_id is the DB UUID; when empty it falls back to the dir name in
        file_changed broadcasts."""
        self._instance_dir = instance_dir
        if instance_id:
            self.instance_id = instance_id

    def _require_instance(self) -> Path:
        if self._instance_dir is None:
            raise ValueError("此操作需要实例上下文（instance_dir 未绑定）")
        return self._instance_dir

    # ---- plugin's own data ----
    async def get_data(self, user_id: str | None = None) -> dict[str, str]:
        uid = user_id or self.user_id
        return await get_plugin_data(self.plugin_id, uid)

    async def set_data(self, key: str, value: str, user_id: str | None = None) -> None:
        uid = user_id or self.user_id
        await set_plugin_data(self.plugin_id, uid, key, value)

    def broadcast(self, event: str, data: object) -> None:
        state.broadcast(event, data)

    def emit_file_changed(self, path: str, tool: str = "PluginWrite", action: str | None = None) -> None:
        """Broadcast a file_changed event (matches the director-tool schema) so the
        frontend refreshes its file tree / open file for this instance.

        Defaults to the DB instance_id when bound, else the instance dir name —
        the frontend (useSSERefresh) accepts either for per-instance filtering.
        """
        instance_dir = self._instance_dir
        data = {
            "path": path,
            "tool": tool,
            "instance_id": self.instance_id or (instance_dir.name if instance_dir is not None else ""),
        }
        if action:
            data["action"] = action
        self.broadcast("file_changed", data)

    # ---- instance file I/O (confined by _validate_path) ----
    def read_file(self, path: str) -> str:
        from .tools import _validate_path
        instance_dir = self._require_instance()
        full = _validate_path(instance_dir, path)
        if not full.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        if full.is_dir():
            raise IsADirectoryError(f"路径是目录而非文件: {path}")
        return full.read_text(encoding="utf-8")

    def read_bytes(self, path: str) -> bytes:
        """Read a raw binary file (guarded by _validate_path). Needed to decode
        binary container formats like SillyTavern's .png card."""
        from .tools import _validate_path
        instance_dir = self._require_instance()
        full = _validate_path(instance_dir, path)
        if not full.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        if full.is_dir():
            raise IsADirectoryError(f"路径是目录而非文件: {path}")
        return full.read_bytes()

    def write_file(self, path: str, content: str) -> None:
        from .tools import _validate_path
        instance_dir = self._require_instance()
        full = _validate_path(instance_dir, path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        # File-as-state: any plugin write should refresh the frontend.
        self.emit_file_changed(path)

    def list_files(self) -> list[str]:
        instance_dir = self._require_instance()
        out = []
        for p in sorted(instance_dir.rglob("*")):
            if p.is_file():
                out.append(str(p.relative_to(instance_dir)))
        return out

    # ---- instance runtime vars ----
    def get_var(self, names: list[str] | None = None) -> list[dict]:
        from .database.workspaces import read_sandbox_vars
        return read_sandbox_vars(self._require_instance(), names)

    def set_var(
        self,
        updates: dict,
        note: dict | None = None,
        change_log: dict | None = None,
    ) -> None:
        from .database.workspaces import write_sandbox_vars
        write_sandbox_vars(self._require_instance(), updates, note, change_log)

    # ---- run a static JSONL batch (deterministic, no director LLM) ----
    async def run_batch(self, path: str, args: dict | None = None) -> dict:
        from .script import load_batch
        from .tools import execute_tool
        instance_dir = self._require_instance()
        steps = load_batch(instance_dir, path)
        results = []
        for i, step in enumerate(steps, 1):
            name = step["tool"]
            cargs = {**step.get("args", {}), **(args or {})}
            res = await execute_tool(name, cargs, instance_dir, self.user_id or None)
            results.append({"index": i, "tool": name, "result": res})
            if res.startswith("Error"):
                return {"ok": False, "completed": results, "failed": {"index": i, "tool": name, "result": res}}
        return {"ok": True, "completed": results}

    # ---- network (allowlist-gated) ----
    async def network_request(
        self,
        method: str,
        url: str,
        headers: dict | None = None,
        data: object | None = None,
        timeout: float | int = 10,
    ) -> dict:
        """Perform an HTTP request, gated by the plugin's allowlist.

        Returns {"status", "text", "headers", "ok"} — never the raw response
        object, so callers can't reach transport internals. Raises
        NetworkRuleNotAllowed when the URL isn't on the plugin's enabled rules.
        """
        from urllib.parse import urlparse
        if method.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            raise ValueError(f"不支持的 HTTP method: {method}")
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        if scheme not in ALLOWED_SCHEMES:
            raise ValueError(f"仅允许 http/https 请求，收到: {scheme}")
        host = parsed.hostname or ""
        if not host:
            raise ValueError(f"URL 缺少 host: {url}")
        port = parsed.port if parsed.port is not None else _default_port(scheme)

        if not await rule_is_allowed(self.plugin_id, self.user_id, scheme, host, port):
            raise NetworkRuleNotAllowed(
                f"URL 不在白名单: {scheme}://{host}:{port}"
            )

        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            resp = await client.request(method, url, headers=headers, json=data if data is not None else None)
        return {
            "ok": resp.status_code < 400,
            "status": resp.status_code,
            "text": resp.text,
            "headers": dict(resp.headers),
        }


class NetworkRuleNotAllowed(Exception):
    """Raised when a plugin's network_request hits a URL not on its allowlist."""


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


# ── Network allowlist validation ──────────────────────────────────
#
# A rule is {scheme, host, port}. host may be a literal hostname/IP or a
# wildcard `*.sub.example.com` (matches that domain and its subdomains, NOT the
# bare domain). Only http/https schemes are supported. Ports default to the
# scheme's standard port. All parsing/validation rejects invalid input rather
# than silently accepting it — bad manifest values fail install, bad user input
# fails with a clear 400.

ALLOWED_SCHEMES = {"http", "https"}
_WILDCARD_PREFIX = "*."


class NetworkRuleError(ValueError):
    """Raised on an invalid network allowlist rule."""


def _default_port(scheme: str) -> int:
    if scheme == "http":
        return 80
    if scheme == "https":
        return 443
    raise NetworkRuleError(f"不支持的协议 scheme: {scheme}（仅支持 http/https）")


def parse_network_rule(raw: dict) -> NetworkRule:
    """Validate and normalize a raw {scheme, host, port} manifest/user rule."""
    if not isinstance(raw, dict):
        raise NetworkRuleError("网络白名单规则必须是 JSON 对象")

    scheme = raw.get("scheme", "https")
    if scheme not in ALLOWED_SCHEMES:
        raise NetworkRuleError(f"scheme 非法: {scheme}（仅支持 http/https）")

    host = raw.get("host", "")
    if not isinstance(host, str) or not host.strip():
        raise NetworkRuleError("网络白名单规则缺少 host")
    host = host.strip().lower()
    if "://" in host or "/" in host or " " in host:
        raise NetworkRuleError(f"host 不能包含协议或路径: {host}")
    # wildcard only at the leftmost label
    if host.startswith(_WILDCARD_PREFIX):
        rest = host[len(_WILDCARD_PREFIX):]
        if not rest or "." not in rest:
            raise NetworkRuleError(f"通配符 host 无效: {host}（需形如 *.example.com）")
        if rest.startswith(_WILDCARD_PREFIX) or "*" in rest:
            raise NetworkRuleError(f"host 的 '*' 只能出现在最左段: {host}")
    elif "*" in host:
        raise NetworkRuleError(f"host 的 '*' 只能出现在最左段且形如 *.domain: {host}")

    port = raw.get("port")
    if port is not None:
        if isinstance(port, bool) or not isinstance(port, int):
            try:
                port = int(port)
            except (TypeError, ValueError):
                raise NetworkRuleError(f"port 必须是非负整数或省略: {port}")
        if not (1 <= port <= 65535):
            raise NetworkRuleError(f"port 超出范围 (1-65535): {port}")
    else:
        port = _default_port(scheme)

    return NetworkRule(scheme=scheme, host=host, port=port)


def host_matches(rule_host: str, actual_host: str) -> bool:
    """Whether an actual connected host satisfies a (literal or wildcard) rule host."""
    actual = actual_host.lower()
    if not rule_host.startswith(_WILDCARD_PREFIX):
        return rule_host == actual
    suffix = rule_host[len(_WILDCARD_PREFIX):]
    # *.example.com matches api.example.com / a.b.example.com, NOT bare example.com
    return actual.endswith("." + suffix)


async def rule_is_allowed(plugin_id: str, user_id: str, scheme: str, host: str, port: int) -> bool:
    """Whether (scheme, host, port) passes the plugin's *enabled* allowlist rules."""
    from .database.plugins import get_network_rules
    rows = await get_network_rules(plugin_id, user_id, enabled_only=True)
    for r in rows:
        if r["scheme"] not in (scheme, "*"):
            continue
        if not host_matches(r["host"], host):
            continue
        if r["port"] is not None and r["port"] != port:
            continue
        return True
    return False


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
            # has_frontend now means "has a declarative config panel", not an iframe.
            m.has_frontend = len(m.config) > 0
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

    ctx = PluginContext(manifest.id, user_id=user_id)
    lp = LoadedPlugin(manifest=manifest, context=ctx, user_id=user_id)

    plugin_dir = Path(manifest.source_path)
    backend_path = plugin_dir / "backend.py"
    if backend_path.exists():
        source = backend_path.read_text(encoding="utf-8")
        # Phase 2 gate: static safety check + restricted execution.
        from .plugin_runtime import validate_backend_source, safe_plugin_builtins, BackendUnsafeError
        try:
            validate_backend_source(source)
        except BackendUnsafeError as e:
            # A malformed/unsafe backend must not silently half-load.
            raise RuntimeError(f"插件 {manifest.id} 后端未通过安全校验: {e}")

        module_name = f"_plugin_{user_id}_{manifest.id.replace('-', '_')}"
        code = compile(source, str(backend_path), "exec")
        ns: dict = {
            "__name__": module_name,
            "__file__": str(backend_path),
            "__builtins__": safe_plugin_builtins(),
        }
        exec(code, ns)

        if callable(ns.get("on_load")):
            await ns["on_load"](ctx)

        if callable(ns.get("register_tools")):
            tools = ns["register_tools"]()
            lp.module = ns
            for tool_def in tools:
                name = tool_def["name"]
                executor = ns.get(f"execute_{name.lower()}") or ns.get(name)
                if callable(executor):
                    lp.tool_executors[name] = executor
        elif manifest.tools and lp.module is None:
            lp.module = ns
            for tool_def in manifest.tools:
                name = tool_def["name"]
                exec_fn = ns.get(f"execute_{name.lower()}")
                if callable(exec_fn):
                    lp.tool_executors[name] = exec_fn
    elif manifest.tools:
        # No backend: tools come solely from the manifest (no executors).
        pass

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


def get_tool_defs_from_plugins(user_id: str | None = None) -> list[dict]:
    """Collect tool definitions from loaded plugins for a given user.

    Each returned tool dict gets `_plugin_id` set so usage resolution can read
    the owning plugin's live data. Cross-user merging is removed: a tool only
    appears for the user who owns it. With no user_id (startup), returns only
    tool-shaped manifest entries (no _plugin_id enrichment beyond the entry).
    """
    defs: list[dict] = []
    seen: set[str] = set()
    for lp in loaded_plugins.values():
        if user_id and lp.user_id != user_id:
            continue
        for t in lp.manifest.tools:
            if t["name"] not in seen:
                enriched = dict(t)
                enriched.setdefault("_plugin_id", lp.manifest.id)
                defs.append(enriched)
                seen.add(t["name"])
    return defs


def get_tool_executors_from_plugins(user_id: str | None = None) -> dict[str, Any]:
    """Collect tool executors from loaded plugins for the given user (or all)."""
    execs: dict[str, Any] = {}
    for lp in loaded_plugins.values():
        if user_id and lp.user_id != user_id:
            continue
        execs.update(lp.tool_executors)
    return execs


def find_plugin_context_for_tool(tool_name: str, user_id: str) -> PluginContext | None:
    """Find the PluginContext for the loaded plugin (of this user) owning a tool.

    Strictly scoped to the given user_id — no cross-user fallback, so one user's
    plugin tool can never resolve to another user's backend context.
    """
    for lp in loaded_plugins.values():
        if lp.user_id == user_id and tool_name in lp.tool_executors:
            return lp.context
    return None


# ── Install / uninstall helpers ───────────────────────────────────


async def prevalidate_plugin_source(source: Path, expected_id: str | None = None) -> PluginManifest:
    """Validate a source zip/dir WITHOUT installing.

    - Extracts/reads plugin.json and parses the manifest.
    - Validates network allowlist rules.
    - Safety-checks backend.py (syntax + Phase-2 static whitelist) with a size cap.
    - Optionally checks the manifest id matches the expected id.
    Surfaces problems before anything is persisted.
    """
    import zipfile, tempfile
    if source.suffix == ".zip":
        with tempfile.TemporaryDirectory() as td:
            with zipfile.ZipFile(source, "r") as zf:
                for name in zf.namelist():
                    # zip-slip guard: reject entries escaping the extraction root
                    target = (Path(td) / name).resolve()
                    if not str(target).startswith(str(Path(td).resolve())):
                        raise NetworkRuleError(f"插件包包含非法路径: {name}")
                zf.extractall(td)
            manifest_rel = _find_manifest_dir(Path(td))
            return _prevalidate_dir(manifest_rel, expected_id)
    return _prevalidate_dir(source, expected_id)


def _find_manifest_dir(extracted: Path) -> Path:
    """Locate the directory that directly contains plugin.json, walking one level
    deep if a single top-level folder wraps the plugin (common zip layout)."""
    manifest = extracted / "plugin.json"
    if manifest.exists():
        return extracted
    for child in extracted.iterdir():
        if child.is_dir() and (child / "plugin.json").exists():
            return child
    raise NetworkRuleError("插件包缺少 plugin.json（未在包内找到）")


def _prevalidate_dir(plugin_dir: Path, expected_id: str | None) -> PluginManifest:
    manifest_path = plugin_dir / "plugin.json"
    if not manifest_path.exists():
        raise NetworkRuleError("插件包缺少 plugin.json")
    try:
        m = PluginManifest.from_json(manifest_path)
    except NetworkRuleError:
        raise
    except Exception as e:
        raise NetworkRuleError(f"plugin.json 解析失败: {e}")

    if expected_id and m.id != expected_id:
        raise NetworkRuleError(f"插件 id 不匹配: manifest 为 {m.id}，期望 {expected_id}")

    backend_path = plugin_dir / "backend.py"
    if backend_path.exists():
        m.has_backend = True
        if backend_path.stat().st_size > 64 * 1024:
            raise NetworkRuleError("backend.py 超过大小上限 (64KB)")
        from .plugin_runtime import validate_backend_source, BackendUnsafeError
        try:
            validate_backend_source(backend_path.read_text(encoding="utf-8"))
        except BackendUnsafeError as e:
            raise NetworkRuleError(f"backend.py 未通过安全校验: {e}")
    # has_frontend now means "has a declarative config panel", not an iframe.
    m.has_frontend = len(m.config) > 0

    return m


async def install_plugin_from_path(user_id: str, safe_name: str, source: Path) -> str:
    """Install a plugin from a directory or zip into the user's plugins directory.

    Pre-validates the source (manifest + network rules + backend syntax + zip
    traversal guard) before persisting anything. Returns the plugin id.
    """
    import zipfile

    # Pre-validate before touching the target dir.
    m = await prevalidate_plugin_source(source)
    user_dir = _user_plugins_dir(safe_name)

    if source.suffix == ".zip":
        with zipfile.ZipFile(source, "r") as zf:
            # Find the manifest id explicitly (don't trust archive layout).
            names = zf.namelist()
            # Locate plugin.json anywhere in the archive
            manifest_rel = next((n for n in names if n.endswith("plugin.json")), None)
            if not manifest_rel:
                raise NetworkRuleError("插件包缺少 plugin.json")
            dest = user_dir / m.id
            if dest.exists():
                shutil.rmtree(dest)
            # Extract only the sub-tree that contains plugin.json, preserving
            # relative structure under the manifest's parent directory.
            base = manifest_rel.rsplit("/", 1)[0] if "/" in manifest_rel else ""
            dest.mkdir(parents=True, exist_ok=True)
            for name in names:
                if name.startswith(base.rstrip("/") + "/") if base else True:
                    rel = name[len(base):].lstrip("/") if base else name
                    target = (dest / rel).resolve()
                    if not str(target).startswith(str(dest.resolve())):
                        raise NetworkRuleError(f"插件包包含非法路径: {name}")
                    if name.endswith("/"):
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(zf.read(name))
    elif source.is_dir():
        dest = user_dir / m.id
        if dest.exists():
            shutil.rmtree(dest)
        # Exclude .git: a git-cloned source shouldn't drag its repo metadata
        # (history, remote URLs, possibly credentials) into the plugin dir.
        shutil.copytree(source, dest, ignore=shutil.ignore_patterns(".git"))
    else:
        raise ValueError(f"Unsupported source type: {source}")

    return m.id


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
