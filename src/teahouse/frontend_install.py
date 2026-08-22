"""前端 dist 自愈安装 — 双 hash 校验 + 安全替换 + 更新引导。

设计背景：release 不再把解压态的 `dist/` 发布出去，而是发布 `dist/` 的两个
覆盖式文件 —— 压缩态 `dist.zip` + 状态文件 `dist.hash`。exe 同目录的 `dist/`
是运行时产物，由本模块按 hash 校验后从 `dist.zip` 解压创建/修复，因此：

- release = Teahouse.exe + _internal/ + dist.zip + dist.hash（+ 可选 git/），全是覆盖式更新
- `dist/` 不进 release、不参与 diff，彻底消除"v1.00 与 v1.01 前端文件不同名、
  覆盖更新叠两份"的老问题
- 磁盘上现存 `dist/` 若与 `dist.hash` 记载的 dir hash 一致（前端没变），直接复用，
  零成本；不一致才删了解压新的

必须在 `from teahouse.app import main` **之前**调用（app 导入即挂载静态目录），
故从 `__main__.py` 顶层执行。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import webbrowser
import zipfile
from pathlib import Path

_RELEASE_URL = "https://github.com/Sekibyou/teahouse/releases"
# 独立挂载的前端 asset 命名（build_release.py 发布时上传）：frontend-dist-<ver>.zip
# 与 release 版本号对齐（Termux 跑 release 源码包，源码版本 == release tag）。
_FRONTEND_ASSET_TEMPLATE = "{version}/frontend-dist-{version}.zip"


def _exe_dir() -> Path:
    return Path(sys.executable).resolve().parent


def _hash_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            blk = f.read(chunk)
            if not blk:
                break
            h.update(blk)
    return h.hexdigest()


def _source_root() -> Path:
    """源码运行时（非 frozen）的项目根 = <repo>。frontend_install 位于
    src/teahouse/frontend_install.py，故 parents[2] 为仓库根（与 app.py 的
    _frontend_dist 定位一致）。"""
    return Path(__file__).resolve().parents[2]


def _read_version() -> str | None:
    """版本单源 = pyproject.toml 的 version。源码态用它拼 release asset 名。"""
    try:
        text = Path(_source_root() / "pyproject.toml").read_text(encoding="utf-8")
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    except OSError:
        return None
    return None


def _download(url: str, dest: Path) -> bool:
    """下载 url 到 dest，返回是否成功。带 10s 超时，失败绝不抛异常。"""
    if dest.exists():
        dest.unlink()
    try:
        with urllib.request.urlopen(url, timeout=30) as resp, open(dest, "wb") as f:
            while chunk := resp.read(1 << 20):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"[teahouse] 下载失败: {url} ({e})")
        return False


def _hash_dir(root: Path) -> str | None:
    """对整个目录树算 sha256：所有文件的相对路径 + 内容，按路径排序保证确定性。

    返回 None 表示目录不存在（视为"缺失"）。
    """
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


def _load_hash(req: Path) -> dict | None:
    try:
        data = json.loads(req.read_text(encoding="utf-8"))
    except OSError:
        return None
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return {"zip": data.get("zip"), "dir": data.get("dir")}


def _guide(reason: str) -> None:
    print()
    print("=" * 72)
    print(f"[teahouse] 前端 dist 校验未通过：{reason}")
    print(f"[teahouse] Teahouse.exe / _internal/ 已就绪，但 dist 无法自愈。")
    print(f"[teahouse] 为确保前端与后端匹配，请前往最新版本页面重新下载，")
    print(f"[teahouse] 再整目录覆盖更新：")
    print(f"[teahouse]   {_RELEASE_URL}")
    print("=" * 72)
    try:
        webbrowser.open(_RELEASE_URL)
    except Exception:
        pass


def _unpack_safely(zip_path: Path, zone: Path, expected_dir_hash: str) -> bool:
    """把 zip 解压到一个全新分区目录，复核 dir hash 全符后才原子替换目标 dist。

    裸 rmtree 太冒险——若 zip 损坏/解压失败，会把用户正常运行的 dist 删除。
    此处先解到临时目录 → 对完整目录树算 hash 复核 → 全符才替换。

    注意：zip 内应含顶层 `dist/` 目录（build 侧先算 hash、后打的 zip，两者同源）。
    这里把 zip 解到临时目录后，定位到其中的 `dist/` 分区再复核。
    """
    tmp = Path(tempfile.mkdtemp(prefix="teahouse-dist-"))
    backup = zone.with_name(zone.name + ".old")
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        # 定位解压目录：可能是顶层 dist/ 本身，也可能套一层
        inner = tmp / "dist"
        if not inner.is_dir():
            # 找第一个非空目录作为分区根
            cands = [p for p in tmp.iterdir() if p.is_dir()]
            if len(cands) == 1:
                inner = cands[0]
            else:
                raise RuntimeError("dist.zip 内未找到 dist/ 顶层目录")
        actual = _hash_dir(inner)
        if actual != expected_dir_hash:
            raise RuntimeError(f"解压后校验不符: 期望 {expected_dir_hash[:12]}.. 得到 {actual[:12]}..")
        # 全符：旧 dist 先挪到备份，再原子换上新区，最后才删备份——
        # 保证任何一步失败都不丢用户的旧前端（老 dist.zip 同源、新 zip 已复核，安全）
        if zone.exists():
            shutil.rmtree(str(backup), ignore_errors=True)
            shutil.move(str(zone), str(backup))
        shutil.move(str(inner), str(zone))
        if backup.exists():
            shutil.rmtree(str(backup), ignore_errors=True)
        return True
    except Exception as e:
        print(f"[teahouse] dist 解压失败: {e}")
        if backup.exists() and backup.is_dir() and not zone.exists():
            shutil.move(str(backup), str(zone))  # 回滚，保住旧前端
        return False
    finally:
        shutil.rmtree(str(tmp), ignore_errors=True)


def _layout() -> tuple[Path, Path, Path, bool]:
    """返回 (hash_path, zip_path, dist_dir, allow_download)。

    frozen   ：dist 状态区与解压目标同在 exe 旁，zip/hash 由发布包预置，不下载
    source   ：状态区在 <repo>/.teahouse-dist/（不进 git），解压到
               <repo>/teahouse-frontend/dist（匹配 app._frontend_dist() 源码态）；
               缺件时默认去 release 下载当前版本 asset（B1：源码态默认自愈）
    """
    if getattr(sys, "frozen", False):
        exe = _exe_dir()
        return exe / "dist.hash", exe / "dist.zip", exe / "dist", False
    root = _source_root()
    state = root / ".teahouse-dist"
    return state / "dist.hash", state / "dist.zip", root / "teahouse-frontend" / "dist", True


def ensure_frontend() -> bool:
    """启动前的前端自愈。返回 True 才应继续启动。

    frozen / source 共用一套核心：读 dist.hash → 校验 dist.zip → 复用或安全解压。
    差异仅在"状态区/解压目标在哪"与"缺件时是否允许去 release 下载"：
      1. 缺有效 dist.hash → 若允许下载则尝试拉当前版本 asset，成功重建；否则引导
      2. 算磁盘 dist.zip 的 hash，≠ 记录 zipHash → 引导（dist.zip 过时/换过，不信任）
      3. zip 相符 ↓
           - 现存 dist/ dir hash == 记录 dirHash → 直接 True（前端没问题，零成本复用）
           - 否则 → dist.zip 可信，安全替换 → 返回成败
    """
    hash_path, zip_path, dist_dir, allow_download = _layout()

    req = _load_hash(hash_path)
    if req is None or not req["zip"] or not req["dir"]:
        if allow_download and _fetch_dist_asset(hash_path, zip_path):
            req = _load_hash(hash_path)
        if req is None or not req["zip"] or not req["dir"]:
            print("[teahouse] 前端更新：缺少有效 dist.hash，转入更新引导")
            _guide("缺少有效的 dist.hash（首次部署缺件或文件损坏）")
            return False
    if not zip_path.is_file():
        print("[teahouse] 前端更新：缺少 dist.zip，转入更新引导")
        _guide("缺少 dist.zip")
        return False

    cur_zip = _hash_file(zip_path)
    if cur_zip != req["zip"]:
        print("[teahouse] 前端更新：dist.zip 与 dist.hash 记载不符，转入更新引导")
        _guide("磁盘上的 dist.zip 与 dist.hash 记载不符（可能是混入过时的 dist.zip）")
        return False

    cur_dir = _hash_dir(dist_dir)
    if cur_dir == req["dir"]:
        # 前端与 zip 同源且一致，直接复用——升级后端无需动前端
        print(f"[teahouse] 前端更新：dist/ 与 dist.hash 一致，直接复用（dir={req['dir'][:12]}..）")
        return True

    print(f"[teahouse] 前端更新：dist/ 与记录不符（过时/缺失/有改动），从 dist.zip 解压重建")
    ok = _unpack_safely(zip_path, dist_dir, req["dir"])
    if ok:
        print(f"[teahouse] 前端更新：dist/ 已重建完成（dir={req['dir'][:12]}..）")
    else:
        print("[teahouse] 前端更新：解压重建失败，转入更新引导")
    return ok


def _fetch_dist_asset(hash_path: Path, zip_path: Path) -> bool:
    """源码态缺件时，从当前版本 release 拉取 frontend-dist-<ver>.zip + dist.hash。

    版本从本地 pyproject.toml 读（源码包版本 == release tag），不查 release API。
    首个 asset 下载失败/无版本号 → 返回 False 交调用方转引导。不抛异常。
    """
    ver = _read_version()
    if not ver:
        return False
    tag = ver if ver.startswith("v") else f"v{ver}"  # release tag 带 v 前缀
    base = f"{_RELEASE_URL}/download/{tag}"
    zip_url = f"{base}/frontend-dist-{ver}.zip"
    hash_url = f"{base}/dist.hash"
    hash_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[teahouse] 前端更新：未找到本地 dist，从 release 拉取 v{ver} 前端资产…")
    ok_zip = _download(zip_url, zip_path)
    ok_hash = _download(hash_url, hash_path)
    if not (ok_zip and ok_hash):
        zip_path.unlink(missing_ok=True)
        hash_path.unlink(missing_ok=True)
        return False
    return True
