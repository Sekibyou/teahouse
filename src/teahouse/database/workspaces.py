"""
Prototype and instance CRUD operations, plus file system helpers.

Directory layout:
    data/{user_safe_name}/
        instances/
        prototypes/
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

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


def _load_builtin_prototype_registry() -> dict[str, str]:
    """Read prototypes/registry.json into a folder-name -> title map."""
    reg_path = PROTOTYPES_DIR / "registry.json"
    try:
        if reg_path.exists():
            import json
            data = json.loads(reg_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items()}
    except Exception:
        pass
    return {}


# Built-in prototype title registry: folder-name -> display title.
# Optional file at PROTOTYPES_DIR/registry.json. Prototypes listed here show
# only this title (no README-derived subtitle); unlisted ones fall back to
# their folder name.
BUILTIN_PROTOTYPE_REGISTRY: dict[str, str] = _load_builtin_prototype_registry()


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
    # floor history (runtime/floors/). Lazy import to avoid a cycle.
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


async def update_instance_name(instance_id: str, name: str) -> dict | None:
    """Update an instance's display name. Returns the updated instance or None."""
    await execute(
        "UPDATE instances SET name = ?, updated_at = ? WHERE id = ?",
        (name, current_timestamp(), instance_id),
    )
    return await get_instance(instance_id)


def summary_file_name(start: int, end: int) -> str:
    """Return the summary ledger file name for covering floors start..end (inclusive).

    Naming rule: floors x..y (inclusive) -> sum-x-y.md; a single floor x -> sum-x.md.
    """
    return f"sum-{start}.md" if start == end else f"sum-{start}-{end}.md"


# Dynamic settings dir: mutable author settings. Lives under settings/ (git-tracked)
# and is scoped by summary commits. Distinct from settings/static_settings/ (long-term
# stable background, also git-tracked in this engine). Summary ledger + archive index
# live in the top-level summary/ dir (SUMMARY_REL), separate from the settings content.
DYN_SETTINGS_REL = "settings/dyn_settings"
SUMMARY_REL = "summary"


def update_summary_index(instance_dir: Path, start: int, end: int) -> str:
    """Record a summary range in <summary>/index.json (authoritative archive boundary).

    Called by the backend on GitCommit(type="summary", start, end). Appends one
    entry per call (deduped by exact range) and advances summarized_through to the
    reported `end`. Returns the ledger file path written for reference.
    """
    idx_path = instance_dir / SUMMARY_REL / "index.json"
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

    Copies everything (floors, runtime/, settings/, skills/, assets/,
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
    except Exception as e:
        logger.warning("Failed to init git for copied instance %s: %s", target_dir, e)

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
    except Exception as e:
        logger.warning("Failed to init git for new instance %s: %s", target_dir, e)


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


def _image_size(raw: bytes) -> tuple[int, int] | None:
    """Read (width, height) from PNG/JPEG/WebP headers without a decoder.

    Returns None for non-image or unknown formats. Used to drive the frontend's
    masonry layout so each cover keeps its intrinsic aspect ratio; no Pillow
    dependency is introduced.
    """
    try:
        # PNG: IHDR chunk at fixed offset; width/height are big-endian u32.
        if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) >= 24:
            return (
                int.from_bytes(raw[16:20], "big"),
                int.from_bytes(raw[20:24], "big"),
            )
        # JPEG: scan markers for an SOFn segment.
        if raw.startswith(b"\xff\xd8"):
            i = 2
            while i + 9 < len(raw):
                if raw[i] != 0xFF:
                    i += 1
                    continue
                marker = raw[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
                    if i + 9 < len(raw):
                        return (
                            int.from_bytes(raw[i + 7 : i + 9], "big"),
                            int.from_bytes(raw[i + 5 : i + 7], "big"),
                        )
                    return None
                # Standalone marker (no length) — skip 2 bytes.
                if marker in (0x01, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9):
                    i += 2
                    continue
                if marker == 0x00 or marker == 0xFF:
                    i += 1
                    continue
                seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
                i += 2 + seg_len
            return None
        # WebP: VP8/VP8L/VP8X.
        if raw.startswith(b"RIFF") and len(raw) >= 30 and raw[8:12] == b"WEBP":
            fmt = raw[12:16]
            if fmt in (b"VP8X",) and len(raw) >= 30:
                w = 1 + int.from_bytes(raw[24:27], "little")
                h = 1 + int.from_bytes(raw[27:30], "little")
                return w, h
            if fmt == b"VP8 " and len(raw) >= 30:
                w = int.from_bytes(raw[26:28], "little")
                h = int.from_bytes(raw[28:30], "little")
                return w, h
            if fmt == b"VP8L" and len(raw) >= 25:
                b = raw[21:25]
                bits = int.from_bytes(b, "little")
                w = (bits & 0x3FFF) + 1
                h = ((bits >> 14) & 0x3FFF) + 1
                return w, h
            return None
    except (ValueError, IndexError):
        return None
    return None


def read_asset(instance_dir: Path, file_path: str) -> tuple[str, str, tuple[int, int] | None]:
    """Read a binary asset's contents.

    Returns (mime, base64_data, size) where base64_data has no prefix; callers
    build `data:{mime};base64,{data}`, and `size` is (width, height) for images
    (None otherwise). Any file type is accepted — MIME is detected from magic
    bytes, so the caller's extension is not trusted/required.
    """
    full = _resolve_full(instance_dir, file_path)
    raw = full.read_bytes()
    return _detect_mime(raw, full.name), base64.b64encode(raw).decode("ascii"), _image_size(raw)


def read_prototype_cover(source_path: str, is_builtin: bool) -> tuple[str, str, tuple[int, int] | None] | None:
    """Read a prototype's cover image (cover.jpg/.jpeg/.png/.webp at root).

    Mirrors the README dual-branch pattern: built-in prototypes store files on
    disk under `source_path` (a directory), user-created prototypes pack them
    inside the `.teabrew` zip. Returns (mime, base64_data, size) or None when no
    cover exists — `size` being (width, height) for images. Callers build
    `data:{mime};base64,{data}`.
    """
    source = Path(source_path).resolve()

    def _pick(candidates: list[Path]) -> bytes | None:
        for c in candidates:
            try:
                return c.read_bytes()
            except OSError:
                continue
        return None

    if is_builtin:
        cover_names = ("cover.jpg", "cover.jpeg", "cover.png", "cover.webp")
        raw = _pick([source / n for n in cover_names])
        if raw is None:
            return None
        return _detect_mime(raw, source.name), base64.b64encode(raw).decode("ascii"), _image_size(raw)

    if not source.is_file():
        return None
    with zipfile.ZipFile(source, "r") as zf:
        for name in ("cover.jpg", "cover.jpeg", "cover.png", "cover.webp"):
            try:
                raw = zf.read(name)
            except KeyError:
                continue
            return _detect_mime(raw, name), base64.b64encode(raw).decode("ascii"), _image_size(raw)
    return None


def write_file(instance_dir: Path, file_path: str, content: str) -> None:
    """Write content to a file. Creates parent directories if needed."""
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def write_asset(instance_dir: Path, file_path: str, data: bytes) -> None:
    """Write binary content to a file. Creates parent directories if needed.

    Mirrors write_file's path-traversal guard but handles arbitrary bytes
    (images/audio/fonts), not just UTF-8 text.
    """
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)


# ---------------------------------------------------------------------------
# Runtime vars — runtime/runtime_vars.jsonl
#
# The single authority for instance variables ("文件即状态"). jsonl: one variable
# per line, each a JSON object that can carry optional metadata:
#     {"name":"金币","value":140,"type":"number","min":0,"max":1000}
#     {"name":"修为","value":"炼气四层","type":"string"}
#     {"name":"A_擂台赛胜负","value":"2胜1负","note":"仅本剧本段",
#      "change_log":[{"at":"floor-010","to":"1胜0负","why":"首胜"}]}
# Convention:
#   - Values are any JSON-serializable object.
#   - `type` is the declared strong type of the variable, one of:
#       number | string | boolean | array
#     (object is reserved for program-internal use and is not maintainable by the
#     正文 bot). When absent (legacy lines), it is inferred from the value. Type is
#     enforced on write: a new value whose type mismatches the declared `type`
#     raises ValueError.
#   - `min` / `max` (numeric only) bound the value: on every set/add the value is
#     clamped to [min, max] so it can never exceed the range. Out-of-range writes
#     are silently clamped, not rejected.
#   - `note` is overwritten on update; `change_log` is appended on update.
#   - SetRuntimeVar writes, GetRuntimeVars reads, delete removes a name.
# ---------------------------------------------------------------------------

_RUNTIME_VARS_PATH = "runtime/runtime_vars.jsonl"


def _runtime_vars_path(instance_dir: Path) -> Path:
    full = (instance_dir / _RUNTIME_VARS_PATH).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
        raise ValueError("Path traversal detected")
    return full


_VALID_VAR_TYPES = {"number", "string", "boolean", "array"}


def infer_var_type(value) -> str:
    """Infer a declared `type` from a value (backward-compat for legacy entries).

    object cannot be represented by any maintainable type and is mapped to `string`
    as the least-surprising fallback for legacy entries carrying non-scalar data.
    """
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "array"
    return "string"


def clamp_number(value, lo=None, hi=None):
    """Clamp a numeric value to [lo, hi]. Bounds that are None are ignored."""
    if hi is not None:
        value = min(value, hi)
    if lo is not None:
        value = max(value, lo)
    return value


def build_type_map(instance_dir: Path) -> dict:
    """Flat name→type map of the instance sandbox variables (declared or inferred).

    Used to resolve the `${@type name}` placeholder (returns the type string).
    """
    try:
        items = read_sandbox_vars(instance_dir, None)
    except Exception:
        return {}
    out: dict = {}
    for item in items:
        t = item.get("type")
        out[item["name"]] = t if t and t in _VALID_VAR_TYPES else infer_var_type(item.get("value"))
    return out


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
    meta: dict | None = None,
) -> None:
    """Merge variables into the jsonl file.

    - `updates`: {name: value} — overwrite the value.
    - `note`: {name: content} — overwrite that variable's note.
    - `change_log`: {name: entry} — append an entry to that variable's change_log
      list (each entry is a JSON-serializable object, e.g. {"at","to","why"}).
    - `meta`: {name: {type?, min?, max?}} — declare/overwrite type & numeric bounds
      for that variable. `type` is validated against each written value; out-of-range
      numbers (set/add) are silently clamped to [min, max].

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
    meta = meta or {}

    for name, value in updates.items():
        entry = data.get(name, {"name": name})

        # Resolve effective type & bounds: declared in meta or carried on the entry.
        declared = (meta.get(name) or {}).get("type")
        type_ = declared if declared else entry.get("type")
        if type_ is not None and type_ not in _VALID_VAR_TYPES:
            raise ValueError(f"变量「{name}」声明的类型不合法: {type_}（合法为 {sorted(_VALID_VAR_TYPES)}）")
        effective_type = type_ if type_ is not None else infer_var_type(value)

        if effective_type == "number" and not (isinstance(value, (int, float)) and not isinstance(value, bool)):
            raise ValueError(f"变量「{name}」声明为 number，收到值 {value!r}")
        if effective_type == "string" and not isinstance(value, str):
            raise ValueError(f"变量「{name}」声明为 string，收到值 {value!r}")
        if effective_type == "boolean" and not isinstance(value, bool):
            raise ValueError(f"变量「{name}」声明为 boolean，收到值 {value!r}")
        if effective_type == "array" and not isinstance(value, list):
            raise ValueError(f"变量「{name}」声明为 array，收到值 {value!r}")

        # Clamp numeric values to declared bounds (set + add both funnel through here).
        meta_bounds = meta.get(name) or {}
        lo = meta_bounds.get("min", entry.get("min"))
        hi = meta_bounds.get("max", entry.get("max"))
        if effective_type == "number" and (lo is not None or hi is not None):
            value = clamp_number(value, lo, hi)

        entry["value"] = value
        if declared:
            entry["type"] = declared
        data[name] = entry

    for name, m in meta.items():
        if not m:
            continue
        if name not in data:
            data[name] = {"name": name, "value": None}
        entry = data[name]
        if "type" in m:
            entry["type"] = m["type"]
        if "min" in m:
            entry["min"] = m["min"]
        if "max" in m:
            entry["max"] = m["max"]
        # A meta-only update must not leave the value declared but empty when the
        # entry was pristine & had no value — but that's acceptable (type-first decl).
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
    """Delete a file or a directory (recursively)."""
    root = instance_dir.resolve()
    full = (instance_dir / file_path).resolve()
    if full == root:
        raise ValueError("Cannot delete instance root")
    if str(full) != str(root) and not str(full).startswith(str(root) + os.sep):
        raise ValueError("Path traversal detected")
    if not full.exists():
        raise FileNotFoundError(file_path)
    if full.is_dir():
        shutil.rmtree(full)
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


def rename_file_or_dir(instance_dir: Path, file_path: str, new_name: str) -> str:
    """Rename a file or directory (same parent, new basename). Returns the new relative path."""
    full = _resolve_full(instance_dir, file_path)
    if not full.exists():
        raise FileNotFoundError(file_path)
    new_name = new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise ValueError("新名称不能为空，且不能包含路径分隔符")
    new_full = full.parent / new_name
    if new_full.exists():
        raise FileExistsError(new_name)
    full.rename(new_full)
    return str(new_full.relative_to(instance_dir.resolve())).replace("\\", "/")


def move_file_or_dir(instance_dir: Path, file_path: str, dest_parent: str) -> str:
    """Move a file/dir into ``dest_parent`` (preserving its basename).

    ``dest_parent`` empty string means the instance root. Returns the new
    relative path. Raises FileNotFoundError / FileExistsError / ValueError /
    OSError on failure.
    """
    full = _resolve_full(instance_dir, file_path)
    if not full.exists():
        raise FileNotFoundError(file_path)

    dest = _resolve_full(instance_dir, dest_parent)
    if not dest.is_dir():
        raise ValueError("目标不是目录")

    # Forbid moving an entry into itself or one of its own descendants.
    full_res = str(full.resolve())
    dest_res = str(dest.resolve())
    if dest_res == full_res or dest_res.startswith(full_res + os.sep):
        raise ValueError("不能移动到自身或其后代目录")

    target = dest / full.name
    if target.exists():
        raise FileExistsError(str(target))
    shutil.move(str(full), str(target))
    return str(target.relative_to(instance_dir.resolve())).replace("\\", "/")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _copy_dir(src: Path, dst: Path) -> None:
    """Recursively copy a directory."""
    if not src.is_dir():
        return
    shutil.copytree(src, dst, dirs_exist_ok=True)
