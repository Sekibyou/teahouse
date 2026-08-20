"""
Teahouse — 配置管理
"""
import os
import secrets
import sys
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field, field_validator

from .database.crypto import generate_master_key


class LLMConfig(BaseModel):
    url: str = Field(description="LLM API endpoint URL")
    key: str = Field(description="LLM API key")
    model: str = Field(default="claude-sonnet-5", description="Default model ID")
    api_style: str = Field(default="openai", description="API protocol: anthropic or openai")
    max_tokens: int = Field(default=8192, ge=1)
    max_context: int = Field(default=131072, ge=1024, description="Maximum context window size in tokens for auto-compact threshold")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None


class ServerConfig(BaseModel):
    host: str = Field(default="127.0.0.1", description="Bind address; 127.0.0.1 is the safe default (localhost only), set 0.0.0.0 to expose on the LAN")
    port: int = Field(default=8888, ge=1024, le=65535)

    @field_validator("port", mode="before")
    @classmethod
    def _port_from_env(cls, v):
        # 允许用环境变量 TEAHOUSE_SERVER_PORT 覆盖端口,优先级高于 yaml。
        # 生产/正式服务照读 yaml;开发脚本用环境变量切到独立端口,避开生产端口占用。
        env_port = os.getenv("TEAHOUSE_SERVER_PORT")
        if env_port:
            try:
                return int(env_port)
            except ValueError:
                raise ValueError(f"TEAHOUSE_SERVER_PORT 必须是整数, 得到 {env_port!r}")
        return v


class AuthConfig(BaseModel):
    admin_password: str = Field(
        default="",
        description="Super admin (username 'admin') password — the ONLY source of truth for it. "
        "Set in teahouse.yaml; if missing/empty it is auto-generated and written back on startup. "
        "On every startup this value overrides the password stored in the database.",
    )
    allow_registration: bool = Field(
        default=False,
        description="Whether self-service registration via POST /api/auth/register is open. "
        "Closed by default; enable to allow anyone to create a regular user account.",
    )


def _project_root() -> Path:
    """Absolute project root — the base for teahouse.yaml and relative workspace_base.

    Deterministic anchor so config/db/workspace paths do NOT depend on the
    process CWD — which previously let a service started from a subdirectory
    (e.g. ``src/``) silently create an empty `data/teahouse.db` shell and a
    duplicate config next to it, distinct from the real one at the project root.

    In source mode it is two levels above this package's directory (the project
    root). In a PyInstaller bundle it is the directory containing the exe, so
    teahouse.yaml and the default relative data/ live right next to Teahouse.exe
    (green/portable layout); `_MEIPASS` (the _internal/ tree) is NOT used here
    because teahouse.yaml must be user-writable, not inside the read-only bundle.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


class Config(BaseModel):
    jwt_secret: str = Field(description="JWT signing key, auto-generated on first run")
    master_key: str = Field(default="", description="Master key for LLM API key encryption; auto-generated if empty")
    server: ServerConfig = Field(default_factory=ServerConfig)
    llm: Optional[LLMConfig] = None
    auth: AuthConfig = Field(default_factory=AuthConfig)
    workspace_base: str = Field(
        default="data",
        description="User data root directory. Relative paths anchor to the project root; "
        "absolute paths (e.g. C:\\data) are used as-is. The SQLite DB lives at "
        "<workspace_base>/teahouse.db.",
    )

    @classmethod
    def default_path(cls) -> Path:
        return _project_root() / "teahouse.yaml"

    def _anchor_paths(self) -> None:
        """Resolve the workspace_base against the project root.

        Makes the service CWD-independent: instance data is anchored to the
        project root instead of whatever directory the process was launched
        from (see _project_root for the failure this prevents). Absolute paths
        configured explicitly are respected as-is.
        """
        root = _project_root()
        if not os.path.isabs(self.workspace_base):
            self.workspace_base = str(root / self.workspace_base)

    @property
    def db_path(self) -> str:
        """Absolute path to the SQLite database (always inside workspace_base)."""
        return str(Path(self.workspace_base) / "teahouse.db")

    @classmethod
    def load_or_create(cls, path: Optional[Path] = None) -> "Config":
        path = path or cls.default_path()
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}

            # Auto-migrate: fill in missing keys for config schema changes
            changed = _migrate_config(data)

            cfg = cls.model_validate(data)

            # Auto-fill master_key if missing (config migration from older versions)
            if not cfg.master_key:
                cfg.master_key = generate_master_key()
                data["master_key"] = cfg.master_key
                changed = True

            # Auto-fill super admin password if missing (yaml is its only source of truth)
            if not cfg.auth.admin_password:
                pw = secrets.token_urlsafe(16)
                cfg.auth.admin_password = pw
                data.setdefault("auth", {})["admin_password"] = pw
                changed = True

            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
                    print(f"[teahouse] config auto-migrated at {path}")

            cfg._anchor_paths()
            return cfg

        # first run: generate jwt secret, master key, and a random super admin password
        admin_password = secrets.token_urlsafe(16)
        cfg = cls(
            jwt_secret=secrets.token_urlsafe(32),
            master_key=generate_master_key(),
            auth=AuthConfig(admin_password=admin_password),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(
                cfg.model_dump(mode="python"),
                f,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )
        print(f"[teahouse] config created at {path}")
        # Print the super admin password ONLY on first-time config creation, so the
        # owner can log in once; afterwards it lives solely in teahouse.yaml.
        print(f"[teahouse] 超级管理员 admin 初始密码: {admin_password} (已写入 {path})")
        cfg._anchor_paths()
        return cfg


def _migrate_config(data: dict) -> bool:
    """Fill in missing keys for config schema changes. Returns True if changed."""
    changed = False
    if "master_key" not in data:
        data["master_key"] = ""
        changed = True
    if "workspace_base" not in data:
        data["workspace_base"] = "data"
        changed = True
    if "server" not in data:
        data["server"] = {"host": "127.0.0.1", "port": 8888}
        changed = True
    if "jwt_secret" not in data and "secret_key" in data:
        # Carry over existing secret_key to jwt_secret, drop the old name
        data["jwt_secret"] = data.pop("secret_key")
        changed = True
    if "auth" not in data:
        data["auth"] = {"admin_password": "", "allow_registration": False}
        changed = True
    return changed
