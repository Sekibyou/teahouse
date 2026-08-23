"""打包入口 — `python -m teahouse` / PyInstaller 均指向此处。"""
# 必须先做前端自愈再导 app：app 模块导入即挂载静态目录、捕获 FRONTEND_DIST
# 快照。若先导 app 再自愈，FRONTEND_DIST 会指向空的 exe/dist（源码态回退路径），
# 导致首次运行 404 "Frontend not built"。故 ensure_frontend 必须绝对领先于 app 导入。
from teahouse.frontend_install import ensure_frontend

if __name__ == "__main__":
    if not ensure_frontend():
        raise SystemExit(1)
    from teahouse.app import main

    main()
