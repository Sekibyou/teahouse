"""
Git operations for instance version control.

All functions operate on an instance directory as a standalone git repository.
Requires git to be installed and available on PATH.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional


class GitError(Exception):
    """Raised when a git command fails."""
    pass


def _git_run(args: list[str], cwd: Path) -> str:
    """Run a git command and return stdout. Raises GitError on failure."""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise GitError("git 命令未找到，请确保 git 已安装并可在 PATH 中使用")
    except subprocess.TimeoutExpired:
        raise GitError("git 命令执行超时")

    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise GitError(stderr or f"git 命令失败 (exit code {result.returncode})")

    return result.stdout.strip()


def git_init(instance_dir: Path) -> str:
    """Initialize a git repository in the instance directory."""
    return _git_run(["init"], instance_dir)


def git_initial_commit(instance_dir: Path) -> str:
    """Stage all files and create the initial commit. Returns commit hash."""
    _git_run(["add", "-A"], instance_dir)
    return _git_run(["commit", "-m", "初始化实例"], instance_dir)


def git_commit(instance_dir: Path, message: str) -> dict:
    """Stage all changes and commit. Returns {commit_hash, branch, files_changed}."""
    _git_run(["add", "-A"], instance_dir)
    hash_out = _git_run(["commit", "-m", message], instance_dir)

    branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
    commit_hash = _git_run(["rev-parse", "--short", "HEAD"], instance_dir)

    # Count changed files
    diff_out = _git_run(["diff", "--name-only", "HEAD~1..HEAD", "--"], instance_dir)
    files = [f for f in diff_out.split("\n") if f] if diff_out else []

    return {
        "commit_hash": commit_hash,
        "branch": branch,
        "files_changed": files,
    }


def git_branch_list(instance_dir: Path) -> list[dict]:
    """List all branches. Returns [{name, is_current, commit_hash, commit_message}]."""
    out = _git_run(["branch", "--format=%(refname:short)|%(objectname:short)|%(subject)"], instance_dir)
    branches = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("|", 2)
        name = parts[0]
        is_current = name.startswith("* ")
        clean_name = name.lstrip("* ")
        branches.append({
            "name": clean_name,
            "is_current": is_current,
            "commit_hash": parts[1] if len(parts) > 1 else "",
            "commit_message": parts[2] if len(parts) > 2 else "",
        })
    return branches


def git_branch_create(instance_dir: Path, name: str) -> str:
    """Create a new branch at current HEAD."""
    return _git_run(["branch", name], instance_dir)


def git_branch_switch(instance_dir: Path, name: str) -> str:
    """Switch to an existing branch."""
    return _git_run(["checkout", name], instance_dir)


def git_branch_delete(instance_dir: Path, name: str) -> str:
    """Delete a branch (safe: refuses if not fully merged)."""
    return _git_run(["branch", "-d", name], instance_dir)


def git_branch(instance_dir: Path, action: str, name: Optional[str] = None) -> dict:
    """Unified branch operation.

    Args:
        action: "list" | "create" | "switch" | "delete"
        name: branch name (required for create/switch/delete)

    Returns:
        dict with action-specific fields.
    """
    if action == "list":
        branches = git_branch_list(instance_dir)
        return {"action": "list", "branches": branches}

    if not name:
        raise GitError("branch name is required for this action")

    if action == "create":
        out = git_branch_create(instance_dir, name)
        return {"action": "create", "name": name, "message": out}

    if action == "switch":
        out = git_branch_switch(instance_dir, name)
        branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
        return {"action": "switch", "name": name, "current_branch": branch, "message": out}

    if action == "delete":
        out = git_branch_delete(instance_dir, name)
        return {"action": "delete", "name": name, "message": out}

    raise GitError(f"Unknown branch action: {action}")


def git_log(instance_dir: Path, limit: int = 10) -> list[dict]:
    """View commit history. Returns [{hash, author, date, message, branch}]."""
    out = _git_run(
        ["log", f"--max-count={limit}", "--format=%H|%an|%ai|%s"],
        instance_dir,
    )
    entries = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("|", 3)
        entries.append({
            "hash": parts[0][:7],
            "author": parts[1] if len(parts) > 1 else "",
            "date": parts[2] if len(parts) > 2 else "",
            "message": parts[3] if len(parts) > 3 else "",
        })
    return entries
