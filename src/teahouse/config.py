"""
Teahouse — 配置管理
"""
import os
import secrets
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field

from .database.crypto import generate_master_key


class LLMConfig(BaseModel):
    url: str = Field(description="LLM API endpoint URL")
    key: str = Field(description="LLM API key")
    model: str = Field(default="claude-sonnet-5", description="Default model ID")
    api_style: str = Field(default="openai", description="API protocol: anthropic or openai")
    max_tokens: int = Field(default=8192, ge=1)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None


class ServerConfig(BaseModel):
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8888, ge=1024, le=65535)


class DbConfig(BaseModel):
    path: str = Field(default="data/teahouse.db", description="SQLite database file path")
    workspace_base: str = Field(default="data", description="Workspace data directory path")


def _project_root() -> Path:
    """Absolute project root (two levels above this package's directory).

    Deterministic anchor so config/db/workspace paths do NOT depend on the
    process CWD — which previously let a service started from a subdirectory
    (e.g. ``src/``) silently create an empty `data/teahouse.db` shell and a
    duplicate config next to it, distinct from the real one at the project root.
    """
    return Path(__file__).resolve().parents[2]


class Config(BaseModel):
    jwt_secret: str = Field(description="JWT signing key, auto-generated on first run")
    master_key: str = Field(default="", description="Master key for LLM API key encryption; auto-generated if empty")
    server: ServerConfig = Field(default_factory=ServerConfig)
    db: DbConfig = Field(default_factory=DbConfig)
    llm: Optional[LLMConfig] = None

    @classmethod
    def default_path(cls) -> Path:
        return _project_root() / "teahouse.yaml"

    def _anchor_paths(self) -> None:
        """Resolve relative db/workspace paths against the project root.

        Makes the service CWD-independent: db path and workspace_base are
        anchored to the project root instead of whatever directory the process
        was launched from (see _project_root for the failure this prevents).
        Absolute paths configured explicitly are respected as-is.
        """
        root = _project_root()
        if not os.path.isabs(self.db.path):
            self.db.path = str(root / self.db.path)
        if not os.path.isabs(self.db.workspace_base):
            self.db.workspace_base = str(root / self.db.workspace_base)

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

            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
                    print(f"[teahouse] config auto-migrated at {path}")

            cfg._anchor_paths()
            return cfg

        # first run: generate jwt secret and master key only (no default LLM config)
        cfg = cls(
            jwt_secret=secrets.token_urlsafe(32),
            master_key=generate_master_key(),
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
        cfg._anchor_paths()
        return cfg


def _migrate_config(data: dict) -> bool:
    """Fill in missing keys for config schema changes. Returns True if changed."""
    changed = False
    if "master_key" not in data:
        data["master_key"] = ""
        changed = True
    if "db" not in data:
        data["db"] = {"path": "data/teahouse.db", "workspace_base": "data"}
        changed = True
    if "workspace_base" not in data.get("db", {}):
        data.setdefault("db", {})["workspace_base"] = "data"
        changed = True
    if "server" not in data:
        data["server"] = {"host": "0.0.0.0", "port": 8888}
        changed = True
    if "jwt_secret" not in data and "secret_key" in data:
        # Carry over existing secret_key to jwt_secret, drop the old name
        data["jwt_secret"] = data.pop("secret_key")
        changed = True
    return changed
