# -*- mode: python ; coding: utf-8 -*-
"""Teahouse 打包 spec — PyInstaller onedir (exe + 文件，便携绿色布局).

产物目录（等于一个独立的 Teahouse/ 便携文件夹）:
    dist/<name>/
      Teahouse.exe         双 击入口
      _internal/teahouse/  Python 程序 + 只读资源
        ...                 (collect_data_files 保前缀，Path(__file__) 相对命中)
      dist.hash + dist.zip  前端自愈安装源 (运行时校验解压出 dist/，见 frontend_install.py)
      git/                  捆绑 MinGit (main() 把 git/cmd prepend 进 PATH)
      teahouse.yaml         首次运行生成 (config._project_root 冻结态返回 exe 目录)
      data/                 用户实例库 (workspace_base 相对锚定 exe 目录)
"""
import os
import shutil
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

# SPECPATH = spec 文件所在目录（本项目根 w:/teahouse）
PROJECT_ROOT = Path(SPECPATH)
MINGIT_DIR = PROJECT_ROOT / "build" / "mingit_tmp"

# 1) 包内只读资源：保留 teahouse/... 前缀，落到 _internal/teahouse/...
#    tools.json / director-system/ / migrations/ / prototypes/ 均按源码相对
#    位置进包，Path(__file__) 相对解析（tools.py/config.py/app.py 等）继续成立。
#    注意：frontend_install.py 是本模块，随源码进包，不额外 collect。
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
    icon=str(PROJECT_ROOT / "build" / "app.ico"),  # exe 图标，由 public/icon-512.png 转多尺寸 ico
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

# 2) 捆绑 MinGit → <outdir>/git（仅 Windows；Linux 靠系统 git，见 app.main() 的
#    回退分支）。前端 dist 不再由 spec 拷贝——改为 release 带 dist.zip+dist.hash，
#    运行时 frontend_install 校验解压出 dist/）
out = Path(coll.name)  # COLL 产物根：dist/Teahouse/
if os.name == "nt" and MINGIT_DIR.is_dir():
    shutil.copytree(MINGIT_DIR, out / "git", dirs_exist_ok=True)
    print(f"[spec] copied MinGit -> {out / 'git'}")
else:
    print(f"[spec] {'Linux 不捆绑 MinGit，Linux 包靠系统 git' if os.name != 'nt' else f'WARN MinGit 未解压到 {MINGIT_DIR}，release 将缺 git/'}")
