@echo off
cd /d "%~dp0"
call .venv\Scripts\activate
set TEAHOUSE_SERVER_PORT=8890
python -m teahouse.app --reload
pause
