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


# ===== Git operations =====

class GitCommitRequest(BaseModel):
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
    """Commit all changes in the instance."""
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(status_code=404, detail="Instance not found")

    instance_dir = _resolve_instance_dir(inst)
    try:
        result = git_commit(instance_dir, body.message)
        state.broadcast("workspace_changed", {"tool": "GitCommit", "branch": result.get("branch", ""), "instance_id": instance_id})
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