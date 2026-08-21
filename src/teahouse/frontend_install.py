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
import shutil
import sys
import tempfile
import webbrowser
import zipfile
from pathlib import Path

_RELEASE_URL = "https://github.com/Sekibyou/teahouse/releases"


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


def ensure_frontend() -> bool:
    """冻结态启动前的前端自愈。返回 True 才应继续启动。

    规则：
      1. 非 frozen（源码/开发态）→ 不干预，返回 True（前端走 teahouse-frontend/dist）
      2. 读 exe 旁 dist.hash，缺 → 引导（视为缺件/损坏）
      3. 算磁盘 dist.zip 的 hash，≠ 记录 zipHash → 引导（dist.zip 过时/换过，不信任）
      4. zip 相符 ↓
           - 现存 dist/ dir hash == 记录 dirHash → 直接 True（前端没问题，零成本复用）
           - 否则 → dist.zip 可信，安全替换 → 返回成败
    """
    if not getattr(sys, "frozen", False):
        return True

    exe = _exe_dir()
    hash_path = exe / "dist.hash"
    zip_path = exe / "dist.zip"
    dist_dir = exe / "dist"

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
