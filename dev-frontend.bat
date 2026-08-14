@echo off
cd /d "%~dp0teahouse-frontend"
set VITE_PROXY_TARGET=http://127.0.0.1:8890
call pnpm dev --port 5173
pause
