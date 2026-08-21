@echo off
setlocal
REM  Teahouse release build — thin launcher for build/build_release.py.
REM  All logic (idempotent, step-selective) lives in the python script; this
REM  bat only picks the venv python, forwards args, and keeps the window open.
REM
REM  Usage:  build\build_release.bat [--check] [--frontend] [--backend] [--verify]
REM  No args = run every step.

set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
    echo ERROR: venv python not found at %PYTHON%
    echo        Create it:  python -m venv .venv
    pause
    exit /b 1
)

"%PYTHON%" "%~dp0build_release.py" %*
set "RC=%ERRORLEVEL%"
echo.
echo Exit code: %RC%
pause
exit /b %RC%
