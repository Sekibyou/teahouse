"""
Prototype and instance CRUD operations, plus file system helpers.

Directory layout:
    data/{user_safe_name}/
        instances/
        prototypes/
"""
from __future__ import annotations

import os
import shutil
import stat
import zipfile
from pathlib import Path
from typing import Optional

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all
from ..git_utils import git_init, git_initial_commit

# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------

BLANK_PROTOTYPE_DIR = Path(__file__).parent.parent / "prototypes" / "blank"


def _user_dir(safe_name: str, base_path: Path) -> Path:
    return base_path / safe_name


def ensure_user_dirs(safe_name: str, base_path: Path) -> tuple[Path, Path]:
    """Ensure user data directories exist. Returns (instances_dir, prototypes_dir)."""
    user_dir = _user_dir(safe_name, base_path)
    instances_dir = user_dir / "instances"
    prototypes_dir = user_dir / "prototypes"
    instances_dir.mkdir(parents=True, exist_ok=True)
    prototypes_dir.mkdir(parents=True, exist_ok=True)
    return instances_dir, prototypes_dir


# ---------------------------------------------------------------------------
# Prototypes
# ---------------------------------------------------------------------------

async def list_prototypes(user_id: str | None = None) -> list[dict]:
    """List prototypes visible to a user (their own + built-in)."""
    return await fetch_all(
        "SELECT * FROM prototypes WHERE user_id = ? OR is_builtin = 1 ORDER BY is_builtin DESC, created_at DESC",
        (user_id,),
    )


async def get_prototype(prototype_id: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM prototypes WHERE id = ?", (prototype_id,))


async def create_prototype(
    user_id: str | None,
    name: str,
    description: str,
    source_path: str,
    is_builtin: bool = False,
) -> dict:
    now = current_timestamp()
    proto_id = generate_uuid()
    await execute(
        "INSERT INTO prototypes (id, user_id, name, description, source_path, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (proto_id, user_id, name, description, source_path, 1 if is_builtin else 0, now, now),
    )
    return await get_prototype(proto_id)


async def delete_prototype(prototype_id: str) -> bool:
    proto = await get_prototype(prototype_id)
    if not proto:
        return False
    if proto["is_builtin"]:
        return False  # cannot delete built-in
    # Delete the zip file
    source = Path(proto["source_path"])
    if source.exists():
        source.unlink()
    await execute("DELETE FROM prototypes WHERE id = ?", (prototype_id,))
    return True


# ---------------------------------------------------------------------------
# Instances
# ---------------------------------------------------------------------------

async def list_instances(user_id: str) -> list[dict]:
    return await fetch_all(
        "SELECT * FROM instances WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    )


async def get_instance(instance_id: str) -> Optional[dict]:
    return await fetch_one("SELECT * FROM instances WHERE id = ?", (instance_id,))


async def create_instance(
    user_id: str,
    prototype_id: str,
    name: str,
    dir_path: str,
) -> dict:
    now = current_timestamp()
    inst_id = generate_uuid()
    await execute(
        "INSERT INTO instances (id, user_id, prototype_id, name, dir_path, floor_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (inst_id, user_id, prototype_id, name, dir_path, 0, "active", now, now),
    )
    return await get_instance(inst_id)


async def delete_instance(instance_id: str) -> bool:
    inst = await get_instance(instance_id)
    if not inst:
        return False
    # Delete the instance directory
    dir_path = Path(inst["dir_path"])
    if dir_path.exists():

        def _on_rm_error(func, path, exc_info):
            os.chmod(path, stat.S_IWRITE)
            func(path)

        shutil.rmtree(dir_path, onerror=_on_rm_error)
    await execute("DELETE FROM instances WHERE id = ?", (instance_id,))
    return True


# ---------------------------------------------------------------------------
# Instance creation from prototype
# ---------------------------------------------------------------------------

def instantiate_prototype(proto: dict, target_dir: Path, base_path: Path) -> None:
    """Copy prototype source into target_dir. Handles zip and folder sources."""
    target_dir.mkdir(parents=True, exist_ok=True)

    source_path = base_path / proto["source_path"] if not Path(proto["source_path"]).is_absolute() else Path(proto["source_path"])

    if proto["is_builtin"]:
        # Built-in: copy from template directory
        _copy_dir(BLANK_PROTOTYPE_DIR, target_dir)
    elif source_path.suffix == ".zip" and source_path.exists():
        with zipfile.ZipFile(source_path, "r") as zf:
            zf.extractall(target_dir)
    elif source_path.is_dir():
        _copy_dir(source_path, target_dir)

    # Initialize git repository for the instance
    try:
        git_init(target_dir)
        git_initial_commit(target_dir)
    except Exception:
        pass  # git not available — instance works without version control


def register_builtin_prototype_source_path(base_path: Path) -> str:
    """Return the source_path value for the built-in blank prototype."""
    return str(BLANK_PROTOTYPE_DIR.resolve())


# ---------------------------------------------------------------------------
# File system operations for instances
# ---------------------------------------------------------------------------

def list_file_tree(instance_dir: Path) -> list[dict]:
    """Return a nested tree of files and directories."""

    def walk(dir_path: Path, relative_to: Path) -> list[dict]:
        items: list[dict] = []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return items
        for entry in entries:
            rel = str(entry.relative_to(relative_to)).replace("\\", "/")
            if entry.is_dir():
                items.append({
                    "name": entry.name,
                    "path": rel,
                    "type": "directory",
                    "children": walk(entry, relative_to),
                })
            else:
                items.append({
                    "name": entry.name,
                    "path": rel,
                    "type": "file",
                })
        return items

    return walk(instance_dir, instance_dir)


def read_file(instance_dir: Path, file_path: str) -> str:
    """Read a file's contents. Raises FileNotFoundError or IsADirectoryError."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    return full.read_text(encoding="utf-8")


def write_file(instance_dir: Path, file_path: str, content: str) -> None:
    """Write content to a file. Creates parent directories if needed."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def delete_file_or_dir(instance_dir: Path, file_path: str) -> None:
    """Delete a file or empty directory."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    if not full.exists():
        raise FileNotFoundError(file_path)
    if full.is_dir():
        full.rmdir()  # only removes if empty
    else:
        full.unlink()


def create_file_or_dir(instance_dir: Path, file_path: str, item_type: str) -> None:
    """Create a file or directory."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    if full.exists():
        raise FileExistsError(file_path)
    if item_type == "directory":
        full.mkdir(parents=True)
    else:
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text("", encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _copy_dir(src: Path, dst: Path) -> None:
    """Recursively copy a directory."""
    if not src.is_dir():
        return
    shutil.copytree(src, dst, dirs_exist_ok=True)
