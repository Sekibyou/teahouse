@echo off
cd /d "%~dp0teahouse-frontend"
call pnpm dev --port 5173
pause
