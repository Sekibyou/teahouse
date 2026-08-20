# -*- mode: python ; coding: utf-8 -*-
"""Teahouse 打包 spec — PyInstaller onedir (exe + 文件，便携绿色布局).

产物目录（等于一个独立的 Teahouse/ 便携文件夹）:
    dist/<name>/
      Teahouse.exe         双 击入口
      _internal/teahouse/  Python 程序 + 只读资源
        ...                 (collect_data_files 保前缀，Path(__file__) 相对命中)
      dist/                 前端构建产物 (exe 同目录, app._frontend_dist 读它)
      git/                  捆绑 MinGit (main() 把 git/cmd prepend 进 PATH)
      teahouse.yaml         首次运行生成 (config._project_root 冻结态返回 exe 目录)
      data/                 用户实例库 (workspace_base 相对锚定 exe 目录)
"""
import shutil
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

# SPECPATH = spec 文件所在目录（本项目根 w:/teahouse）
PROJECT_ROOT = Path(SPECPATH)
FRONTEND_DIST = PROJECT_ROOT / "teahouse-frontend" / "dist"
MINGIT_DIR = PROJECT_ROOT / "build" / "mingit_tmp"

# 1) 包内只读资源：保留 teahouse/... 前缀，落到 _internal/teahouse/...
#    tools.json / director-system/ / migrations/ / prototypes/ 均按源码相对
#    位置进包，Path(__file__) 相对解析（tools.py/config.py/app.py 等）继续成立。
datas = collect_data_files("teahouse")

# uvicorn 经字符串 "teahouse.app:app" 运行时 import，静态不可见；把子模块一并
# hidden-import，避免 runworker/py-win 分支缺失。（日志/循环后端按需留核心即可）
hiddenimports = ["uvicorn", "uvicorn.logging", "uvicorn.loops", "uvicorn.loops.auto"]

# 排除与 teahouse 无关/增体积的试探性依赖
excludes = ["tkinter"]

a = Analysis(
    ["src/teahouse/__main__.py"],
    pathex=[str(PROJECT_ROOT), str(PROJECT_ROOT / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Teahouse",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,      # 保持控制台窗口，打印访问地址 / 首启密码
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Teahouse",
)

# 2) 前端产物 → <outdir>/dist（exe 同目录）
out = Path(coll.name)  # COLL 产物根：dist/Teahouse/
if not FRONTEND_DIST.is_dir():
    raise SystemExit(f"[spec] 前端 dist 未构建: {FRONTEND_DIST}")
shutil.copytree(FRONTEND_DIST, out / "dist", dirs_exist_ok=True)
print(f"[spec] copied frontend -> {out / 'dist'}")

# 3) 捆绑 MinGit → <outdir>/git
if MINGIT_DIR.is_dir():
    shutil.copytree(MINGIT_DIR, out / "git", dirs_exist_ok=True)
    print(f"[spec] copied MinGit -> {out / 'git'}")
else:
    print(f"[spec] WARN MinGit 未解压到 {MINGIT_DIR}，release 将缺 git/")
