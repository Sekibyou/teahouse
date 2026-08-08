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


_INDEX_LOCK_RETRIES = 10
_INDEX_LOCK_INITIAL_DELAY = 0.05


def _git_run(args: list[str], cwd: Path) -> str:
    """Run a git command and return stdout. Raises GitError on failure.

    Writes that touch the index (git add/commit/status) can transiently fail
    with an index.lock conflict when another git process (e.g. a background
    summary sub-session) holds the lock. We back off and retry briefly so
    concurrent floor + summary commits don't race each other.
    """
    try:
        import os
        env = os.environ.copy()
        env["GIT_PAGER"] = "cat"
        env["GIT_TERMINAL_PROMPT"] = "0"
        # Disable path quoting so CJK filenames don't get octal-escaped
        args = ["-c", "core.quotepath=false"] + args
        import time
        delay = _INDEX_LOCK_INITIAL_DELAY
        for attempt in range(_INDEX_LOCK_RETRIES):
            result = subprocess.run(
                ["git"] + args,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
                timeout=30,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            if b"index.lock" not in (result.stderr or "").encode("utf-8", "replace"):
                break
            # index.lock contention — back off and retry
            time.sleep(delay)
            delay *= 2
        stderr = result.stderr or ""
    except FileNotFoundError:
        raise GitError("git 命令未找到，请确保 git 已安装并可在 PATH 中使用")
    except subprocess.TimeoutExpired:
        raise GitError("git 命令执行超时")

    raise GitError(stderr.strip() or f"git 命令失败 (exit code {result.returncode})")


def git_init(instance_dir: Path) -> str:
    """Initialize a git repository in the instance directory."""
    return _git_run(["init"], instance_dir)


def git_initial_commit(instance_dir: Path) -> str:
    """Stage all files and create the initial commit. Returns commit hash."""
    _git_run(["add", "-A"], instance_dir)
    return _git_run(["commit", "-m", "other: 初始化实例"], instance_dir)


def git_commit(instance_dir: Path, message: str, paths: list[str] | None = None) -> dict:
    """Stage changes and commit. Returns {commit_hash, branch, files_changed}.

    When ``paths`` is given, only those paths are staged (``git add <paths...>``),
    leaving the rest of the working tree uncommitted — so concurrent work in a
    different subtree (e.g. a background summary touching dyn_settings while
    the main session touches floors) stays isolated. Without ``paths``, behaves as
    before: ``git add -A`` (stage everything).
    """
    if paths:
        _git_run(["add", "--", *paths], instance_dir)
    else:
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


def git_branch_create(instance_dir: Path, name: str, start_point: str | None = None) -> str:
    """Create a new branch at current HEAD or at a specific start point."""
    args = ["branch", name]
    if start_point:
        args.append(start_point)
    return _git_run(args, instance_dir)


def git_discard_changes(instance_dir: Path) -> str:
    """Discard all uncommitted changes: restore tracked files AND delete untracked files."""
    result1 = _git_run(["checkout", "--", "."], instance_dir)
    result2 = _git_run(["clean", "-fd"], instance_dir)
    return f"{result1}\n{result2}"


def git_restore_file(instance_dir: Path, file_path: str) -> str:
    """Restore a specific file to its last committed state.

    For tracked files: git checkout to restore.
    For untracked files: delete them (they have no committed state to restore to).
    """
    full_path = instance_dir / file_path
    # Check if the file is tracked by git
    try:
        _git_run(["ls-files", "--error-unmatch", file_path], instance_dir)
        # Tracked — restore to HEAD
        return _git_run(["checkout", "--", file_path], instance_dir)
    except Exception:
        # Untracked — delete it
        if full_path.exists():
            import shutil
            if full_path.is_dir():
                shutil.rmtree(full_path)
            else:
                full_path.unlink()
            return f"Removed untracked: {file_path}"
        return f"File not found: {file_path}"


def git_branch_switch(instance_dir: Path, name: str) -> str:
    """Switch to an existing branch."""
    return _git_run(["checkout", name], instance_dir)


def git_branch_switch_with_cleanup(instance_dir: Path, name: str) -> str:
    """Switch to a branch and clean up orphaned temp-* branches after."""
    result = git_branch_switch(instance_dir, name)
    cleanup_temp_branches(instance_dir)
    return result


def cleanup_temp_branches(instance_dir: Path) -> list[str]:
    """Delete temp-* and _delete_temp_* branches that have no unique commits.

    A temp branch is considered "orphaned" if its tip commit is contained in
    at least one other branch — meaning switching away without adding new
    commits left it pointing at a commit that already exists elsewhere.

    Returns list of deleted branch names.
    """
    all_branches = git_branch_list(instance_dir)
    all_names = [b["name"] for b in all_branches]
    temp_branches = [b for b in all_branches if b["name"].startswith("temp-") or b["name"].startswith("_delete_temp_")]

    deleted = []
    for tb in temp_branches:
        # Find all branches (other than this one) that contain this commit
        containing = _git_run(
            ["branch", "--contains", tb["commit_hash"], "--format=%(refname:short)"],
            instance_dir,
        ).split("\n")
        containing = [c.strip().lstrip("* ") for c in containing if c.strip()]
        containing = [c for c in containing if c != tb["name"]]

        # If at least one other branch contains this commit, the temp branch
        # has no unique content and can be safely deleted.
        if containing:
            try:
                git_branch_delete(instance_dir, tb["name"])
                deleted.append(tb["name"])
            except GitError:
                # Safe delete may fail if branch not merged into current branch;
                # force delete as it's a temp branch with no unique content
                try:
                    git_delete_branch(instance_dir, tb["name"])
                    deleted.append(tb["name"])
                except GitError:
                    pass

    return deleted


def git_branch_delete(instance_dir: Path, name: str) -> str:
    """Delete a branch (safe: refuses if not fully merged)."""
    return _git_run(["branch", "-d", name], instance_dir)


def git_branch_rename(instance_dir: Path, old_name: str, new_name: str) -> str:
    """Rename a branch from old_name to new_name."""
    return _git_run(["branch", "-m", old_name, new_name], instance_dir)


def git_reset_hard(instance_dir: Path, target_hash: str) -> str:
    """Reset current branch to target commit, discarding all commits after it."""
    return _git_run(["reset", "--hard", target_hash], instance_dir)


def git_delete_branch(instance_dir: Path, name: str) -> str:
    """Force-delete a branch."""
    return _git_run(["branch", "-D", name], instance_dir)


def git_rev_parse(instance_dir: Path, ref: str) -> str:
    """Resolve a git ref to a full commit hash."""
    return _git_run(["rev-parse", ref], instance_dir)


def git_branch(instance_dir: Path, action: str, name: Optional[str] = None, start_point: Optional[str] = None) -> dict:
    """Unified branch operation.

    Args:
        action: "list" | "create" | "switch" | "delete"
        name: branch name (required for create/switch/delete)
        start_point: optional commit hash to create the branch at

    Returns:
        dict with action-specific fields.
    """
    if action == "list":
        branches = git_branch_list(instance_dir)
        return {"action": "list", "branches": branches}

    if not name:
        raise GitError("branch name is required for this action")

    if action == "create":
        out = git_branch_create(instance_dir, name, start_point)
        return {"action": "create", "name": name, "message": out}

    if action == "switch":
        out = git_branch_switch_with_cleanup(instance_dir, name)
        branch = _git_run(["rev-parse", "--abbrev-ref", "HEAD"], instance_dir)
        return {"action": "switch", "name": name, "current_branch": branch, "message": out}

    if action == "delete":
        out = git_branch_delete(instance_dir, name)
        return {"action": "delete", "name": name, "message": out}

    raise GitError(f"Unknown branch action: {action}")


def git_status_porcelain(instance_dir: Path) -> list[dict]:
    """Parse `git status --porcelain` to get per-file status.

    Returns [{path, status, staged}] where status is one of:
        M=modified, A=added, D=deleted, R=renamed, ?=untracked
    staged=True if the change is in the index (staged for commit).
    """
    out = _git_run(["status", "--porcelain"], instance_dir)
    entries = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        # First two chars: XY where X=staged status, Y=working-tree status
        raw = line[:2]
        path = line[2:].strip()
        staged = raw[0] != " "

        if raw[0] == "?" and raw[1] == "?":
            status = "?"
        elif raw[0] == "!" and raw[1] == "!":
            continue  # ignored
        elif raw[1] == "M":
            status = "M"
        elif raw[0] == "M":
            status = "M"
        elif raw[0] == "A":
            status = "A"
        elif raw[0] == "D":
            status = "D"
        elif raw[1] == "D":
            status = "D"
        elif raw[0] == "R":
            status = "R"
        elif raw[1] == "?":
            status = "?"
        else:
            status = raw.strip()

        entries.append({"path": path, "status": status, "staged": staged})
    return entries


def git_log(instance_dir: Path, limit: int = 10, all_branches: bool = False) -> list[dict]:
    """View commit history. Returns [{hash, author, date, message, parents, refs, branch}]."""
    args = ["log"]
    if all_branches:
        args.append("--all")
    args += [f"--max-count={limit}", "--format=%H|%P|%an|%ai|%s|%D"]
    out = _git_run(args, instance_dir)
    entries = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("|", 5)
        parents = parts[1].split() if len(parts) > 1 and parts[1] else []
        entries.append({
            "hash": parts[0][:7] if len(parts) > 0 else "",
            "hash_full": parts[0] if len(parts) > 0 else "",
            "parents": [p[:7] for p in parents],
            "parents_full": parents,
            "author": parts[2] if len(parts) > 2 else "",
            "date": parts[3] if len(parts) > 3 else "",
            "message": parts[4] if len(parts) > 4 else "",
            "refs": parts[5] if len(parts) > 5 else "",
        })
    return entries


def git_show_file(instance_dir: Path, file_path: str) -> str | None:
    """Return the content of a file at HEAD, or None if the file doesn't exist in HEAD."""
    try:
        return _git_run(["show", f"HEAD:{file_path}"], instance_dir)
    except GitError:
        return None


def git_diff(instance_dir: Path, path: str | None = None, staged: bool = False) -> str:
    """Return git diff for uncommitted changes.

    ``staged=True`` shows the staged view (``git diff --cached``) — what is in
    the index ready to be committed. ``staged=False`` (default) shows the
    working-tree view vs HEAD. If ``path`` is given, only diff that file/dir.
    """
    args = ["diff"]
    if staged:
        args.append("--cached")
    if path:
        args.extend(["--", path])
    return _git_run(args, instance_dir)
