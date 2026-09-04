"""
Prototype and instance API routes.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..state import state
from ..tools import execute_tool
from ..director_system import get_floors_stats
from ..database.auth import UserInfo, validate_token
from ..database.users import get_user_by_username
from ..database.connection import fetch_one
from ..database.workspaces import (
    list_prototypes,
    get_prototype,
    create_prototype,
    delete_prototype,
    find_prototype_by_hash,
    list_instances,
    get_instance,
    create_instance,
    copy_instance,
    delete_instance,
    ensure_user_dirs,
    instantiate_prototype,
    list_file_tree,
    read_text,
    read_asset,
    read_prototype_cover,
    TextDecodeError,
    write_file,
    write_asset,
    delete_file_or_dir,
    create_file_or_dir,
    rename_file_or_dir,
    move_file_or_dir,
    update_floor_count,
    update_instance_name,
    update_summary_index,
    read_sandbox_vars,
    write_sandbox_vars,
    delete_sandbox_vars,
)
from ..git_utils import git_commit, git_branch, git_log, git_status_porcelain, git_branch_rename, git_reset_hard, git_delete_branch, git_rev_parse, git_discard_changes, git_restore_file, git_show_file, _git_run, GitError
from ..placeholder import validate_var_name

# Directories never included when packing an instance as a prototype.
# building/ is the creator's meta-workspace (notes/checklists); the rest are
# internals. Business-level cleanup (which floors/vars to keep) is not judged here.
PACK_EXCLUDE_DIRS = {"building", "sessions", ".git", "__pycache__", "node_modules", ".DS_Store", ".sessions"}



# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------

async def require_user(request: Request) -> UserInfo:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    user = await validate_token(auth[7:])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


async def require_user_info(user: UserInfo) -> dict:
    """Get full user row (with safe_name)."""
    u = await get_user_by_username(user.username)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return u


def _get_base_path() -> Path:
    return Path(state.workspace_base)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CreatePrototypeRequest(BaseModel):
    instance_id: str
    name: str
    description: str = ""
    author: str = ""
    version: str = "1.0.0"


class StartInstanceRequest(BaseModel):
    prototype_id: str
    name: str


class CopyInstanceRequest(BaseModel):
    name: str


class RenameInstanceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class FileCreateRequest(BaseModel):
    path: str
    type: str = "file"  # "file" or "directory"


class FileWriteRequest(BaseModel):
    content: str


class FileRenameRequest(BaseModel):
    new_name: str


class FileMoveRequest(BaseModel):
    dest_parent: str = ""  # 目标父目录路径，空串 = 实例根


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["workspace"])


def _broadcast_floors(instance_dir: Path, instance_id: str) -> None:
    """Broadcast floors_changed SSE event with stats from the instance directory."""
    stats = get_floors_stats(instance_dir)
    if stats:
        stats["instance_id"] = instance_id or instance_dir.name
        state.broadcast("floors_changed", stats)


# ===== Prototypes =====

@router.get("/prototypes")
async def list_my_prototypes(user: UserInfo = Depends(require_user)):
    u = await require_user_info(user)
    return await list_prototypes(u["id"])


@router.post("/prototypes")
async def create_prototype_from_instance(
    body: CreatePrototypeRequest,
    user: UserInfo = Depends(require_user)
):
    """Create a new prototype by packing the instance root.

    The whole instance is the prototype source. Internal/meta dirs that must
    never ship (building/, .git/, sessions/, etc.) are excluded at pack time.
    Business-level cleanup (which floors/vars to keep, generalizing teahouse.md)
    is done manually on the instance before packing — not judged here.
    """
    u = await require_user_info(user)
    base = _get_base_path()
    safe_name = u["safe_name"] or user.username.lower().replace(" ", "_")

    inst = await get_instance(body.instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    source_dir = Path(inst["dir_path"]).resolve()

    import uuid as _uuid
    import zipfile as _zipfile
    import hashlib
    import json

    def _is_excluded(rel_path: Path) -> bool:
        # Skip any file whose ancestor path-component is an excluded dir
        return bool(set(rel_path.parts[:-1]) & PACK_EXCLUDE_DIRS)

    # Compute content hash from packable files (before adding metadata)
    file_list = sorted(
        str(f.relative_to(source_dir)).replace("\\", "/")
        for f in source_dir.rglob("*")
        if f.is_file() and not _is_excluded(f.relative_to(source_dir))
    )
    sha = hashlib.sha256()
    for rel in file_list:
        sha.update(rel.encode("utf-8"))
        with open(source_dir / rel, "rb") as fh:
            while chunk := fh.read(65536):
                sha.update(chunk)
    content_hash = sha.hexdigest()

    # Write metadata into the source directory before packing (a root-level
    # prototype.json, alongside teahouse.md / README.md).
    metadata_dir = source_dir
    metadata = {
        "name": body.name,
        "description": body.description,
        "author": body.author,
        "version": body.version,
        "content_hash": content_hash,
    }
    with open(metadata_dir / "prototype.json", "w", encoding="utf-8") as mf:
        json.dump(metadata, mf, ensure_ascii=False, indent=2)

    # Pack as .teabrew zip
    _, prototypes_dir = ensure_user_dirs(safe_name, base)
    safe_proto_name = body.name.lower().replace(" ", "_").replace("/", "_")
    zip_name = f"{safe_proto_name}_{_uuid.uuid4().hex[:8]}.teabrew"
    zip_path = prototypes_dir / zip_name

    with _zipfile.ZipFile(zip_path, "w", _zipfile.ZIP_DEFLATED) as zf:
        for f in source_dir.rglob("*"):
            if f.is_file() and not _is_excluded(f.relative_to(source_dir)):
                arcname = str(f.relative_to(source_dir)).replace("\\", "/")
                zf.write(f, arcname)

    # Clean up metadata file from source dir
    (metadata_dir / "prototype.json").unlink()

    # Create DB record
    source_path = str(zip_path.resolve())
    proto = await create_prototype(
        u["id"], body.name, body.description, source_path,
        content_hash=content_hash,
    )
    return proto


@router.delete("/prototypes/{prototype_id}")
async def delete_my_prototype(prototype_id: str, user: UserInfo = Depends(require_user)):
    u = await require_user_info(user)
    proto = await get_prototype(prototype_id)
    if not proto:
        raise HTTPException(status_code=404, detail="Prototype not found")
    if proto["is_builtin"]:
        raise HTTPException(status_code=400, detail="Cannot delete built-in prototype")
    if proto["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    ok = await delete_prototype(prototype_id)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to delete prototype")
    return {"status": "ok"}


@router.get("/prototypes/{prototype_id}/download")
async def download_prototype(
    prototype_id: str,
    request: Request,
    token: str = Query(default=""),
):
    """Download a prototype .teabrew file. Auth via header or ?token= query param."""
    # Auth: prefer header, fallback to query param (for browser <a> downloads)
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        user = await validate_token(auth[7:])
    elif token:
        user = await validate_token(token)
    else:
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    u = await require_user_info(user)
    proto = await get_prototype(prototype_id)
    if not proto:
        raise HTTPException(status_code=404, detail="Prototype not found")
    if proto["is_builtin"]:
        raise HTTPException(status_code=400, detail="Built-in prototypes cannot be downloaded")
    if proto["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    source = Path(proto["source_path"]).resolve()
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Prototype file not found on disk")

    filename = f"{proto['name']}.teabrew"
    # RFC 5987 encoding for non-ASCII filenames
    encoded_filename = quote(filename, safe="")
    return FileResponse(
        path=str(source),
        filename=filename,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
        },
    )


@router.get("/prototypes/{prototype_id}/readme")
async def get_prototype_readme(prototype_id: str, user: UserInfo = Depends(require_user)):
    """Read prototype metadata and README."""
    u = await require_user_info(user)
    proto = await get_prototype(prototype_id)
    if not proto:
        raise HTTPException(status_code=404, detail="Prototype not found")

    source = Path(proto["source_path"]).resolve()

    # Built-in prototypes: read README.md from disk
    if proto["is_builtin"]:
        metadata = {"name": proto["name"], "description": proto["description"]}
        readme = ""
        readme_path = source / "README.md"
        if readme_path.exists():
            readme = readme_path.read_text(encoding="utf-8")
        return {"metadata": metadata, "readme": readme}

    # User-created prototypes: read from .teabrew zip
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Prototype file not found on disk")

    import zipfile as _zipfile
    import json
    metadata = {}
    readme = ""
    with _zipfile.ZipFile(source, "r") as zf:
        try:
            with zf.open("prototype.json") as mf:
                metadata = json.loads(mf.read().decode("utf-8"))
        except KeyError:
            pass
        try:
            with zf.open("README.md") as rf:
                readme = rf.read().decode("utf-8")
        except KeyError:
            pass

    return {"metadata": metadata, "readme": readme}


@router.get("/prototypes/{prototype_id}/cover")
async def get_prototype_cover(prototype_id: str, user: UserInfo = Depends(require_user)):
    """Read prototype cover image (cover.jpg/.jpeg/.png/.webp at root) as base64.

    Response: {"mime", "data", "size"} where `data` is a bare base64 payload and
    `size` is [width, height] for images (null otherwise); callers build
    `data:{mime};base64,{data}`. The size drives the masonry layout so each cover
    keeps its intrinsic aspect ratio. 404 when the prototype has no cover.
    """
    u = await require_user_info(user)
    proto = await get_prototype(prototype_id)
    if not proto:
        raise HTTPException(status_code=404, detail="Prototype not found")

    cover = read_prototype_cover(proto["source_path"], bool(proto["is_builtin"]))
    if cover is None:
        raise HTTPException(status_code=404, detail="Cover not found")
    mime, data, size = cover
    return {"mime": mime, "data": data, "size": size}


@router.post("/prototypes/import")
async def import_prototype(
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Import a .teabrew prototype file."""
    u = await require_user_info(user)
    base = _get_base_path()
    safe_name = u["safe_name"] or user.username.lower().replace(" ", "_")

    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Accept .teabrew and .zip
    original = file.filename.lower()
    if not (original.endswith(".teabrew") or original.endswith(".zip")):
        raise HTTPException(status_code=400, detail="File must be .teabrew or .zip")

    import uuid as _uuid
    import zipfile as _zipfile
    import hashlib
    import json
    import io
    _, prototypes_dir = ensure_user_dirs(safe_name, base)

    content = await file.read()
    bio = io.BytesIO(content)

    # Try to read metadata and compute content hash (excluding metadata itself)
    proto_name = None
    proto_desc = ""
    content_hash_from_meta = ""
    with _zipfile.ZipFile(bio, "r") as zf:
        names = sorted(zf.namelist())
        # Compute hash from all files except prototype.json
        sha = hashlib.sha256()
        for n in names:
            if n == "prototype.json":
                continue
            sha.update(n.encode("utf-8"))
            sha.update(zf.read(n))
        computed_hash = sha.hexdigest()

        # Read metadata if present
        try:
            with zf.open("prototype.json") as mf:
                meta = json.loads(mf.read().decode("utf-8"))
                proto_name = meta.get("name", "").strip()
                proto_desc = meta.get("description", "")
                content_hash_from_meta = meta.get("content_hash", "")
        except KeyError:
            pass

    # Derive name: metadata first, then filename stem
    if not proto_name:
        proto_name = Path(file.filename).stem.replace("_", " ")

    # Check for duplicate by hash
    effective_hash = content_hash_from_meta or computed_hash
    if effective_hash:
        existing = await find_prototype_by_hash(effective_hash, u["id"])
        if existing:
            return {
                "duplicate": True,
                "prototype": existing,
                "detail": "This prototype already exists (content hashes match)",
            }

    bio.seek(0)
    safe_proto_name = proto_name.lower().replace(" ", "_").replace("/", "_")
    zip_name = f"{safe_proto_name}_{_uuid.uuid4().hex[:8]}.teabrew"
    zip_path = prototypes_dir / zip_name
    zip_path.write_bytes(content)

    proto = await create_prototype(
        u["id"], proto_name, proto_desc, str(zip_path.resolve()),
        content_hash=effective_hash,
    )
    return {"duplicate": False, "prototype": proto}


# ===== Instances =====

@router.get("/instances")
async def list_my_instances(user: UserInfo = Depends(require_user)):
    u = await require_user_info(user)
    return await list_instances(u["id"])


@router.post("/instances")
async def start_new_instance(body: StartInstanceRequest, user: UserInfo = Depends(require_user)):
    """Create a new instance from a prototype."""
    u = await require_user_info(user)
    base = _get_base_path()
    safe_name = u["safe_name"] or user.username.lower().replace(" ", "_")

    # Resolve prototype
    proto = await get_prototype(body.prototype_id)
    if not proto:
        raise HTTPException(status_code=404, detail="Prototype not found")
    if proto["user_id"] and proto["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    instances_dir, _ = ensure_user_dirs(safe_name, base)

    safe_inst = body.name.lower().replace(" ", "_").replace("/", "_")
    target_dir = instances_dir / safe_inst
    if target_dir.exists():
        raise HTTPException(status_code=409, detail="An instance with this name already exists")

    # Copy prototype contents
    instantiate_prototype(proto, target_dir, base)

    dir_path = str(target_dir.resolve())
    return await create_instance(u["id"], proto["id"], body.name, dir_path)


@router.delete("/instances/{instance_id}")
async def delete_my_instance(instance_id: str, user: UserInfo = Depends(require_user)):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    ok = await delete_instance(instance_id)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to delete instance")
    return {"status": "ok"}


@router.post("/instances/{instance_id}/copy")
async def copy_my_instance(
    instance_id: str,
    body: CopyInstanceRequest,
    user: UserInfo = Depends(require_user),
):
    """Create a full snapshot copy of an instance (new id, independent git repo)."""
    u = await require_user_info(user)
    base = _get_base_path()
    safe_name = u["safe_name"] or user.username.lower().replace(" ", "_")

    inst = await get_instance(instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    instances_dir, _ = ensure_user_dirs(safe_name, base)

    safe_inst = body.name.lower().replace(" ", "_").replace("/", "_")
    target_dir = instances_dir / safe_inst
    if target_dir.exists():
        raise HTTPException(status_code=409, detail="An instance with this name already exists")

    dir_path = copy_instance(inst, target_dir)

    return await create_instance(u["id"], inst["prototype_id"], body.name, dir_path)


@router.patch("/instances/{instance_id}")
async def rename_my_instance(
    instance_id: str,
    body: RenameInstanceRequest,
    user: UserInfo = Depends(require_user),
):
    """Rename an instance (display name only; the on-disk directory is untouched)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    renamed = await update_instance_name(instance_id, body.name.strip() or inst["name"])
    if not renamed:
        raise HTTPException(status_code=500, detail="Failed to rename instance")
    return renamed


# ===== File operations =====

def _resolve_instance_dir(inst: dict) -> Path:
    return Path(inst["dir_path"])


@router.get("/instances/{instance_id}/files")
async def list_instance_files(instance_id: str, user: UserInfo = Depends(require_user)):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    return list_file_tree(instance_dir)


@router.get("/instances/{instance_id}/files/content")
async def get_instance_file(
    instance_id: str,
    path: str = Query(..., description="File path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        content = read_text(instance_dir, path)
        return {"path": path, "content": content}
    except (FileNotFoundError, IsADirectoryError):
        raise HTTPException(status_code=404, detail="File not found")
    except TextDecodeError:
        raise HTTPException(
            status_code=415,
            detail=f"'{path}' is a binary asset, not UTF-8 text. Use GET /files/asset instead.",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/instances/{instance_id}/files/asset")
async def get_instance_asset(
    instance_id: str,
    path: str = Query(..., description="Binary asset path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    """Read a binary resource (image/audio/font/…) and return it as base64.

    Response: {"path", "mime", "data"} where `data` is a bare base64 payload;
    callers build `data:{mime};base64,{data}`. MIME is detected from magic
    bytes, so any file type is accepted. No size limit here — oversized assets
    are a creator choice managed via sandbox-builder guidance.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        mime, data, size = read_asset(instance_dir, path)
        return {"path": path, "mime": mime, "data": data, "size": size}
    except (FileNotFoundError, IsADirectoryError):
        raise HTTPException(status_code=404, detail="File not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/instances/{instance_id}/cover")
async def get_instance_cover(instance_id: str, user: UserInfo = Depends(require_user)):
    """Read an instance's cover image (cover.jpg/.jpeg/.png/.webp at root) as base64.

    Response: {"mime", "data", "size"} where `size` is [width, height] for images
    (null otherwise). Size drives the masonry layout so each cover keeps its
    intrinsic aspect ratio. 404 when the instance has no cover.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    for name in ("cover.jpg", "cover.jpeg", "cover.png", "cover.webp"):
        try:
            mime, data, size = read_asset(instance_dir, name)
        except (FileNotFoundError, IsADirectoryError, ValueError):
            continue
        return {"mime": mime, "data": data, "size": size}
    raise HTTPException(status_code=404, detail="Cover not found")


@router.put("/instances/{instance_id}/files/content")
async def save_instance_file(
    instance_id: str,
    body: FileWriteRequest,
    path: str = Query(..., description="File path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        write_file(instance_dir, path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 用户编辑器就地保存 —— 与导演工具一致，广播 file_changed：
    #  - path 落在运行时区(runtime/) → 正文/沙盒刷新
    #  - path 是 runtime/runtime_vars.jsonl → 变量变更，正文占位符重解析出新值
    p = path.replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    parts = p.split("/")
    if parts[0] == "runtime" and len(parts) > 1:
        state.broadcast(
            "file_changed",
            {"path": p, "tool": "EditorSave", "type": "modified", "instance_id": instance_id},
        )
    return {"path": path, "status": "saved"}


# 单个二进制文件上传上限（约 20MB），避免巨大文件一次性打爆内存
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@router.post("/instances/{instance_id}/files/upload")
async def upload_instance_file(
    instance_id: str,
    path: str = Query(..., description="目标路径，相对实例根"),
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Upload a single binary file (image/audio/font/…) into the instance.

    Complements GET /files/asset (binary read) and PUT /files/content (text
    write): this is the only write path for arbitrary bytes — e.g. a creator
    dropping a cover.{jpg,png,webp} or an asset into assets/. Written to the
    instance root, so a cover-style name is picked up by the cover reader.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    data = await file.read()
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (max {_MAX_UPLOAD_BYTES // (1024 * 1024)}MB)",
        )

    instance_dir = _resolve_instance_dir(inst)
    try:
        write_asset(instance_dir, path, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 上传新文件 → 文件树/git 状态都需刷新；广播 file_changed 让前端 SSE 自动拉 git
    state.broadcast(
        "file_changed",
        {"path": path, "tool": "UploadFile", "type": "created", "instance_id": instance_id},
    )
    return {"path": path, "size": len(data), "status": "uploaded"}


@router.get("/instances/{instance_id}/runtime-vars")
async def get_runtime_vars(
    instance_id: str,
    names: list[str] = Query(default=[]),
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    vars_ = read_sandbox_vars(instance_dir, names or None)
    return {"vars": vars_}


class RuntimeVarsUpdateRequest(BaseModel):
    updates: dict = {}
    note: dict = {}
    change_log: dict = {}
    meta: dict = {}
    delete: list[str] = []


@router.patch("/instances/{instance_id}/runtime-vars")
async def set_runtime_vars(
    instance_id: str,
    body: RuntimeVarsUpdateRequest,
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    # Whitespace/colon/@ in a variable name is unusable in ${...} identifier / ${@type ...} syntax.
    bad_names: set[str] = set()
    for mapping in (body.updates, body.note, body.change_log, body.meta):
        for k in mapping:
            if validate_var_name(k):
                bad_names.add(str(k))
    for k in body.delete:
        if validate_var_name(k):
            bad_names.add(str(k))
    if bad_names:
        detail = "; ".join(validate_var_name(k) for k in sorted(bad_names))
        raise HTTPException(status_code=400, detail=detail)

    try:
        if body.updates or body.meta:
            write_sandbox_vars(instance_dir, body.updates, note=body.note, change_log=body.change_log, meta=body.meta)
        elif body.note or body.change_log:
            write_sandbox_vars(instance_dir, {}, note=body.note, change_log=body.change_log)
        if body.delete:
            delete_sandbox_vars(instance_dir, body.delete)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    state.broadcast(
        "file_changed",
        {"path": "runtime/runtime_vars.jsonl", "tool": "SetRuntimeVar", "type": "modified", "instance_id": instance_id},
    )
    # Read back the full current vars so the caller (sandbox) can reconcile.
    return {"status": "ok", "vars": read_sandbox_vars(instance_dir, None)}


@router.post("/instances/{instance_id}/files")
async def create_instance_entry(
    instance_id: str,
    body: FileCreateRequest,
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        create_file_or_dir(instance_dir, body.path, body.type)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Already exists")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 新建文件/目录 → 文件树/git 状态都需刷新
    state.broadcast(
        "file_changed",
        {"path": body.path, "tool": "CreateFile", "type": "created", "instance_id": instance_id},
    )
    return {"path": body.path, "status": "created"}


@router.delete("/instances/{instance_id}/files")
async def delete_instance_entry(
    instance_id: str,
    path: str = Query(..., description="Path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        delete_file_or_dir(instance_dir, path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    except OSError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 删除文件/目录 → 文件树/git 状态都需刷新
    state.broadcast(
        "file_changed",
        {"path": path, "tool": "DeleteFile", "type": "deleted", "instance_id": instance_id},
    )
    return {"path": path, "status": "deleted"}


@router.patch("/instances/{instance_id}/files/rename")
async def rename_instance_entry(
    instance_id: str,
    body: FileRenameRequest,
    path: str = Query(..., description="Path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    """Rename a file or directory (same parent, new basename)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        new_path = rename_file_or_dir(instance_dir, path, body.new_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=f"target already exists: {e}")
    except OSError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    state.broadcast(
        "file_changed",
        {"path": new_path, "tool": "RenameFile", "type": "moved", "prev_path": path, "instance_id": instance_id},
    )
    return {"path": new_path, "status": "renamed"}


@router.patch("/instances/{instance_id}/files/move")
async def move_instance_entry(
    instance_id: str,
    body: FileMoveRequest,
    path: str = Query(..., description="Path relative to instance root"),
    user: UserInfo = Depends(require_user),
):
    """Move a file or directory into a target parent directory (basename kept)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        new_path = move_file_or_dir(instance_dir, path, body.dest_parent)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=f"target already exists: {e}")
    except OSError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    state.broadcast(
        "file_changed",
        {"path": new_path, "tool": "MoveFile", "type": "moved", "prev_path": path, "instance_id": instance_id},
    )
    return {"path": new_path, "status": "moved"}


class ToolsRunStep(BaseModel):
    tool: str
    args: Optional[dict] = None
    """A single tool call that the sandbox composes inline (runTool)."""


class ToolsRunRequest(BaseModel):
    steps: list[ToolsRunStep]


_MAX_INLINE_STEPS = 50


@router.get("/tools")
async def list_available_tools(user: UserInfo = Depends(require_user)):
    """Return builtin tool ``[{name, short}]`` for the frontend permission autocomplete.

    Sources from tools.json (the single source of truth). ``short`` is a one-line
    label; falls back to ``description`` when absent.
    """
    from ..tools import load_tools_summary
    await require_user_info(user)
    return {"tools": load_tools_summary()}


@router.post("/instances/{instance_id}/tools/run")
async def run_instance_tools(
    instance_id: str,
    body: ToolsRunRequest,
    user: UserInfo = Depends(require_user),
):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    if not body.steps:
        raise HTTPException(status_code=400, detail="steps must not be empty")
    if len(body.steps) > _MAX_INLINE_STEPS:
        raise HTTPException(
            status_code=400, detail=f"inline tool call supports at most {_MAX_INLINE_STEPS} steps"
        )

    instance_dir = _resolve_instance_dir(inst)
    user_id = u["id"]
    run_uuid = str(uuid.uuid4())

    # Fire-and-forget: 步骤在后台串行执行（Generate 等长任务不阻塞请求返回），
    # 每步完成后广播一条 tool_run（带 run_uuid / index / 结果 / 成败），组件据此
    # 自行数 index 判定本批完成。步骤内部还会发 file_changed 驱动楼层/沙盒刷新。
    task = asyncio.create_task(
        _run_steps(instance_dir, user_id, run_uuid, body.steps, instance_id)
    )
    # 登记本批 task，供 POST .../tools/run/{run_uuid}/cancel 中途打断（Generate 等长步骤）
    from ..run_tool_tracker import run_tool_tracker
    run_tool_tracker.register(run_uuid, task)
    # 兜底：取异常引用，避免"未处理异常"日志告警（任务结果无人读取）
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    return {"ok": True, "accepted": True, "run_uuid": run_uuid, "steps": len(body.steps)}


async def _run_steps(
    instance_dir: Path,
    user_id: str,
    run_uuid: str,
    steps: list[ToolsRunStep],
    instance_id: str,
) -> None:
    from ..run_tool_tracker import run_tool_tracker
    try:
        for i, step in enumerate(steps, 1):
            name = step.tool
            cargs = step.args or {}
            result = await execute_tool(name, cargs, instance_dir, user_id, instance_id, run_uuid)
            ok = not result.startswith("Error")
            state.broadcast(
                "tool_run",
                {
                    "run_uuid": run_uuid,
                    "index": i,
                    "tool": name,
                    "result": result,
                    "ok": ok,
                    "instance_id": instance_id or instance_dir.name,
                },
            )
            if not ok:
                return
    finally:
        # 无论正常结束、某步失败还是被 cancel 中途打断，都清理注册，避免泄漏
        run_tool_tracker.unregister(run_uuid)


@router.post("/instances/{instance_id}/tools/run/{run_uuid}/cancel")
async def cancel_run_tools(
    instance_id: str,
    run_uuid: str,
    user: UserInfo = Depends(require_user),
):
    """Cancel an in-flight sandbox runTool batch by its run_uuid.

    Fire-and-forget runTool batches are tracked by run_uuid in run_tool_tracker;
    this cancels the background task (e.g. a long Generate step). On cancel the
    current step is interrupted and does NOT flush a half-baked file
    (CancelledError is a BaseException, so execute_generate's except Exception
    won't write). The sandbox is notified via a tool_run_cancelled broadcast so
    its runTool handle rejects promptly instead of waiting for the timeout.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    from ..run_tool_tracker import run_tool_tracker
    cancelled = await run_tool_tracker.abort(run_uuid)
    if cancelled:
        state.broadcast(
            "tool_run_cancelled",
            {
                "run_uuid": run_uuid,
                "instance_id": instance_id,
            },
        )
    return {"status": "ok", "run_uuid": run_uuid, "cancelled": cancelled}


# ===== Skills =====

SKILLS_DIR = "skills"


def _get_skill_dir(instance_dir: Path, skill_name: str) -> Path:
    return instance_dir / SKILLS_DIR / skill_name


def _get_system_skills_dir() -> Path:
    """Path to the system teahouse_skills directory."""
    from ..director_system import TEMPLATE_DIR
    return TEMPLATE_DIR / "teahouse_skills"


def _resolve_skill_dir(instance_dir: Path, skill_name: str) -> Path | None:
    """Resolve a skill directory. Instance skills take priority over system skills.

    Returns None if the skill doesn't exist in either location.
    """
    instance_skill = _get_skill_dir(instance_dir, skill_name)
    if instance_skill.is_dir():
        return instance_skill
    system_skill = _get_system_skills_dir() / skill_name
    if system_skill.is_dir():
        return system_skill
    return None


def _read_file_text(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


@router.get("/instances/{instance_id}/skills")
async def list_skills(instance_id: str, user: UserInfo = Depends(require_user)):
    """List all skills available to this instance (system + instance)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    seen: set[str] = set()
    result: list[dict[str, object]] = []

    # System skills first
    system_dir = _get_system_skills_dir()
    if system_dir.is_dir():
        for entry in sorted(system_dir.iterdir()):
            if entry.is_dir():
                seen.add(entry.name)
                result.append({
                    "name": entry.name,
                    "source": "system",
                    "has_skill": (entry / "SKILL.md").exists(),
                    "has_examples": (entry / "examples").is_dir(),
                })

    # Instance skills (override annotation if name duplicates)
    inst_skills_dir = instance_dir / SKILLS_DIR
    if inst_skills_dir.is_dir():
        for entry in sorted(inst_skills_dir.iterdir()):
            if entry.is_dir():
                item = {
                    "name": entry.name,
                    "source": "instance",
                    "has_skill": (entry / "SKILL.md").exists(),
                    "has_examples": (entry / "examples").is_dir(),
                }
                if entry.name in seen:
                    # Replace the system entry with the instance override
                    for i, r in enumerate(result):
                        if r["name"] == entry.name:
                            result[i] = item
                            break
                else:
                    result.append(item)
    return result


@router.get("/instances/{instance_id}/skills/{skill_name}")
async def get_skill(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Read a skill's full content (SKILL.md + examples). System + instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _resolve_skill_dir(instance_dir, skill_name)
    if not skill_dir:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    skill_content = _read_file_text(skill_dir / "SKILL.md")
    examples_dir = skill_dir / "examples"
    examples = []
    if examples_dir.is_dir():
        for f in sorted(examples_dir.iterdir()):
            if f.is_file():
                examples.append({"name": f.name, "content": f.read_text(encoding="utf-8")})
    return {"name": skill_name, "prompt": skill_content, "examples": examples}


class CreateSkillRequest(BaseModel):
    prompt: str


@router.post("/instances/{instance_id}/skills/{skill_name}")
async def create_skill(instance_id: str, skill_name: str, body: CreateSkillRequest, user: UserInfo = Depends(require_user)):
    """Create a new skill with a SKILL.md."""
    import re as _re
    if not _re.match(r'^[a-zA-Z0-9_-]+$', skill_name):
        raise HTTPException(status_code=400, detail="Skill name must contain only letters, numbers, hyphens, underscores")
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if skill_dir.exists():
        raise HTTPException(status_code=409, detail=f"Skill '{skill_name}' already exists")
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(body.prompt, encoding="utf-8")
    return {"name": skill_name, "status": "created"}


@router.put("/instances/{instance_id}/skills/{skill_name}")
async def update_skill(instance_id: str, skill_name: str, body: CreateSkillRequest, user: UserInfo = Depends(require_user)):
    """Update a skill's SKILL.md."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    (skill_dir / "SKILL.md").write_text(body.prompt, encoding="utf-8")
    return {"name": skill_name, "status": "updated"}


@router.delete("/instances/{instance_id}/skills/{skill_name}")
async def delete_skill(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Delete an instance skill."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    shutil.rmtree(skill_dir)
    return {"name": skill_name, "status": "deleted"}


def _user_skills_lib_dir(user_row: dict) -> Path:
    """Path to the user's skill library (decoupled inventory dir)."""
    safe_name = user_row.get("safe_name") or user_row["username"].lower().replace(" ", "_")
    return Path(state.workspace_base) / safe_name / "skills"


@router.post("/instances/{instance_id}/skills/{skill_name}/enable-from-library")
async def enable_skill_from_library(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Copy a skill from the user's library into this instance's skills/.

    user -> instance. The library is a stock/inventory only; copying it in is what
    makes the skill take effect (instance skills override system ones).
    """
    import re as _re
    if not _re.match(r'^[a-zA-Z0-9_-]+$', skill_name):
        raise HTTPException(status_code=400, detail="Skill name must contain only letters, numbers, hyphens, underscores")
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    lib_skill = _user_skills_lib_dir(u) / skill_name
    if not lib_skill.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not in your skill library")

    target = _get_skill_dir(instance_dir, skill_name)
    if target.exists():
        raise HTTPException(status_code=409, detail=f"This instance already has skill '{skill_name}' enabled")

    shutil.copytree(lib_skill, target)
    return {"name": skill_name, "status": "enabled", "message": f"skill '{skill_name}' has been enabled"}


@router.post("/instances/{instance_id}/skills/{skill_name}/export-to-library")
async def export_skill_to_library(instance_id: str, skill_name: str, body: Optional[dict] = None, user: UserInfo = Depends(require_user)):
    """Copy a skill from this instance into the user's skill library.

    instance -> user. This is how a skill authored in an instance becomes
    reusable across other instances (the library is the stock).

    If a same-named skill already exists in the library, the request is refused
    with 409 unless `overwrite: true` is passed (body JSON) — the client must
    show a confirm dialog before overwriting, matching prompt-package export.
    """
    import re as _re
    if not _re.match(r'^[a-zA-Z0-9_-]+$', skill_name):
        raise HTTPException(status_code=400, detail="Skill name must contain only letters, numbers, hyphens, underscores")
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    source = _resolve_skill_dir(instance_dir, skill_name)
    if not source:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not in this instance")

    overwrite = bool(body and body.get("overwrite"))
    lib_dir = _user_skills_lib_dir(u)
    lib_dir.mkdir(parents=True, exist_ok=True)
    target = lib_dir / skill_name
    if target.exists():
        if not overwrite:
            raise HTTPException(
                status_code=409,
                detail=f"your skill library already contains a skill named '{skill_name}', resend with confirm to overwrite",
            )
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return {"name": skill_name, "status": "exported", "message": f"skill '{skill_name}' has been added to your skill library"}


# ── 提示词包（instance packages）─────────────────────────────────


def _user_packages_lib_dir(user_row: dict) -> Path:
    """Path to the user's prompt-package library (decoupled inventory dir)."""
    safe_name = user_row.get("safe_name") or user_row["username"].lower().replace(" ", "_")
    return Path(state.workspace_base) / safe_name / "packages"


def _instance_packages_dir(instance_dir: Path) -> Path:
    return instance_dir / "packages"


def _scan_instance_package(pkg_dir: Path) -> dict:
    return {
        "name": pkg_dir.name,
        "has_readme": (pkg_dir / "README.md").is_file(),
        "file_count": sum(1 for p in pkg_dir.rglob("*") if p.is_file()),
        "size": sum(p.stat().st_size for p in pkg_dir.rglob("*") if p.is_file()),
        "updated_at": pkg_dir.stat().st_mtime,
    }


@router.get("/instances/{instance_id}/packages")
async def list_instance_packages(instance_id: str, user: UserInfo = Depends(require_user)):
    """List the prompt packages installed in an instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    pkg_root = _instance_packages_dir(instance_dir)
    packages: list[dict] = []
    if pkg_root.is_dir():
        for entry in sorted(pkg_root.iterdir(), key=lambda e: e.name):
            if entry.is_dir():
                packages.append(_scan_instance_package(entry))
    return {"packages": packages}


@router.post("/instances/{instance_id}/packages/{package_name}/enable-from-library")
async def enable_package_from_library(instance_id: str, package_name: str, user: UserInfo = Depends(require_user)):
    """Copy a prompt package from the user's library into this instance's packages/.

    user -> instance. The library is a stock/inventory only; copying it in is what
    makes the package available for {{@包名/路径}} slices.
    """
    from .packages import validate_package_name
    validate_package_name(package_name)
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    lib_pkg = _user_packages_lib_dir(u) / package_name
    if not lib_pkg.is_dir():
        raise HTTPException(status_code=404, detail=f"prompt package '{package_name}' not in your package library")

    target = _instance_packages_dir(instance_dir) / package_name
    if target.exists():
        raise HTTPException(status_code=409, detail=f"This instance already has package '{package_name}' enabled")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(lib_pkg, target)
    return {"name": package_name, "status": "enabled", "message": f"prompt package '{package_name}' has been enabled"}


@router.delete("/instances/{instance_id}/packages/{package_name}")
async def remove_instance_package(instance_id: str, package_name: str, user: UserInfo = Depends(require_user)):
    """Remove (卸载) a prompt package from an instance by deleting its packages/ dir.

    References in assembler/manifest to it become inert (server skips them), so
    removal is a clean uninstall.
    """
    from .packages import validate_package_name
    validate_package_name(package_name)
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    pkg_dir = _instance_packages_dir(instance_dir) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"prompt package '{package_name}' not in this instance")
    shutil.rmtree(pkg_dir)
    return {"name": package_name, "status": "removed", "message": f"prompt package '{package_name}' has been uninstalled"}


@router.post("/instances/{instance_id}/packages/{package_name}/export-to-library")
async def export_package_to_library(instance_id: str, package_name: str, body: Optional[dict] = None, user: UserInfo = Depends(require_user)):
    """Copy a prompt package from this instance into the user's package library.

    instance -> user. The instance's packages/<name>/ is the working area the
    director/user composes into; exporting copies it into the user library
    (stock) so it can be enabled in other instances or downloaded as a zip.

    Same-named package in the library → 409 unless `overwrite: true` (client
    shows a confirm dialog first), matching skill export.
    """
    from .packages import validate_package_name
    validate_package_name(package_name)
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    source = _instance_packages_dir(instance_dir) / package_name
    if not source.is_dir():
        raise HTTPException(status_code=404, detail=f"prompt package '{package_name}' not in this instance")
    lib_dir = _user_packages_lib_dir(u)
    lib_dir.mkdir(parents=True, exist_ok=True)
    target = lib_dir / package_name
    if target.exists():
        if not overwrite:
            raise HTTPException(
                status_code=409,
                detail=f"your package library already contains a prompt package named '{package_name}', resend with confirm to overwrite",
            )
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return {"name": package_name, "status": "exported", "message": f"prompt package '{package_name}' has been added to your package library"}



@router.post("/instances/{instance_id}/skills/{skill_name}/export")
async def export_skill(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Export a skill as a reusable zip package (system or instance)."""
    import zipfile, tempfile
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _resolve_skill_dir(instance_dir, skill_name)
    if not skill_dir:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    export_path = Path(tempfile.gettempdir()) / f"skill-{skill_name}.zip"
    with zipfile.ZipFile(export_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in skill_dir.rglob("*"):
            if fp.is_file():
                zf.write(fp, str(fp.relative_to(skill_dir.parent)))
    return {"name": skill_name, "export_path": str(export_path)}


# ===== Director session memory (.sessions/) =====


class SessionCreateRequest(BaseModel):
    enabled_tools: list[str] | None = None  # None → default read-only base set
    reasoning_effort: str | None = None  # optional none|low|mid|high|max


@router.post("/instances/{instance_id}/sessions")
async def create_session(
    instance_id: str,
    body: SessionCreateRequest,
    user: UserInfo = Depends(require_user),
):
    """Create a session for the instance. Returns its session_id.

    ``enabled_tools`` sets the session's tool allow-list. When omitted, the
    read-only baseline (Read/Glob/Grep/SkillRead/GetRuntimeVars/GitLog/GitDiff/GitStatus/Report/EndSession) applies.
    ``reasoning_effort`` (optional) sets the child session's thinking strength.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..tools import SUB_SESSION_BASE_TOOLS
    from ..reasoning import validate_effort
    from ..sessions import MAIN_SESSION_ID, ensure_meta, resolve_session_path
    session_id = f"session-{uuid.uuid4().hex[:4]}"
    enabled = sorted(set(body.enabled_tools)) if body.enabled_tools is not None else sorted(SUB_SESSION_BASE_TOOLS)
    meta = {"enabled_tools": enabled}
    if validate_effort(body.reasoning_effort):
        meta["reasoning_effort"] = validate_effort(body.reasoning_effort)
    ensure_meta(instance_dir, session_id, meta)
    # 立即产出空 JSONL，使会话在 list_sessions 中立即可见（无需等第一条消息落盘）
    resolve_session_path(instance_dir, session_id).touch(exist_ok=True)
    state.broadcast("session_created", {
        "instance_id": instance_id,
        "session_id": session_id,
        "parent_session_id": None,
        "parent_await_result": False,
        "enabled_tools": enabled,
    })
    return {"session_id": session_id, "enabled_tools": enabled, "reasoning_effort": meta.get("reasoning_effort")}


class ReasoningEffortRequest(BaseModel):
    effort: str | None = None  # none|low|mid|high|max; None clears to default


@router.post("/instances/{instance_id}/sessions/{session_id}/reasoning")
async def set_session_reasoning_effort(
    instance_id: str,
    session_id: str,
    body: ReasoningEffortRequest,
    user: UserInfo = Depends(require_user),
):
    """Set a session's reasoning effort (thinking strength).

    ``session_id == "main"`` → persist as the user-level default in users
    preferences (global across instances). Any other session → persist into that
    child session's ``.meta.json`` as a per-session override.

    Effort value must be one of ``none|low|mid|high|max``.
    """
    from ..reasoning import EFFORT_VALUES, validate_effort
    from ..sessions import MAIN_SESSION_ID
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    effort = validate_effort(body.effort)
    if body.effort is not None and effort is None:
        raise HTTPException(status_code=422, detail=f"Invalid effort '{body.effort}'. Choose from {', '.join(EFFORT_VALUES)}")

    if session_id == MAIN_SESSION_ID:
        from ..database.users import set_preference
        prefs = await set_preference(u["id"], "reasoning_effort", effort)
        return {"session_id": session_id, "reasoning_effort": prefs.get("reasoning_effort"), "scope": "user"}
    else:
        from ..sessions import ensure_meta, save_meta
        meta = ensure_meta(instance_dir, session_id)
        if effort is None:
            meta.pop("reasoning_effort", None)
        else:
            meta["reasoning_effort"] = effort
        save_meta(instance_dir, session_id, meta)
        return {"session_id": session_id, "reasoning_effort": meta.get("reasoning_effort"), "scope": "session"}


@router.get("/instances/{instance_id}/sessions/{session_id}/reasoning")
async def get_session_reasoning_effort(
    instance_id: str,
    session_id: str,
    user: UserInfo = Depends(require_user),
):
    """Return the session's effective reasoning effort (thinking strength).

    ``session_id == "main"`` → read the user-level default. Any other session →
    read that child session's ``.meta.json`` override (falling back to the user
    default when the child hasn't set one). Response mirrors the POST so both
    share the same shape: ``{session_id, reasoning_effort, scope}``.
    """
    from ..reasoning import resolve_session_effort
    from ..sessions import MAIN_SESSION_ID
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    effort = await resolve_session_effort(instance_dir, session_id, u["id"])
    scope = "session" if session_id != MAIN_SESSION_ID else "user"
    return {"session_id": session_id, "reasoning_effort": effort, "scope": scope}


class PermissionRequest(BaseModel):
    action: str  # "add" | "remove"
    tools: list[str] = []


@router.post("/instances/{instance_id}/sessions/{session_id}/permissions")
async def set_session_permissions(
    instance_id: str,
    session_id: str,
    body: PermissionRequest,
    user: UserInfo = Depends(require_user),
):
    """Add/remove tools from a child session's ``enabled_tools`` allow-list.

    ``action`` is ``add`` (union with the current list) or ``remove``
    (difference). Persisted in the child session's ``.meta.json``; the next tool
    loop reads it fresh, so changes take effect without recreating the session.
    The main session is unrestricted and rejects this endpoint.
    """
    from ..sessions import MAIN_SESSION_ID, ensure_meta, save_meta
    from ..tools import TOOL_EXECUTORS, SUB_SESSION_BASE_TOOLS
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    if session_id == MAIN_SESSION_ID:
        raise HTTPException(status_code=400, detail="Permission changes only apply to child sessions")
    if body.action not in ("add", "remove"):
        raise HTTPException(status_code=422, detail="action must be 'add' or 'remove'")

    tools = sorted({t for t in body.tools if isinstance(t, str) and t})
    unknown = [t for t in tools if t not in TOOL_EXECUTORS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown tools: {', '.join(unknown)}")

    instance_dir = _resolve_instance_dir(inst)
    meta = ensure_meta(instance_dir, session_id)
    current = set(meta.get("enabled_tools") or SUB_SESSION_BASE_TOOLS)
    if body.action == "add":
        current |= set(tools)
    else:
        current -= set(tools)
    meta["enabled_tools"] = sorted(current)
    save_meta(instance_dir, session_id, meta)
    return {"session_id": session_id, "enabled_tools": meta["enabled_tools"]}


@router.post("/instances/{instance_id}/sessions/{session_id}/interrupt")
async def interrupt_session(
    instance_id: str,
    session_id: str,
    user: UserInfo = Depends(require_user),
):
    """Interrupt a session's in-flight tool loop (ESC / stop button).

    Sets the interrupt flag and cancels the asyncio task. The session loop
    picks up the flag, persists an interruption record, and drains the queue.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..session_loop import SessionLoop
    SessionLoop.interrupt_session(instance_dir.name, session_id)
    return {"status": "ok", "session_id": session_id}


@router.get("/instances/{instance_id}/sessions/status")
async def sessions_status(instance_id: str, user: UserInfo = Depends(require_user)):
    """Authoritative per-session "is its director loop running right now?" map.

    The frontend renders the submit/stop button and token state from this, rather
    than guessing from its own stream bookkeeping (which races when switching
    between main and background child sessions).

    Returns ``{sessions: {sid: bool}, stats: {sid: {elapsed, token_count}}}`` so
    the frontend can restore the running/elapsed/token state for every session
    in a single request (e.g. after page refresh or SSE reconnect).
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..session_tracker import task_tracker
    running = task_tracker.running_sessions(instance_dir.name)
    stats = task_tracker.get_stats_map(instance_dir.name)
    return {"sessions": running, "stats": stats}


@router.get("/instances/{instance_id}/sessions")
async def list_sessions(instance_id: str, user: UserInfo = Depends(require_user)):
    """List all sessions (main + children) for the instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..sessions import list_sessions as _list
    return {"sessions": _list(instance_dir)}


@router.get("/instances/{instance_id}/sessions/{session_id}")
async def get_session_records(
    instance_id: str,
    session_id: str,
    limit: int | None = None,
    offset: int = 0,
    user: UserInfo = Depends(require_user),
):
    """Read a specific session's memory (main or child) for display."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..sessions import load_records, render_records
    records, total = load_records(instance_dir, limit=limit, offset=offset, session_id=session_id)
    # `records` here is the pre-render JSONL slice; its length is the record-level
    # count consumed by this page. `render_records` expands each record into one or
    # more display bubbles, so the frontend must page by `next_offset` (record
    # units), not by bubble count — otherwise the cursor drifts and history gets
    # skipped / prematurely marked loaded.
    return {"records": render_records(records), "total": total, "next_offset": offset + len(records)}


@router.delete("/instances/{instance_id}/sessions/{session_id}")
async def destroy_session(
    instance_id: str,
    session_id: str,
    abort: bool = False,
    user: UserInfo = Depends(require_user),
):
    """Destroy a session (delete its JSONL + meta).

    ``abort=true`` additionally cancels an in-flight /v1/chat for that session
    (frontend-disconnect style). Broadcasts ``session_destroyed``.

    The main session is special-cased: ``/clear`` truncates its records but
    keeps the JSONL file on disk and does NOT broadcast ``session_destroyed``.
    Deleting the file would drop the main entry from the frontend session
    strip (it only re-adds on a genuine destroy), leaving no "主会话" tab.
    Child sessions keep the delete + broadcast behavior.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..sessions import MAIN_SESSION_ID, destroy as _destroy, truncate as _truncate

    if abort:
        from ..session_tracker import abort_session_requests
        await abort_session_requests(instance_dir.name, session_id)

    if session_id == MAIN_SESSION_ID:
        _truncate(instance_dir, session_id)
        return {"status": "ok", "session_id": session_id}

    _destroy(instance_dir, session_id)
    state.broadcast("session_destroyed", {"instance_id": instance_id, "session_id": session_id})
    return {"status": "ok", "session_id": session_id}


@router.post("/instances/{instance_id}/sessions/{session_id}/compact")
async def compact_session(
    instance_id: str,
    session_id: str,
    user: UserInfo = Depends(require_user),
):
    """Manually trigger session compaction. Only allowed when the session is idle."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..session_tracker import task_tracker
    running = task_tracker.running_sessions(instance_dir.name)
    if running.get(session_id):
        raise HTTPException(status_code=409, detail="Session is currently running, cannot compact")

    from ..app import _resolve_slot_client
    from ..compact import run_compact

    try:
        client = await _resolve_slot_client(u["id"], "director")
    except HTTPException:
        raise HTTPException(status_code=400, detail="Director slot is not configured")

    try:
        summary = await run_compact(client, instance_dir, session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Compact failed: {e}")

    if summary is None:
        return {"status": "ok", "summary_preview": None, "note": "Session was empty, nothing to compact"}

    preview = summary[:200] + ("..." if len(summary) > 200 else "")
    return {"status": "ok", "summary_preview": preview}


@router.get("/instances/{instance_id}/context-usage")
async def get_context_usage(
    instance_id: str,
    session_id: str = Query(default="main"),
    user: UserInfo = Depends(require_user),
):
    """Estimate the active session's context usage vs the auto-compact threshold.

    ``threshold`` = resolved director profile's ``max_context`` x 0.7 (the
    post-flight compact ratio), which the frontend usage bar treats as full.
    ``status`` is ``danger`` (at/over threshold → auto-compact imminent),
    ``warning`` (>= 85% of threshold) or ``normal``. When the director slot is
    not configured, returns nulls so the frontend hides the bar.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..app import _resolve_slot_client
    from ..compact import POST_COMPACT_RATIO, estimate_context_tokens

    try:
        client = await _resolve_slot_client(u["id"], "director")
    except HTTPException:
        return {"session_id": session_id, "estimated_tokens": None,
                "max_context": None, "threshold": None, "status": None}

    max_ctx = client.config.max_context
    threshold = int(max_ctx * POST_COMPACT_RATIO)

    from .. import sessions
    msgs = sessions.records_to_context(
        instance_dir, client.api_style, session_id=session_id
    )
    est = estimate_context_tokens(msgs)

    if est >= threshold:
        status = "danger"
    elif est >= threshold * 0.85:
        status = "warning"
    else:
        status = "normal"

    return {
        "session_id": session_id,
        "estimated_tokens": est,
        "max_context": max_ctx,
        "threshold": threshold,
        "status": status,
    }


# ===== Text style rules =====


@router.get("/instances/{instance_id}/text-style-rules")
async def get_text_style_rules(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get text style rules for an instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..tools import _load_text_style_rules
    rules = _load_text_style_rules(instance_dir)
    return {"rules": rules}


# ===== Sandbox source & floors (file-system driven output) =====

def _list_sandbox_files(instance_dir: Path) -> dict[str, str]:
    """Read all files under runtime/sandbox/, keyed by relative path.

    The sandbox renderer owns this directory exclusively — it is the single
    content source for *.css / *.js UI component scripts. Files under the
    ``disabled/`` subfolder are NOT served — moving a script into
    runtime/sandbox/disabled/ disables it while keeping it versioned in place.
    bootstrap.js is excluded — it's engine-built and served via _read_bootstrap_scripts().

    A fixed manifest file ``runtime/sandbox/manifest.md`` aggregates **package** UI
    resources: each line is a ``{{@包名/runtime/sandbox/xxx.js}}`` (or .css) slice,
    and the referenced file is read from packages/<包名>/** and inlined alongside
    the local scripts. manifest.md itself is not served; its references keep package
    sources out of the instance sandbox dir (职权清晰: 自己写的 vs 引用自包).
    Broken references (package missing / file gone) are skipped silently.
    """
    sandbox_dir = instance_dir / "runtime" / "sandbox"
    files: dict[str, str] = {}
    if not sandbox_dir.is_dir():
        return files
    disabled_dir = sandbox_dir / "disabled"
    manifest_path = sandbox_dir / "manifest.md"
    for p in sorted(sandbox_dir.rglob("*")):
        if p.is_file():
            # Files under disabled/ are not served (deactivated but kept in place)
            if disabled_dir in p.parents:
                continue
            # 引擎内置 bootstrap，实例中的 bootstrap.js 忽略
            if p.name == "bootstrap.js":
                continue
            # manifest 是聚合清单自身，不作为独立资源服务
            if p == manifest_path:
                continue
            rel = str(p.relative_to(instance_dir)).replace("\\", "/")
            try:
                files[rel] = p.read_text(encoding="utf-8")
            except Exception:
                continue
    _aggregate_sandbox_manifest(manifest_path, instance_dir, files)
    return files


def _aggregate_sandbox_manifest(manifest_path: Path, instance_dir: Path, files: dict[str, str]) -> None:
    """Inline package UI resources referenced by the sandbox manifest.md.

    Each non-empty, non-comment line is a ``{{@包名/runtime/sandbox/foo.js|.css}}``
    slice. Reuses placeholder path resolution so traversal guarding and the
    package-root semantics stay identical to {{@pkg}} slices elsewhere.
    """
    from ..placeholder import _resolve_file_path, PlaceholderError
    import re as _re
    if not manifest_path.is_file():
        return
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError:
        return
    slice_re = _re.compile(r"\{\{@([^}]+?)\}\}")
    for line in text.splitlines():
        ln = line.strip()
        if not ln or ln.startswith("#"):
            continue
        for m in slice_re.finditer(ln):
            raw = m.group(1).strip()
            # raw = "<包名>/rest"，rest 内不允许再带 glob（包内只走普通切片）
            slash = raw.find("/")
            if slash == -1:
                continue
            pkg_name = raw[:slash].strip()
            rest = raw[slash + 1:].strip()
            if not pkg_name or not rest:
                continue
            pkg_root = instance_dir / "packages" / pkg_name
            if not pkg_root.is_dir():
                continue
            # 只聚合 js/css 资源；其余(其它切片或无效后缀)跳过
            if not (rest.endswith(".js") or rest.endswith(".css")):
                continue
            try:
                full = _resolve_file_path(instance_dir, rest, base_dir=pkg_root)
            except (PlaceholderError, OSError):
                continue
            try:
                content = full.read_text(encoding="utf-8")
            except OSError:
                continue
            key = f"@{pkg_name}/{rest}"
            if key not in files:
                files[key] = content


def _read_bootstrap_scripts() -> list[str]:
    """Read engine built-in sandbox bootstrap scripts in injection order.

    Scripts are read from the sandbox-bootstrap/ directory under
    director-system/. They are sorted by filename and returned as a list
    of source strings. bootstrap.js always comes first.
    """
    from ..director_system import TEMPLATE_DIR
    bootstrap_dir = TEMPLATE_DIR / "sandbox-bootstrap"
    if not bootstrap_dir.is_dir():
        return []
    scripts: list[str] = []
    for p in sorted(bootstrap_dir.glob("*.js")):
        try:
            scripts.append(p.read_text(encoding="utf-8"))
        except Exception:
            continue
    return scripts


def _list_floors(instance_dir: Path) -> list[dict]:
    """List floors in runtime/floors/, sorted ascending by floor number.

    Returns [{num, path, draft}] where {num} is the file's leading numeric segment
    and {draft} is True for floor-N-draft.md (semi-formal). A formal floor wins
    over its draft when both exist for the same number.
    """
    import re
    floors_dir = instance_dir / "runtime" / "floors"
    best: dict[int, dict] = {}
    if floors_dir.is_dir():
        _num_re = re.compile(r"(\d+)")
        for p in sorted(floors_dir.glob("floor-*.md")):
            if not p.is_file():
                continue
            m = _num_re.search(p.name)
            if not m:
                continue
            num = int(m.group(1))
            draft = bool(re.search(r"-draft\.", p.name))
            rel = str(p.relative_to(instance_dir)).replace("\\", "/")
            cur = best.get(num)
            if cur is None or (not draft and cur.get("draft")):
                best[num] = {"num": num, "path": rel, "draft": draft}
    return [best[num] for num in sorted(best)]


@router.get("/instances/{instance_id}/sandbox-src")
async def get_sandbox_src(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get sandbox source: engine built-in bootstrap + instance UI files."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    return {
        "bootstrap": _read_bootstrap_scripts(),
        "files": _list_sandbox_files(instance_dir),
    }


@router.get("/instances/{instance_id}/floors")
async def get_floors(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get the sorted floor listing from runtime/floors/."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    return {"floors": _list_floors(instance_dir)}


# ===== Git operations =====

class GitCommitRequest(BaseModel):
    type: str  # floor | summary | other
    number: int | None = None
    start: int | None = None
    end: int | None = None
    message: str
    paths: list[str] | None = None  # optional: only commit these paths


class GitBranchRequest(BaseModel):
    action: str  # list | create | switch | delete
    name: str | None = None
    start_point: str | None = None


@router.get("/instances/{instance_id}/git/status")
async def get_git_status(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get the current git branch, recent commits, and dirty status."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    if not (instance_dir / ".git").is_dir():
        return {"git_initialized": False}

    try:
        from ..git_utils import GitError

        branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
        commits = git_log(instance_dir, limit=50, all_branches=True)
        branches = git_branch(instance_dir, "list", None)["branches"]

        # Check for uncommitted changes
        status_out = _git_run(["status", "--porcelain"], instance_dir)
        has_uncommitted = bool(status_out.strip())

        return {
            "git_initialized": True,
            "current_branch": branch,
            "branches": branches,
            "recent_commits": commits,
            "has_uncommitted": has_uncommitted,
        }
    except Exception as e:
        return {"git_initialized": True, "error": str(e)}


@router.post("/instances/{instance_id}/git/commit")
async def api_git_commit(instance_id: str, body: GitCommitRequest, user: UserInfo = Depends(require_user)):
    """Commit all changes in the instance with semantic type."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    # Build git message
    if body.type == "floor":
        git_message = f"floor-{body.number}: {body.message}"
    elif body.type == "summary":
        if body.start == body.end:
            git_message = f"summary-{body.start}: {body.message}"
        else:
            git_message = f"summary-{body.start}-{body.end}: {body.message}"
    else:
        git_message = f"other: {body.message}"

    instance_dir = _resolve_instance_dir(inst)
    # For summary commits, advance the archive boundary in summary/index.json
    # BEFORE git_commit so the index is captured by `git add -A` in this commit.
    if body.type == "summary":
        if body.start is None or body.end is None:
            raise HTTPException(status_code=400, detail="summary type requires start and end parameters")
        update_summary_index(instance_dir, body.start, body.end)
    try:
        result = git_commit(instance_dir, git_message, paths=body.paths)
        state.broadcast("workspace_changed", {"tool": "GitCommit", "branch": result.get("branch", ""), "instance_id": instance_id})
        _broadcast_floors(instance_dir, instance_id)

        if body.type == "floor" and body.number is not None:
            await update_floor_count(instance_id, body.number)

        return result
    except Exception as e:
        error_msg = str(e)
        if "nothing to commit" in error_msg.lower() or "nothing added" in error_msg.lower():
            return {"commit_hash": None, "branch": "", "files_changed": [], "message": "no changes to commit"}
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/instances/{instance_id}/git/branch")
async def api_git_branch(instance_id: str, body: GitBranchRequest, user: UserInfo = Depends(require_user)):
    """Branch operations: list, create, switch, delete."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        result = git_branch(instance_dir, body.action, body.name, body.start_point)
        action = body.action
        if action in ("switch", "create", "delete"):
            state.broadcast("workspace_changed", {"tool": "GitBranch", "action": action, "instance_id": instance_id})
        if action == "switch":
            _broadcast_floors(instance_dir, instance_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/instances/{instance_id}/git/log")
async def api_git_log(instance_id: str, limit: int = Query(10, description="Commit count"), user: UserInfo = Depends(require_user)):
    """View git commit history."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        return {"commits": git_log(instance_dir, limit)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/instances/{instance_id}/git/file-status")
async def api_git_file_status(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get per-file git status for file tree coloring."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        return {"files": git_status_porcelain(instance_dir)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/instances/{instance_id}/refresh")
async def api_refresh(instance_id: str, user: UserInfo = Depends(require_user)):
    """Refresh and return git status + file statuses in a single call."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)

    # Git status
    try:
        if not (instance_dir / ".git").is_dir():
            git_data = {"git_initialized": False}
        else:
            from ..git_utils import GitError
            branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
            commits = git_log(instance_dir, limit=50, all_branches=True)
            branches = git_branch(instance_dir, "list", None)["branches"]
            status_out = _git_run(["status", "--porcelain"], instance_dir)
            has_uncommitted = bool(status_out.strip())
            git_data = {
                "git_initialized": True,
                "current_branch": branch,
                "branches": branches,
                "recent_commits": commits,
                "has_uncommitted": has_uncommitted,
            }
    except Exception as e:
        git_data = {"git_initialized": True, "error": str(e)}

    # File statuses
    try:
        files = git_status_porcelain(instance_dir)
    except Exception:
        files = []

    # Floors stats
    floors_data = get_floors_stats(instance_dir)

    return {"git": git_data, "file_statuses": files, "floors": floors_data}


@router.get("/instances/{instance_id}/git/show-file")
async def api_git_show_file(instance_id: str, path: str = Query(...), user: UserInfo = Depends(require_user)):
    """Return the content of a file at HEAD, or None for new/untracked files."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        content = git_show_file(instance_dir, path)
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class GitRenameRequest(BaseModel):
    old_name: str
    new_name: str


class GitResetRequest(BaseModel):
    target_hash: str


class GitDeleteNodeRequest(BaseModel):
    target_hash: str
    branch_name: str


@router.post("/instances/{instance_id}/git/reset")
async def api_git_reset(instance_id: str, body: GitResetRequest, user: UserInfo = Depends(require_user)):
    """Reset current branch to a target commit (discards commits after it)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        out = git_reset_hard(instance_dir, body.target_hash)
        branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
        state.broadcast("workspace_changed", {"tool": "GitReset", "branch": branch, "instance_id": instance_id})
        _broadcast_floors(instance_dir, instance_id)
        return {"status": "ok", "branch": branch, "message": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/instances/{instance_id}/git/rename-branch")
async def api_git_rename_branch(instance_id: str, body: GitRenameRequest, user: UserInfo = Depends(require_user)):
    """Rename a branch."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        out = git_branch_rename(instance_dir, body.old_name, body.new_name)
        branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
        state.broadcast("workspace_changed", {"tool": "GitRenameBranch", "branch": branch, "instance_id": instance_id})
        return {"status": "ok", "branch": branch, "message": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/instances/{instance_id}/git/delete-branch")
async def api_git_delete_branch(instance_id: str, body: GitBranchRequest, user: UserInfo = Depends(require_user)):
    """Delete a branch by name."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        out = git_delete_branch(instance_dir, body.name)
        return {"status": "ok", "message": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/instances/{instance_id}/git/delete-node")
async def api_git_delete_node(instance_id: str, body: GitDeleteNodeRequest, user: UserInfo = Depends(require_user)):
    """Delete a commit node and all its descendants on the given branch.

    Creates a temporary branch from the target's parent, deletes the original branch,
    then re-creates it with the temp name, effectively removing the node and its children.
    """
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        # Get parent hash of target, and all descendants
        # We need to list all commits reachable from the branch HEAD that are not
        # in the target's ancestor chain
        branch_commits = _git_run(
            ["log", "--oneline", "--format=%H", f"{body.target_hash}..{body.branch_name}"],
            instance_dir,
        ).strip().split("\n") if body.target_hash else []

        parent_out = _git_run(
            ["rev-parse", f"{body.target_hash}^"],
            instance_dir,
        )

        temp_branch = f"_delete_temp_{body.target_hash[:7]}"

        # Create temp branch at parent
        _git_run(["branch", temp_branch, parent_out], instance_dir)

        # Switch to temp branch
        _git_run(["checkout", temp_branch], instance_dir)

        # Delete the original branch
        try:
            git_delete_branch(instance_dir, body.branch_name)
        except GitError:
            _git_run(["branch", "-D", body.branch_name], instance_dir)

        # Check if the target branch still has commits at or before parent_out
        # (i.e. does the branch have any commits other than what's already in parent?)
        # If not, the branch has no unique commits — just switch to main and delete it
        branch_has_content = True
        try:
            # Check how many commits are reachable from parent_out
            rev_count = _git_run(
                ["rev-list", "--count", parent_out],
                instance_dir,
            )
            branch_has_content = int(rev_count) > 0
        except Exception:
            pass

        if not branch_has_content:
            # The branch has no unique commits beyond the root. Delete it and go to main
            _git_run(["branch", "-D", body.branch_name], instance_dir)
            # Check if main exists, otherwise use the first branch found
            all_branches = git_branch_list(instance_dir)
            main_branch = next((b["name"] for b in all_branches if b["name"] in ("main", "master")), None)
            if not main_branch and all_branches:
                main_branch = all_branches[0]["name"]
            if main_branch and main_branch != body.branch_name:
                _git_run(["checkout", main_branch], instance_dir)
            branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
            state.broadcast("workspace_changed", {"tool": "GitDeleteNode", "branch": branch, "instance_id": instance_id})
            _broadcast_floors(instance_dir, instance_id)
            return {"status": "ok", "branch": branch, "message": f"deleted node {body.target_hash} and its successors; branch {body.branch_name} cleaned up"}
        else:
            # Rename temp to original branch name
            _git_run(["branch", "-m", body.branch_name], instance_dir)
            branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
            state.broadcast("workspace_changed", {"tool": "GitDeleteNode", "branch": branch, "instance_id": instance_id})
            _broadcast_floors(instance_dir, instance_id)
            return {"status": "ok", "branch": branch, "message": f"deleted node {body.target_hash} and its successors"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class GitDiscardRequest(BaseModel):
    path: str | None = None


@router.post("/instances/{instance_id}/git/discard")
async def api_git_discard(instance_id: str, body: GitDiscardRequest, user: UserInfo = Depends(require_user)):
    """Discard uncommitted changes. If path is provided, restore only that file.
    Otherwise discard all changes including untracked files."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        if body.path:
            out = git_restore_file(instance_dir, body.path)
            state.broadcast("file_changed", {"path": body.path, "tool": "GitDiscard", "type": "modified", "instance_id": instance_id})
        else:
            out = git_discard_changes(instance_dir)
            state.broadcast("workspace_changed", {"tool": "GitDiscard", "instance_id": instance_id})
        return {"status": "ok", "message": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ===== Tool approval =====

class ToolApproveRequest(BaseModel):
    tool_call_id: str
    args: dict | None = None


class ToolRejectRequest(BaseModel):
    tool_call_id: str
    reason: str = ""


@router.post("/instances/{instance_id}/tool-approve")
async def api_tool_approve(instance_id: str, body: ToolApproveRequest, user: UserInfo = Depends(require_user)):
    """Approve a pending GitCommit. Executes the tool and returns the result."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    from ..app import approval_store
    from ..tools import execute_tool
    instance_dir = _resolve_instance_dir(inst)
    args = body.args or {}
    result = await execute_tool("GitCommit", args, instance_dir, None, instance_id)
    approval_store.approve(body.tool_call_id, result)
    return {"status": "approved"}


@router.post("/instances/{instance_id}/tool-reject")
async def api_tool_reject(instance_id: str, body: ToolRejectRequest, user: UserInfo = Depends(require_user)):
    """Reject a pending GitCommit."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    from ..app import approval_store
    reason = body.reason or "the user declined the commit request"
    approval_store.reject(body.tool_call_id, reason)
    return {"status": "rejected"}