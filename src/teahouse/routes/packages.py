"""
User-level prompt-package library API routes — per-user packages: list, import
(two-phase zip preview/confirm), delete, download.

The user package library lives at data/{safe_name}/packages/<pkg_name>/ and is a
**stock/inventory** only: packages are copied into an instance's
packages/ to take effect (see the instance enable/remove routes in
workspaces.py). It is decoupled from any instance — no reference tracking.

A package is 约束力很弱的"提示词包": a tree of files the author references via
{{@包名/路径}} slices in the assembler/floor. Zip layout is a plain directory
tree; the zip may wrap it in a top-level folder or be flat. README.md is
recommended (but optional) at the package root.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..state import state
from ..database.users import get_user_by_id
from ..routes.auth import require_user, require_user_for_download, UserInfo

router = APIRouter(prefix="/api/my-packages", tags=["my-packages"])

# 包名黑名单校验：允许空格/点号/中文/连字符/下划线（识别符常带版本号，如
# "某人的修仙设定v1.01"），但禁止会破坏 {{@...}} 切片语法解析的字符。
PACKAGE_NAME_BLACKLIST_RE = re.compile(r"[|:{}\\\\/]")
_PACKAGE_NAME_MAXLEN = 80

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


def validate_package_name(name: str) -> None:
    """Blacklist check so a package identifier can't break {{@pkg/path}} parsing."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="包名不能为空")
    if len(name) > _PACKAGE_NAME_MAXLEN:
        raise HTTPException(status_code=400, detail=f"包名过长（上限 {_PACKAGE_NAME_MAXLEN} 字符）")
    if PACKAGE_NAME_BLACKLIST_RE.search(name):
        raise HTTPException(status_code=400, detail="包名含非法字符（禁止 | : { } \\ / 等）")


async def _get_safe_name(user_id: str) -> str:
    u = await get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return u["safe_name"] or u["username"].lower().replace(" ", "_")


def _user_packages_dir(safe_name: str) -> Path:
    return Path(state.workspace_base) / safe_name / "packages"


# ── zip helpers ───────────────────────────────────────────────────


def _zip_package_base(names: list[str]) -> str:
    """Determine the in-zip root whose subtree is the package content.

    The zip may be flat (README.md + runtime/... at zip root) or wrapped in a
    single top-level package folder (mypkg/README.md + mypkg/runtime/...).
    Return the the extraction base: a single top folder's prefix if every entry
    lives under it, otherwise "" (flat).
    """
    files = [n for n in names if not n.endswith("/")]
    if not files:
        raise HTTPException(status_code=400, detail="包内没有文件")
    dirs = {n.split("/", 1)[0] for n in files}
    # 单一顶层目录包裹 → 视为包容器，解压进该目录内
    if len(dirs) == 1:
        top = next(iter(dirs))
        return top + "/"
    return ""


def _validate_zip_path_guard(dest: Path, rel: str, name: str) -> None:
    target = (dest / rel).resolve()
    if not str(target).startswith(str(dest.resolve())):
        raise HTTPException(status_code=400, detail=f"包包含非法路径: {name}")


def _extract_package_tree(zf, names: list[str], base: str, dest: Path) -> None:
    """Extract the subtree under `base` into `dest`, with traversal guard."""
    prefix = base if base else ""
    for name in names:
        if prefix and not name.startswith(prefix):
            continue
        rel = name[len(prefix):].lstrip("/") if prefix else name
        if not rel:
            continue
        _validate_zip_path_guard(dest, rel, name)
        if name.endswith("/"):
            (dest / rel).mkdir(parents=True, exist_ok=True)
        else:
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            (dest / rel).write_bytes(zf.read(name))


def _scan_package_dir(pkg_dir: Path) -> dict:
    """Produce a compact descriptor for a library package dir."""
    return {
        "name": pkg_dir.name,
        "has_readme": (pkg_dir / "README.md").is_file(),
        "file_count": sum(1 for p in pkg_dir.rglob("*") if p.is_file()) if pkg_dir.is_dir() else 0,
        "size": sum(p.stat().st_size for p in pkg_dir.rglob("*") if p.is_file()) if pkg_dir.is_dir() else 0,
        "updated_at": (pkg_dir.stat().st_mtime if pkg_dir.is_dir() else 0),
    }


# ── Routes ────────────────────────────────────────────────────────


@router.get("")
async def api_list_my_packages(user: UserInfo = Depends(require_user)):
    """List the current user's package library."""
    safe_name = await _get_safe_name(user.user_id)
    lib_dir = _user_packages_dir(safe_name)
    packages: list[dict] = []
    if lib_dir.is_dir():
        for entry in sorted(lib_dir.iterdir(), key=lambda e: e.name):
            if entry.is_dir():
                packages.append(_scan_package_dir(entry))
    return {"packages": packages}


class ConfirmImportBody(BaseModel):
    preview_id: str


@router.post("/preview")
async def api_preview_package(
    file: UploadFile = File(...),
    user: UserInfo = Depends(require_user),
):
    """Stage + validate a package zip WITHOUT installing. Returns preview info +
    a short-lived preview_id that import/confirm consumes."""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="只支持 .zip 格式的提示词包")

    _preview_cleanup()
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="提示词包过大 (上限 20MB)")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip", prefix="teahouse_pkg_") as tmp:
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
        raise HTTPException(status_code=400, detail=f"提示词包无效: {e}")

    preview_id = uuid.uuid4().hex
    _previews[preview_id] = {"path": tmp_path, "created_at": time.time()}

    return {
        "preview_id": preview_id,
        "available": True,
        "name": info["name"],
        "preview": info,
    }


def _preview_zip(zip_path: Path) -> dict:
    """Validate a package zip and describe it. Returns {name, has_readme, ...}."""
    import zipfile
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        base = _zip_package_base(names)
        # 包名 = 顶层目录名，或 zip 根 README 的文件名推断后默认取一段
        if base:
            name = base.rstrip("/").rsplit("/", 1)[-1]
        else:
            # flat zip：没有外层目录，包名从 README.md 或内存文件名推断失败，需保证至少非空
            name = ""
        if name:
            try:
                validate_package_name(name)
            except HTTPException:
                raise
        else:
            raise HTTPException(status_code=400, detail="提示词包需以包名目录形式打包（或含 README.md 的文件夹）")
        file_count = sum(1 for n in names if not n.endswith("/"))
        # 根级 README 检测（相对包根 base）
        root_readme = (base + "README.md") if base else "README.md"
        has_readme = root_readme in names
    return {
        "name": name,
        "has_readme": has_readme,
        "file_count": file_count,
    }


@router.post("/import/confirm")
async def api_import_package_confirm(
    body: ConfirmImportBody,
    user: UserInfo = Depends(require_user),
):
    """Install a previously previewed package zip into the user library."""
    _preview_cleanup()
    entry = _previews.pop(body.preview_id, None)
    if not entry:
        raise HTTPException(status_code=400, detail="preview 已过期或无效，请重新上传提示词包")
    tmp_path = entry["path"]

    safe_name = await _get_safe_name(user.user_id)
    try:
        import zipfile
        with zipfile.ZipFile(tmp_path, "r") as zf:
            names = zf.namelist()
            base = _zip_package_base(names)
            name = base.rstrip("/").rsplit("/", 1)[-1] if base else ""
            if not name:
                raise HTTPException(status_code=400, detail="包名无法确定")
            validate_package_name(name)
            dest = _user_packages_dir(safe_name) / name
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True, exist_ok=True)
            _extract_package_tree(zf, names, base, dest)
        return {"status": "ok", "name": name, "message": f"提示词包 '{name}' 已导入"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导入失败: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.delete("/{package_name}")
async def api_delete_my_package(package_name: str, user: UserInfo = Depends(require_user)):
    validate_package_name(package_name)
    safe_name = await _get_safe_name(user.user_id)
    pkg_dir = _user_packages_dir(safe_name) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"提示词包 '{package_name}' 不在你的包库中")
    shutil.rmtree(pkg_dir)
    return {"status": "ok", "name": package_name, "message": f"提示词包 '{package_name}' 已删除"}


@router.get("/{package_name}/download")
async def api_download_my_package(package_name: str, user: UserInfo = Depends(require_user_for_download)):
    import zipfile
    validate_package_name(package_name)
    safe_name = await _get_safe_name(user.user_id)
    pkg_dir = _user_packages_dir(safe_name) / package_name
    if not pkg_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"提示词包 '{package_name}' 不在你的包库中")
    zip_path = Path(tempfile.gettempdir()) / f"pkg-{package_name}-{uuid.uuid4().hex[:8]}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in pkg_dir.rglob("*"):
            if fp.is_file():
                zf.write(fp, f"{package_name}/{fp.relative_to(pkg_dir)}")
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{package_name}.zip",
    )
