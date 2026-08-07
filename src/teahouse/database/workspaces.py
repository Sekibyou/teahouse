"""
Prototype and instance CRUD operations, plus file system helpers.

Directory layout:
    data/{user_safe_name}/
        instances/
        prototypes/
"""
from __future__ import annotations

import os
import json
import base64
import shutil
import stat
import zipfile
import hashlib
import mimetypes
from pathlib import Path
from typing import Optional

from .connection import generate_uuid, current_timestamp, execute, fetch_one, fetch_all
from ..git_utils import git_init, git_initial_commit

# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------

BLANK_PROTOTYPE_DIR = Path(__file__).parent.parent / "prototypes" / "blank"

# All built-in prototype directories live under prototypes/
PROTOTYPES_DIR = Path(__file__).parent.parent / "prototypes"


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
    content_hash: str = "",
) -> dict:
    now = current_timestamp()
    proto_id = generate_uuid()
    await execute(
        "INSERT INTO prototypes (id, user_id, name, description, source_path, is_builtin, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (proto_id, user_id, name, description, source_path, 1 if is_builtin else 0, content_hash, now, now),
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


async def find_prototype_by_hash(content_hash: str, user_id: str) -> Optional[dict]:
    """Check if user already has a prototype with the same content hash."""
    return await fetch_one(
        "SELECT * FROM prototypes WHERE content_hash = ? AND user_id = ? AND content_hash != ''",
        (content_hash, user_id),
    )


# ---------------------------------------------------------------------------
# Instances
# ---------------------------------------------------------------------------

async def list_instances(user_id: str) -> list[dict]:
    rows = await fetch_all(
        """SELECT i.*, p.name AS prototype_name
           FROM instances i
           LEFT JOIN prototypes p ON i.prototype_id = p.id
           WHERE i.user_id = ?
           ORDER BY i.created_at DESC""",
        (user_id,),
    )
    # Override the stale DB floor_count with a live count from the working
    # floor history (.teahouse/output/floors/). Lazy import to avoid a cycle.
    from ..director_system import get_floors_stats
    for inst in rows:
        dir_path = inst.get("dir_path")
        if not dir_path:
            inst["floor_count"] = 0
            continue
        stats = get_floors_stats(Path(dir_path))
        inst["floor_count"] = stats["total_floors"] if stats else 0
    return rows


async def get_instance(instance_id: str) -> Optional[dict]:
    return await fetch_one(
        """SELECT i.*, p.name AS prototype_name
           FROM instances i
           LEFT JOIN prototypes p ON i.prototype_id = p.id
           WHERE i.id = ?""",
        (instance_id,),
    )


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


async def update_floor_count(instance_id: str, count: int) -> None:
    """Update the floor_count for an instance."""
    await execute(
        "UPDATE instances SET floor_count = ?, updated_at = ? WHERE id = ?",
        (count, current_timestamp(), instance_id),
    )


def summary_file_name(start: int, end: int) -> str:
    """Return the summary ledger file name for covering floors start..end (inclusive).

    Naming rule: floors x..y (inclusive) -> sum-x-y.md; a single floor x -> sum-x.md.
    """
    return f"sum-{start}.md" if start == end else f"sum-{start}-{end}.md"


def update_summary_index(instance_dir: Path, start: int, end: int) -> str:
    """Record a summary range in summary/index.json (authoritative archive boundary).

    Called by the backend on GitCommit(type="summary", start, end). Appends one
    entry per call (deduped by exact range) and advances summarized_through to the
    reported `end`. Returns the ledger file path written for reference.
    """
    idx_path = instance_dir / "summary" / "index.json"
    if idx_path.exists():
        data = json.loads(idx_path.read_text(encoding="utf-8"))
    else:
        data = {"summarized_through": None, "entries": []}

    entries = data.setdefault("entries", [])
    if not any(e.get("start") == start and e.get("end") == end for e in entries):
        file = summary_file_name(start, end)
        entries.append({"start": start, "end": end, "file": file})

    data["summarized_through"] = max(
        (data.get("summarized_through") or 0), end
    )

    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str((idx_path.parent / summary_file_name(start, end)).as_posix())


def copy_instance(
    source_inst: dict,
    target_dir: Path,
) -> str:
    """Snapshot-copy the full source instance dir to target_dir (new instance).

    Copies everything (floors, .teahouse/, settings/, skills/, assets/,
    building/, ...) and re-initializes git, mirroring instantiate_prototype's
    commit behavior. Returns the new dir_path (target_dir)."""
    target_dir.mkdir(parents=True, exist_ok=True)
    source_dir = Path(source_inst["dir_path"])

    # Full snapshot copy
    shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)

    # Drop the copied history so the copy becomes a fresh independent repo
    _git_dir = target_dir / ".git"
    if _git_dir.exists():
        shutil.rmtree(_git_dir, ignore_errors=True)

    # Re-init git so the copy has a clean initial commit
    try:
        git_init(target_dir)
        git_initial_commit(target_dir)
    except Exception:
        pass  # git not available — instance works without version control

    return str(target_dir.resolve())


# ---------------------------------------------------------------------------
# Instance creation from prototype
# ---------------------------------------------------------------------------

def instantiate_prototype(proto: dict, target_dir: Path, base_path: Path) -> None:
    """Copy prototype source into target_dir. Handles zip and folder sources."""
    target_dir.mkdir(parents=True, exist_ok=True)

    source_path = base_path / proto["source_path"] if not Path(proto["source_path"]).is_absolute() else Path(proto["source_path"])

    if proto["is_builtin"]:
        # Built-in: copy from its source template directory
        source_dir = Path(proto["source_path"])
        if not source_dir.is_dir():
            raise FileNotFoundError(f"Built-in prototype directory not found: {source_dir}")
        _copy_dir(source_dir, target_dir)
    elif source_path.suffix in (".zip", ".teabrew") and source_path.exists():
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


def list_builtin_prototype_dirs() -> list[Path]:
    """Scan prototypes/ directory for all built-in prototype subdirectories."""
    if not PROTOTYPES_DIR.is_dir():
        return []
    return sorted(
        [p for p in PROTOTYPES_DIR.iterdir() if p.is_dir()],
        key=lambda p: p.name,
    )


def read_prototype_readme(proto_dir: Path) -> str:
    """Read README.md from a prototype directory. Returns empty string if not found."""
    readme_path = proto_dir / "README.md"
    if readme_path.exists():
        return readme_path.read_text(encoding="utf-8")
    return ""


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
            # Hide the director's session memory so it never surfaces in the
            # file tree (it holds conversation history, not editable content).
            if entry.name == ".sessions":
                continue
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


def _resolve_full(instance_dir: Path, file_path: str) -> Path:
    """Resolve a instance-relative path with traversal protection."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    return full


class TextDecodeError(ValueError):
    """The target file is not valid UTF-8 text; it should be read via read_asset."""


def read_text(instance_dir: Path, file_path: str) -> str:
    """Read a UTF-8 text file's contents.

    Raises FileNotFoundError / IsADirectoryError, or TextDecodeError when the
    file is not valid UTF-8 (i.e. it's a binary asset — use read_asset instead).
    """
    full = _resolve_full(instance_dir, file_path)
    try:
        return full.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise TextDecodeError(
            f"'{file_path}' is not UTF-8 text (binary asset). Use the asset "
            f"reader for images/audio/fonts."
        ) from e


# Magic-byte signature → MIME type. Checked before mimetypes.guess_type falls
# back to the file extension; order matters (longer, more specific sigs first).
_MIME_BY_SIGNATURE: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"<svg", "image/svg+xml"),
    (b"wOFF2", "font/woff2"),
    (b"wOFF", "font/woff"),
    (b"\x00\x01\x00\x00\x00", "font/ttf"),  # TrueType
    (b"OTTO", "font/otf"),
    (b"\x00\x00\x01\x00", "font/ttc"),  # TrueType collection
    (b"ID3", "audio/mpeg"),
    (b"\xff\xfb", "audio/mpeg"),  # MPEG frame sync (ISO 13818-3)
    (b"OggS", "audio/ogg"),
    (b"fLaC", "audio/flac"),
    (b"PK\x03\x04", "application/zip"),  # also covers .docx/.epub/.teabrew
)


def _detect_mime(raw: bytes, filename: str) -> str:
    """Detect a file's MIME from magic bytes, falling back to the extension."""
    if raw.startswith(b"RIFF") and len(raw) >= 12 and raw[8:12] == b"WEBP":
        return "image/webp"
    for sig, mime in _MIME_BY_SIGNATURE:
        if raw.startswith(sig):
            return mime
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def read_asset(instance_dir: Path, file_path: str) -> tuple[str, str]:
    """Read a binary asset's contents.

    Returns (mime, base64_data) where base64_data has no prefix; callers build
    `data:{mime};base64,{data}`. Any file type is accepted — MIME is detected
    from magic bytes, so the caller's extension is not trusted/required.
    """
    full = _resolve_full(instance_dir, file_path)
    raw = full.read_bytes()
    return _detect_mime(raw, full.name), base64.b64encode(raw).decode("ascii")


def write_file(instance_dir: Path, file_path: str, content: str) -> None:
    """Write content to a file. Creates parent directories if needed."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Runtime vars — .teahouse/runtime_vars.jsonl
#
# The single authority for instance variables ("文件即状态"). jsonl: one variable
# per line, each a JSON object that can carry optional metadata:
#     {"name":"金币","value":140}
#     {"name":"修为","value":"炼气四层"}
#     {"name":"A_擂台赛胜负","value":"2胜1负","note":"仅本剧本段",
#      "change_log":[{"at":"floor-010","to":"1胜0负","why":"首胜"}]}
# Convention:
#   - Values are any JSON-serializable object.
#   - `note` is overwritten on update; `change_log` is appended on update.
#   - SetRuntimeVar writes, GetRuntimeVars reads, delete removes a name.
# ---------------------------------------------------------------------------

_RUNTIME_VARS_PATH = ".teahouse/runtime_vars.jsonl"


def _runtime_vars_path(instance_dir: Path) -> Path:
    full = (instance_dir / _RUNTIME_VARS_PATH).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    return full


def read_sandbox_vars(instance_dir: Path, names: list[str] | None = None) -> list[dict]:
    """Read runtime vars as a flat list of {name, value, note?, change_log?}.

    - `names` = None (or empty): return every initialized variable.
    - `names` = requested list: return **exactly one entry per requested name**,
      using `value: None` for uninitialized names, so callers can check "not set"
      explicitly instead of guessing from a missing key.

    Missing file behaves like an empty store.
    """
    full = _runtime_vars_path(instance_dir)
    data: dict[str, dict] = {}
    if full.exists():
        try:
            for line in full.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and "name" in entry and "value" in entry:
                    data[entry["name"]] = entry
        except OSError:
            data = {}

    if names:
        out = []
        for n in names:
            if n in data:
                out.append(dict(data[n]))
            else:
                out.append({"name": n, "value": None})
        return out
    return [dict(data[k]) for k in data]


def write_sandbox_vars(
    instance_dir: Path,
    updates: dict,
    note: dict | None = None,
    change_log: dict | None = None,
) -> None:
    """Merge variables into the jsonl file.

    - `updates`: {name: value} — overwrite the value.
    - `note`: {name: content} — overwrite that variable's note.
    - `change_log`: {name: entry} — append an entry to that variable's change_log
      list (each entry is a JSON-serializable object, e.g. {"at","to","why"}).

    Missing names in updates are created (with optional metadata). No name is
    ever duplicated — one line per name.
    """
    full = _runtime_vars_path(instance_dir)
    data: dict[str, dict] = {}

    if full.exists():
        try:
            for line in full.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and "name" in entry:
                    data[entry["name"]] = entry
        except OSError:
            data = {}

    note = note or {}
    change_log = change_log or {}

    for name, value in updates.items():
        entry = data.get(name, {"name": name})
        entry["value"] = value
        data[name] = entry
    for name, content in note.items():
        entry = data.get(name, {"name": name, "value": None})
        entry["note"] = content
        data[name] = entry
    for name, entry_item in change_log.items():
        entry = data.get(name, {"name": name, "value": None})
        log = entry.get("change_log")
        if not isinstance(log, list):
            log = []
        log.append(entry_item)
        entry["change_log"] = log
        data[name] = entry

    full.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(data[k], ensure_ascii=False) for k in data]
    full.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def delete_sandbox_vars(instance_dir: Path, names: list[str]) -> None:
    """Remove named variables from the jsonl file (their lines are dropped)."""
    full = _runtime_vars_path(instance_dir)
    if not full.exists():
        return
    remove = set(names)
    try:
        lines = full.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    kept = []
    for line in lines:
        st = line.strip()
        if not st:
            continue
        try:
            entry = json.loads(st)
        except json.JSONDecodeError:
            kept.append(line)
            continue
        if isinstance(entry, dict) and "name" in entry and entry["name"] in remove:
            continue  # drop
        kept.append(line)
    if not kept:
        full.unlink()
    else:
        full.write_text("\n".join(kept) + "\n", encoding="utf-8")


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
