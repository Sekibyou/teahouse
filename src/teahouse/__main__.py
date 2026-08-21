"""打包入口 — `python -m teahouse` / PyInstaller 均指向此处。"""
# 必须先做前端自愈再导 app：app 模块导入即挂载静态目录，dist/ 必须在它之前就位。
from teahouse.frontend_install import ensure_frontend
from teahouse.app import main

if __name__ == "__main__":
    if not ensure_frontend():
        raise SystemExit(1)
    main()
