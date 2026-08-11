@echo off
REM Production/LAN deploy: backend serves built frontend.
REM Phone hits http://192.168.10.88:8888 (single port, same origin).
REM Usage:
REM   run-server.bat         Start with current dist (skip build)
REM   run-server.bat --build Rebuild frontend first, then start
cd /d "%~dp0"

if /i "%~1"=="--build" (
    echo [run-server] Building frontend...
    cd /d "%~dp0teahouse-frontend"
    call pnpm build
    if errorlevel 1 (
        echo [run-server] Frontend build failed, aborting.
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

echo [run-server] Starting backend (port 8888, serving dist)...
call .venv\Scripts\activate
python -m teahouse.app
pause
