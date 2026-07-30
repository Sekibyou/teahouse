"""
Prototype and instance API routes.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..state import state
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
    delete_instance,
    ensure_user_dirs,
    instantiate_prototype,
    list_file_tree,
    read_file,
    write_file,
    delete_file_or_dir,
    create_file_or_dir,
    update_floor_count,
)
from ..git_utils import git_commit, git_branch, git_log, git_status_porcelain, git_branch_rename, git_reset_hard, git_delete_branch, git_rev_parse, git_discard_changes, git_restore_file, git_show_file, _git_run, GitError


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
    source_subpath: str = "_prototype"
    name: str
    description: str = ""
    author: str = ""
    version: str = "1.0.0"


class StartInstanceRequest(BaseModel):
    prototype_id: str
    name: str


class FileCreateRequest(BaseModel):
    path: str
    type: str = "file"  # "file" or "directory"


class FileWriteRequest(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api", tags=["workspace"])


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
    """Create a new prototype from an instance's _prototype/ directory."""
    u = await require_user_info(user)
    base = _get_base_path()
    safe_name = u["safe_name"] or user.username.lower().replace(" ", "_")

    inst = await get_instance(body.instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst["user_id"] != u["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    instance_dir = Path(inst["dir_path"])
    source_dir = (instance_dir / body.source_subpath).resolve()
    if str(source_dir) != str(instance_dir.resolve() / body.source_subpath):
        raise HTTPException(status_code=400, detail="Invalid source path")

    if not source_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Source directory not found: {body.source_subpath}. "
                   f"Use the teahouse-export-prototype skill to build it first."
        )

    # Check directory is not empty
    contents = list(source_dir.iterdir())
    if not contents:
        raise HTTPException(status_code=400, detail="Source directory is empty")

    import uuid as _uuid
    import zipfile as _zipfile
    import hashlib
    import json

    # Compute content hash from all files (before adding metadata)
    file_list = sorted(
        str(f.relative_to(source_dir)).replace("\\", "/")
        for f in source_dir.rglob("*") if f.is_file()
    )
    sha = hashlib.sha256()
    for rel in file_list:
        sha.update(rel.encode("utf-8"))
        with open(source_dir / rel, "rb") as fh:
            while chunk := fh.read(65536):
                sha.update(chunk)
    content_hash = sha.hexdigest()

    # Write metadata into the source directory before packing
    metadata_dir = source_dir / ".teahouse"
    metadata_dir.mkdir(parents=True, exist_ok=True)
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
            if f.is_file():
                arcname = str(f.relative_to(source_dir)).replace("\\", "/")
                zf.write(f, arcname)

    # Clean up metadata file from source dir
    (metadata_dir / "prototype.json").unlink()
    try:
        metadata_dir.rmdir()
    except OSError:
        pass

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
            with zf.open(".teahouse/prototype.json") as mf:
                metadata = json.loads(mf.read().decode("utf-8"))
        except KeyError:
            pass
        try:
            with zf.open("README.md") as rf:
                readme = rf.read().decode("utf-8")
        except KeyError:
            pass

    return {"metadata": metadata, "readme": readme}


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
        # Compute hash from all files except .teahouse/prototype.json
        sha = hashlib.sha256()
        for n in names:
            if n == ".teahouse/prototype.json":
                continue
            sha.update(n.encode("utf-8"))
            sha.update(zf.read(n))
        computed_hash = sha.hexdigest()

        # Read metadata if present
        try:
            with zf.open(".teahouse/prototype.json") as mf:
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
                "detail": "此原型已存在（内容 hash 一致）",
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
        content = read_file(instance_dir, path)
        return {"path": path, "content": content}
    except (FileNotFoundError, IsADirectoryError):
        raise HTTPException(status_code=404, detail="File not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
        return {"path": path, "status": "saved"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
        return {"path": body.path, "status": "created"}
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Already exists")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
        return {"path": path, "status": "deleted"}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    except OSError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ===== Skills =====

SKILLS_DIR = "skills"


def _get_skill_dir(instance_dir: Path, skill_name: str) -> Path:
    return instance_dir / SKILLS_DIR / skill_name


def _read_file_text(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


@router.get("/instances/{instance_id}/skills")
async def list_skills(instance_id: str, user: UserInfo = Depends(require_user)):
    """List all skills in an instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skills_dir = instance_dir / SKILLS_DIR
    if not skills_dir.is_dir():
        return []
    result = []
    for entry in sorted(skills_dir.iterdir()):
        if entry.is_dir():
            result.append({
                "name": entry.name,
                "path": f"{SKILLS_DIR}/{entry.name}",
                "has_skill": (entry / "SKILL.md").exists(),
                "has_examples": (entry / "examples").is_dir(),
            })
    return result


@router.get("/instances/{instance_id}/skills/{skill_name}")
async def get_skill(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Read a skill's full content (SKILL.md + examples)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if not skill_dir.is_dir():
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
    """Delete a skill. Built-in skills (teahouse-generate-floor, teahouse-summarize) are protected."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    if skill_name in ("teahouse-generate-floor", "teahouse-summarize"):
        raise HTTPException(status_code=400, detail="Cannot delete built-in skills")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    shutil.rmtree(skill_dir)
    return {"name": skill_name, "status": "deleted"}


@router.post("/instances/{instance_id}/skills/{skill_name}/export")
async def export_skill(instance_id: str, skill_name: str, user: UserInfo = Depends(require_user)):
    """Export a skill as a reusable zip package."""
    import zipfile, tempfile
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    skill_dir = _get_skill_dir(instance_dir, skill_name)
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")
    export_path = Path(tempfile.gettempdir()) / f"skill-{skill_name}.zip"
    with zipfile.ZipFile(export_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in skill_dir.rglob("*"):
            if fp.is_file():
                zf.write(fp, str(fp.relative_to(skill_dir.parent)))
    return {"name": skill_name, "export_path": str(export_path)}


# ===== Output blocks =====


@router.get("/instances/{instance_id}/output-blocks")
async def list_output_blocks(instance_id: str, user: UserInfo = Depends(require_user)):
    """Get all active output blocks (summary: uuid, label, note)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..tools import _load_output_blocks
    blocks = _load_output_blocks(instance_dir)
    return {
        "blocks": [
            {"uuid": b["uuid"], "label": b["label"], "note": b["note"], "content_type": b.get("content_type", "rich_text")}
            for b in blocks
        ]
    }


@router.get("/instances/{instance_id}/output-blocks/{uuid}")
async def get_output_block(instance_id: str, uuid: str, user: UserInfo = Depends(require_user)):
    """Get a single output block's full data (content, rendered, label, note)."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    instance_dir = _resolve_instance_dir(inst)

    from ..tools import _load_output_blocks, _load_rendered
    from ..placeholder import resolve_placeholders
    blocks = _load_output_blocks(instance_dir)
    rendered_map = _load_rendered(instance_dir)
    for b in blocks:
        if b["uuid"] == uuid:
            if uuid in rendered_map:
                rendered = rendered_map[uuid]
            else:
                rendered = resolve_placeholders(b["content"], instance_dir)
            return {
                "uuid": b["uuid"],
                "label": b["label"],
                "note": b["note"],
                "content": b["content"],
                "rendered": rendered,
                "content_type": b.get("content_type", "rich_text"),
            }
    raise HTTPException(status_code=404, detail=f"Output block '{uuid}' not found")


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


# ===== Git operations =====

class GitCommitRequest(BaseModel):
    type: str  # floor | summary | other
    number: int | None = None
    start: int | None = None
    end: int | None = None
    message: str


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
    try:
        result = git_commit(instance_dir, git_message)
        state.broadcast("workspace_changed", {"tool": "GitCommit", "branch": result.get("branch", ""), "instance_id": instance_id})

        if body.type == "floor" and body.number is not None:
            await update_floor_count(instance_id, body.number)

        return result
    except Exception as e:
        error_msg = str(e)
        if "nothing to commit" in error_msg.lower() or "nothing added" in error_msg.lower():
            return {"commit_hash": None, "branch": "", "files_changed": [], "message": "没有需要提交的变更"}
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
            return {"status": "ok", "branch": branch, "message": f"已删除节点 {body.target_hash} 及其后续提交，分支 {body.branch_name} 已清理"}
        else:
            # Rename temp to original branch name
            _git_run(["branch", "-m", body.branch_name], instance_dir)
            branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
            state.broadcast("workspace_changed", {"tool": "GitDeleteNode", "branch": branch, "instance_id": instance_id})
            return {"status": "ok", "branch": branch, "message": f"已删除节点 {body.target_hash} 及其后续提交"}
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
            state.broadcast("file_changed", {"path": body.path, "tool": "GitDiscard", "instance_id": instance_id})
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
    reason = body.reason or "用户拒绝了提交请求。"
    approval_store.reject(body.tool_call_id, reason)
    return {"status": "rejected"}