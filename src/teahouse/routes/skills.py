"""
User-level skill library API routes — per-user skills: list, import (two-phase
zip preview/confirm), delete, download.

The user skill library lives at data/{safe_name}/skills/<skill_name>/ and is a
**stock/inventory** only: skills are copied into an instance's
.teahouse/skills/ to take effect (see the instance enable/export routes in
workspaces.py). It is decoupled from any instance — no reference tracking.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..state import state
from ..database.users import get_user_by_id
from ..routes.auth import require_user, UserInfo

router = APIRouter(prefix="/api/my-skills", tags=["my-skills"])

SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

# In-memory import-preview store: {preview_id: {path, created_at}}.
_PREVIEW_TTL = 300  # seconds
_previews: dict[str, dict] = {}


def _preview_cleanup() -> None:
    now = time.time()
    stale = [k for k, v in _previews.items() if now - v["created_at"] > _PREVIEW_TTL]
    for k in stale:
        try:
            os.unlink(_previews[k]["path"])
        except OSError:
            pass
        _previews.pop(k, None)


async def _get_safe_name(user_id: str) -> str:
    u = await get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return u["safe_name"] or u["username"].lower().replace(" ", "_")


def _user_skills_dir(safe_name: str) -> Path:
    return Path(state.workspace_base) / safe_name / "skills"


# ── zip helpers ───────────────────────────────────────────────────


def _zip_skill_base(names: list[str]) -> str | None:
    """Locate SKILL.md's parent dir in a zip and return its archive-relative base.

    Accepts both a bare skill folder (`myskill/SKILL.md`) and an existing export
    which wrapped the skill in `skills/` (`skills/myskill/SKILL.md`). Returns the
    relative prefix whose subtree should be extracted, or None if no SKILL.md.
    """
    matches = [n for n in names if n.endswith("/SKILL.md")]
    if not matches:
        return None
    # Prefer the shallowest SKILL.md (most likely the intended skill root).
    matches.sort(key=lambda n: n.count("/"))
    rel = matches[0]
    base = rel.rsplit("/", 1)[0] if "/" in rel else ""
    return base


def _extract_skill_tree(zf, names: list[str], base: str, dest: Path) -> None:
    """Extract only the subtree under `base` into `dest`, with traversal guard."""
    prefix = base.rstrip("/") + "/" if base else ""
    for name in names:
        if base and not name.startswith(prefix):
            continue
        rel = name[len(prefix):].lstrip("/") if prefix else name
        if not rel:
            continue
        target = (dest / rel).resolve()
        if not str(target).startswith(str(dest.resolve())):
            raise HTTPException(status_code=400, detail=f"skill 包包含非法路径: {name}")
        if name.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(name))


def _scan_skill_dir(skill_dir: Path) -> dict:
    """Produce a compact skill descriptor for a library skill dir."""
    return {
        "name": skill_dir.name,
        "has_skill": (skill_dir / "SKILL.md").exists(),
        "has_examples": (skill_dir / "examples").is_dir(),
        "file_count": sum(1 for p in skill_dir.rglob("*") if p.is_file()) if skill_dir.is_dir() else 0,
        "size": sum(p.stat().st_size for p in skill_dir.rglob("*") if p.is_file()) if skill_dir.is_dir() else 0,
        "updated_at": (skill_dir.stat().st_mtime if skill_dir.is_dir() else 0),
    }


# ── Routes ────────────────────────────────────────────────────────


@router.get("")
async def api_list_my_skills(user: UserInfo = Depends(require_user)):
    """List the current user's skill library."""
    safe_name = await _get_safe_name(user.user_id)
    lib_dir = _user_skills_dir(safe_name)
    skills: list[dict] = []
    if lib_dir.is_dir():
        for entry in sorted(lib_dir.iterdir(), key=lambda e: e.name):
            if entry.is_dir():
                skills.append(_scan_skill_dir(entry))
    return {"skills": skills}


class ConfirmImportBody(BaseModel):
    preview_id: str


@router.post("/preview")
async def api_preview_skill(
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Stage + validate a skill zip WITHOUT installing. Returns preview info +
    a short-lived preview_id that import/confirm consumes."""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="只支持 .zip 格式的 skill 包")

    _preview_cleanup()
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="skill 包过大 (上限 20MB)")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip", prefix="teahouse_skill_") as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        info = _preview_zip(Path(tmp_path))
    except HTTPException:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass
        raise
    except Exception as e:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass
        raise HTTPException(status_code=400, detail=f"skill 包无效: {e}")

    preview_id = uuid.uuid4().hex
    _previews[preview_id] = {"path": tmp_path, "created_at": time.time()}

    return {
        "preview_id": preview_id,
        "available": True,
        "name": info["name"],
        "preview": info,
    }


def _preview_zip(zip_path: Path) -> dict:
    """Validate a skill zip and describe it. Returns {name, has_skill, ...}."""
    import zipfile
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        base = _zip_skill_base(names)
        if base is None:
            raise HTTPException(status_code=400, detail="skill 包缺少 SKILL.md")
        # Skill name = the deepest directory component of the base.
        name = base.rstrip("/").rsplit("/", 1)[-1] if base else ""
        if not name:
            raise HTTPException(status_code=400, detail="skill 包根目录无法确定 skill 名")
        if not SKILL_NAME_RE.match(name):
            raise HTTPException(status_code=400, detail="skill 名只能包含字母、数字、连字符、下划线")
        if not base:
            # Flat zip (SKILL.md at root) — skill name from file name.
            raise HTTPException(status_code=400, detail="skill 包需以 skill 文件夹形式打包")
        file_count = sum(1 for n in names if not n.endswith("/"))
    return {
        "name": name,
        "has_skill": True,
        "has_examples": False,  # derived after extraction; keep simple
        "file_count": file_count,
    }


@router.post("/import/confirm")
async def api_import_skill_confirm(
    body: ConfirmImportBody,
    user: UserInfo = Depends(require_user),
):
    """Install a previously previewed skill zip into the user library."""
    _preview_cleanup()
    entry = _previews.pop(body.preview_id, None)
    if not entry:
        raise HTTPException(status_code=400, detail="preview 已过期或无效，请重新上传 skill 包")
    tmp_path = entry["path"]

    safe_name = await _get_safe_name(user.user_id)
    try:
        import zipfile
        with zipfile.ZipFile(tmp_path, "r") as zf:
            names = zf.namelist()
            base = _zip_skill_base(names)
            if base is None:
                raise HTTPException(status_code=400, detail="skill 包缺少 SKILL.md")
            name = base.rstrip("/").rsplit("/", 1)[-1] if base else ""
            if not name or not SKILL_NAME_RE.match(name):
                raise HTTPException(status_code=400, detail="skill 名不合法")
            dest = _user_skills_dir(safe_name) / name
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True, exist_ok=True)
            _extract_skill_tree(zf, names, base, dest)
        return {"status": "ok", "name": name, "message": f"skill '{name}' 已导入"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导入失败: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.delete("/{skill_name}")
async def api_delete_my_skill(skill_name: str, user: UserInfo = Depends(require_user)):
    if not SKILL_NAME_RE.match(skill_name):
        raise HTTPException(status_code=400, detail="skill 名不合法")
    safe_name = await _get_safe_name(user.user_id)
    skill_dir = _user_skills_dir(safe_name) / skill_name
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"skill '{skill_name}' 不在你的 skill 库中")
    shutil.rmtree(skill_dir)
    return {"status": "ok", "name": skill_name, "message": f"skill '{skill_name}' 已删除"}


@router.get("/{skill_name}/download")
async def api_download_my_skill(skill_name: str, user: UserInfo = Depends(require_user)):
    import zipfile, tempfile
    if not SKILL_NAME_RE.match(skill_name):
        raise HTTPException(status_code=400, detail="skill 名不合法")
    safe_name = await _get_safe_name(user.user_id)
    skill_dir = _user_skills_dir(safe_name) / skill_name
    if not skill_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"skill '{skill_name}' 不在你的 skill 库中")
    zip_path = Path(tempfile.gettempdir()) / f"skill-{skill_name}-{uuid.uuid4().hex[:8]}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in skill_dir.rglob("*"):
            if fp.is_file():
                zf.write(fp, f"{skill_name}/{fp.relative_to(skill_dir)}")
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{skill_name}.zip",
    )
