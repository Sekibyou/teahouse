#!/usr/bin/env python3
"""Teahouse release build — idempotent, step-selective, platform-adaptive.

Builds everything needed to ship into a single deliverable folder:

    dist/Teahouse/
      Teahouse.exe / Teahouse    double-click / exec entry (per-platform)
      _internal/       Python runtime + bundled resources
      git/             bundled MinGit  (Windows only; Linux uses system git)
      dist.zip + dist.hash   frontend (runtime unpacks dist/ from dist.zip)

Platform behavior:
    Windows  — produces Teahouse.exe + bundled MinGit, ships two zips:
               Teahouse-<ver>-Windows-with-git.zip (new users) /
               Teahouse-<ver>-Windows.zip (update).
    Linux    — produces a no-suffix Teahouse executable + no bundled git
               (app falls back to system git), ships Teahouse-<ver>-Linux-<arch>.tar.gz.
    The bundled frontend dist.zip + dist.hash are identical across platforms.

Idempotent: safe to run repeatedly from any state (clean or partial).
Each run produces a fresh dist/Teahouse with no leftover test residue.

Steps (with no args, every step is run):

    python build/build_release.py [--check] [--frontend] [--backend] [--validate] [--verify] [--zip]
      --check      verify prerequisites only (python/pyinstaller/pnpm/MinGit)
      --frontend   build the frontend (pnpm build)
      --backend    run PyInstaller to bundle backend + resources
      --assets     hash + compress the frontend into dist.zip + dist.hash
      --verify     check the deliverable has all pieces in place
      --zip        package the deliverable (per-platform):
                     Windows: Teahouse-<ver>-Windows-with-git.zip
                              Teahouse-<ver>-Windows.zip
                     Linux:   Teahouse-<ver>-Linux-<arch>.tar.gz

Exit code 0 on success, non-zero on failure. The .bat wrapper pauses so the
console window stays open to read the result.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # w:/teahouse
ON_WINDOWS = os.name == "nt"

# Linux 交付子的架构后缀（x86_64/AMD64/i686 → x86-64；aarch64/arm64 → aarch64）。
# 前端 dist.zip 跨架构同源，各架构包内自带同一份自愈源；dist.hash 亦一致。
_ARCH = platform.machine().lower()
LINUX_ARCH = (
    "x86-64"
    if _ARCH in {"x86_64", "amd64", "i686", "i386"}
    else "aarch64"
    if _ARCH in {"aarch64", "arm64"}
    else _ARCH
)

# --- 平台相关常量：Windows 与 Linux 的 venv/可执行/捆绑 git 形态不同 ----------
# Windows: .venv/Scripts/python.exe + pyinstaller.exe，产物 Teahouse.exe，捆绑 MinGit
# Linux:   .venv/bin/python     + pyinstaller        ，产物 Teahouse（无后缀），走系统 git
VENV_BIN = ROOT / ".venv" / ("Scripts" if ON_WINDOWS else "bin")
PYTHON = VENV_BIN / ("python.exe" if ON_WINDOWS else "python")
PYINSTALLER = VENV_BIN / ("pyinstaller.exe" if ON_WINDOWS else "pyinstaller")
MINGIT_CMD = ROOT / "build" / "mingit_tmp" / "cmd" / "git.exe"
APP_EXEC = "Teahouse.exe" if ON_WINDOWS else "Teahouse"   # PyInstaller 产物可执行名
APP_EXEC_PATH = "Teahouse.exe" if ON_WINDOWS else "Teahouse"
FRONTEND = ROOT / "teahouse-frontend"
FRONTEND_DIST = FRONTEND / "dist"
SPEC = ROOT / "teahouse.spec"
PYPROJECT = ROOT / "pyproject.toml"
OUT = ROOT / "dist" / "Teahouse"
DIST_DIR = ROOT / "dist"

# onedir 产物里不进 zip 的运行时生成物（首启自动生成，发布包不预置）
# dist 现在是运行时自愈产物，不直接发布——只发布 dist.zip + dist.hash
# git/ 仅 Windows 引入（Linux 靠系统 git，见 teahouse.spec），故 EXCLUDE_ZIP 恒有 git/
EXCLUDE_ZIP = {"teahouse.yaml", "data", "boot.pid", "boot_out.txt", "boot_err.txt", "dist", "git"}

# 前端自愈安装源（覆盖式更新，代替过去的解压态 dist/ 目录）
DIST_ZIP_NAME = "dist.zip"
DIST_HASH_NAME = "dist.hash"

# Windows 交付要素：exe + _internal + 捆绑 MinGit + 前端双件
# Linux 交付要素：可执行 + _internal + 前端双件（无捆绑 git，靠系统 git）
REQUIRED_PIECES = [
    (APP_EXEC, APP_EXEC_PATH),
    ("_internal", "_internal"),
    ("dist.zip", "dist.zip"),
    ("dist.hash", "dist.hash"),
]
if ON_WINDOWS:
    REQUIRED_PIECES.insert(2, ("git/cmd/git.exe", str(Path("git") / "cmd" / "git.exe")))


def _log(msg: str) -> None:
    print(msg)


def _read_version() -> str:
    """版本单一来源：pyproject.toml 的 version（后端也是它）。

    发布命名约定：版本号本身/**包名**/**release 标题**一律「不准带 v」前缀
    （如 ``1.02`` → ``Teahouse-1.02-Windows.zip`` / 标题 ``Teahouse 1.02``）。
    只有 Git tag 带 ``v``（``v1.02``）。此处强制剥离误写的 ``v``/``V`` 前缀并
    校验格式，任何 ``v1.02`` 式写法都会被归一到 ``1.02``，保证产物命名干净。
    """
    ver = "0.0.0"
    try:
        text = PYPROJECT.read_text(encoding="utf-8")
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        if m:
            ver = m.group(1).strip().lstrip("vV")
    except OSError:
        pass
    if not re.fullmatch(r"[0-9][0-9A-Za-z.\-_]*", ver):
        raise SystemExit(
            f"ERROR: 非法版本号 `{ver}`（来自 pyproject.toml）。"
            "版本号须以数字开头、不含空格；且发布命名不准带 v 前缀（写成 v1.02 也会被剥掉）。"
        )
    return ver


def _run(cmd: list[str], cwd: Path) -> int:
    """Run a command and return its exit code, streaming output.

    On Windows, resolve .cmd/.bat shims (pnpm) via cmd /c since subprocess
    cannot CreateProcess them directly. Absolute exe paths pass through."""
    argv = list(cmd)
    exe = shutil.which(argv[0])
    if exe:
        argv[0] = exe
    if os.name == "nt" and argv[0].lower().endswith((".cmd", ".bat")):
        argv = [os.environ.get("COMSPEC", "cmd.exe"), "/c", *argv]
    _log("    $ " + " ".join(argv))
    proc = subprocess.run(argv, cwd=str(cwd))
    return proc.returncode


def hash_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            blk = f.read(chunk)
            if not blk:
                break
            h.update(blk)
    return h.hexdigest()


def hash_dir(root: Path) -> str | None:
    """对整个目录树算 sha256（相对路径 + 内容，排序确定性）。必须与运行时
    frontend_install._hash_dir 完全一致，否则校验对不上。"""
    if not root.is_dir():
        return None
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(root)
        h.update(rel.as_posix().encode("utf-8"))
        h.update(b"\x00")
        with p.open("rb") as f:
            while True:
                blk = f.read(1 << 20)
                if not blk:
                    break
                h.update(blk)
        h.update(b"\x00")
    return h.hexdigest()


def _zip_dist(src_dist: Path, zip_path: Path) -> bool:
    """把 src_dist 打包成 zip_path，顶层目录应为 dist/（与运行时解压定位一致）。"""
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    _log(f"  packing {zip_path.name} ...")
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for entry in sorted(src_dist.rglob("*")):
                if entry.is_file():
                    rel = entry.relative_to(src_dist)
                    zf.write(entry, f"dist/{rel.as_posix()}")
    except OSError as e:
        _log(f"  ERROR: failed to write {zip_path}: {e}")
        return False
    size_mb = zip_path.stat().st_size / 1024 / 1024
    _log(f"  wrote {zip_path.name} ({size_mb:.1f} MB)")
    return True


def step_check() -> bool:
    _log("[check] Verifying prerequisites...")
    ok = True
    if not PYTHON.exists():
        _log(f"  ERROR: venv python not found at {PYTHON}")
        ok = False
    if not PYINSTALLER.exists():
        _log(f"  ERROR: pyinstaller not installed in venv ({PYINSTALLER})")
        ok = False
    if shutil.which("pnpm") is None:
        _log("  ERROR: pnpm not found on PATH. Install Node + pnpm first.")
        ok = False
    if ON_WINDOWS and not MINGIT_CMD.exists():
        _log(f"  ERROR: bundled MinGit not found at {MINGIT_CMD}")
        _log("         Unpack a MinGit release zip into build/mingit_tmp first.")
        ok = False
    if not ON_WINDOWS and shutil.which("git") is None:
        _log("  ERROR: system git not found on PATH. Linux 包靠系统 git 支撑实例版本控制。")
        ok = False
    if ok:
        tail = "bundled MinGit" if ON_WINDOWS else "system git"
        _log(f"  prerequisites OK ({tail})")
    return ok


def step_frontend() -> bool:
    _log("[frontend] Building frontend (pnpm build)...")
    if not (FRONTEND / "package.json").exists():
        _log(f"  ERROR: no frontend at {FRONTEND}")
        return False
    rc = _run(["pnpm", "build"], cwd=FRONTEND)
    if rc != 0:
        _log("  ERROR: frontend build failed")
        return False
    _log(f"  frontend built at {FRONTEND_DIST}")
    return True


def step_assets() -> bool:
    """把前端 dist/ 算 hash + 压成 dist.zip + 写 dist.hash，放进交付目录。

    顺序严格：先算 dir hash → 再打 zip（内容锁定同源）→ 再写 dist.hash（含该
    zip 的 zip hash + 该目录的 dir hash）。任一失败即停，不产生半成品。
    """
    _log("[assets] Hashing + compressing frontend (dist.zip + dist.hash)...")
    if not FRONTEND_DIST.is_dir():
        _log(f"  ERROR: frontend not built at {FRONTEND_DIST} — run --frontend first.")
        return False
    if not OUT.exists():
        _log(f"  ERROR: {OUT} does not exist — run --backend first.")
        return False

    dir_hash = hash_dir(FRONTEND_DIST)
    zip_path = OUT / DIST_ZIP_NAME
    if not _zip_dist(FRONTEND_DIST, zip_path):
        return False
    zip_hash = hash_file(zip_path)

    # dist.zip 内部解压出的目录树必须能复核出 dir_hash —— 打 zip 用的就是
    # 同一个 FRONTEND_DIST，天然同源；这里把 zip 解压复核一次，防打包错位。
    import tempfile as _tf
    with _tf.TemporaryDirectory() as td:
        inner = Path(td) / "dist"
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(td)
        if hash_dir(inner) != dir_hash:
            _log("  ERROR: dist.zip 内部校验不符（打包错位）")
            return False

    payload = {"zip": zip_hash, "dir": dir_hash}
    hash_path = OUT / DIST_HASH_NAME
    hash_path.write_text(json.dumps(payload), encoding="utf-8")
    _log(f"  wrote {DIST_HASH_NAME}: zip={zip_hash[:12]}.. dir={dir_hash[:12]}..")
    return True


def step_backend() -> bool:
    _log("[backend] Running PyInstaller (backend + resources)...")
    if not SPEC.exists():
        _log(f"  ERROR: spec not found at {SPEC}")
        return False
    rc = _run([str(PYINSTALLER), "--clean", "--noconfirm", str(SPEC)], cwd=ROOT)
    if rc != 0:
        _log("  ERROR: PyInstaller build failed")
        return False
    return True


def step_verify() -> bool:
    _log("[verify] Checking release output...")
    missing = [label for label, rel in REQUIRED_PIECES if not (OUT / rel).exists()]
    if missing:
        _log(f"  ERROR: deliverable incomplete at {OUT}. Missing: {', '.join(missing)}")
        return False
    # 额外：dist.hash 的两枚纯 hash 必须与当前交付的 dist.zip 自洽
    try:
        req = json.loads((OUT / DIST_HASH_NAME).read_text(encoding="utf-8"))
        calc = hash_file(OUT / DIST_ZIP_NAME)
        if req.get("zip") != calc:
            _log(f"  ERROR: dist.hash 的 zip hash 与当前 dist.zip 不符（dist.hash 过期/错位）")
            return False
    except (OSError, json.JSONDecodeError) as e:
        _log(f"  ERROR: 无法读取/解析 dist.hash: {e}")
        return False
    _log(f"  all pieces present at {OUT}")
    return True


def _zip_one(target: Path, *, exclude: set[str]) -> bool:
    """Zip the onedir deliverable, skipping the ``exclude`` top-level entries."""
    name = target.name
    _log(f"  packing {name} ...")
    try:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for entry in sorted(OUT.rglob("*")):
                rel = entry.relative_to(OUT)
                top = rel.parts[0]
                if top in exclude:
                    continue
                zf.write(entry, f"Teahouse/{rel.as_posix()}")
    except OSError as e:
        _log(f"  ERROR: failed to write {name}: {e}")
        return False
    size_mb = target.stat().st_size / 1024 / 1024
    _log(f"  wrote {name} ({size_mb:.1f} MB)")
    return True


def _tar_gz_one(target: Path) -> bool:
    """仅 Linux：把 onedir 交付物打成一个 tar.gz（含 Teahouse + _internal + dist.zip+dist.hash）。"""
    name = target.name
    _log(f"  packing {name} ...")
    try:
        import tarfile
        with tarfile.open(target, "w:gz") as tf:
            for entry in sorted(OUT.rglob("*")):
                rel = entry.relative_to(OUT)
                if rel.parts[0] in EXCLUDE_ZIP:
                    continue
                tf.add(entry, arcname=f"Teahouse/{rel.as_posix()}")
    except OSError as e:
        _log(f"  ERROR: failed to write {name}: {e}")
        return False
    size_mb = target.stat().st_size / 1024 / 1024
    _log(f"  wrote {name} ({size_mb:.1f} MB)")
    return True


def step_zip() -> bool:
    ver = _read_version()
    _log(f"[zip] Packing deliverable (version {ver})...")
    if not OUT.exists():
        _log(f"  ERROR: {OUT} does not exist — run --backend (and --frontend) first.")
        return False
    DIST_DIR.mkdir(exist_ok=True)
    if ON_WINDOWS:
        # 双包：with-git（新用户）+ 无 git（更新包）
        no_git = EXCLUDE_ZIP | {"git"}
        with_git = {e for e in EXCLUDE_ZIP if e != "git"}
        full = DIST_DIR / f"Teahouse-{ver}-Windows-with-git.zip"
        lite = DIST_DIR / f"Teahouse-{ver}-Windows.zip"
        for p in (full, lite):
            p.unlink(missing_ok=True)
        if not _zip_one(full, exclude=with_git):
            return False
        if not _zip_one(lite, exclude=no_git):
            return False
    else:
        # Linux：单包 tar.gz，无捆绑 git（靠系统 git），按架构命名
        pkg = DIST_DIR / f"Teahouse-{ver}-Linux-{LINUX_ARCH}.tar.gz"
        pkg.unlink(missing_ok=True)
        if not _tar_gz_one(pkg):
            return False
    return True


def main() -> int:
    steps = ["check", "frontend", "backend", "assets", "verify", "zip"]
    ap = argparse.ArgumentParser(description="Teahouse idempotent release build")
    for name in steps:
        ap.add_argument(f"--{name}", action="store_true",
                        help=f"run the {name} step only")
    args = ap.parse_args()

    # No --flag given -> run every step.
    selected = [name for name in steps if getattr(args, name)]
    if not selected:
        selected = steps
    _log(f"Running steps: {', '.join(selected)}")

    ordered = [name for name in steps if name in selected]
    for name in ordered:
        ok = {
            "check": step_check,
            "frontend": step_frontend,
            "backend": step_backend,
            "assets": step_assets,
            "verify": step_verify,
            "zip": step_zip,
        }[name]()
        if not ok:
            _log(f"\nBUILD FAILED at step '{name}'")
            return 1

    _log("")
    _log("============================================================================")
    _log(f" BUILD OK. Deliverable:  dist/Teahouse ({'Windows' if ON_WINDOWS else 'Linux'})")
    if ON_WINDOWS:
        _log(" zips: dist/Teahouse-<ver>-Windows-with-git.zip  (new users, incl. bundled git)")
        _log("       dist/Teahouse-<ver>-Windows.zip           (update package, no git/)")
    else:
        _log(f" pkg : dist/Teahouse-<ver>-Linux-{LINUX_ARCH}.tar.gz  (no bundled git; uses system git)")
    _log(" The release no longer ships the unpacked dist/ directory — it ships")
    _log(" dist.zip + dist.hash; the runtime unpacks/self-heals dist/ on launch.")
    _log(" teahouse.yaml and data/ are auto-generated on first run.")
    _log("============================================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
