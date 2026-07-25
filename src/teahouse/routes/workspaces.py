"""
Prototype and instance API routes.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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
    list_instances,
    get_instance,
    create_instance,
    delete_instance,
    ensure_user_dirs,
    register_builtin_prototype_source_path,
    instantiate_prototype,
    list_file_tree,
    read_file,
    write_file,
    delete_file_or_dir,
    create_file_or_dir,
)


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
    name: str
    description: str = ""


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
    """Delete a skill. Built-in skills (generate-floor, summarize) are protected."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")
    if skill_name in ("generate-floor", "summarize"):
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
