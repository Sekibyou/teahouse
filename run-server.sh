#!/usr/bin/env bash
set -euo pipefail

# Teahouse — Production/LAN deploy: backend serves built frontend.
# Usage:
#   ./run-server.sh          Start with current dist (skip build)
#   ./run-server.sh --build  Rebuild frontend first, then start

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ "${1:-}" = "--build" ]; then
    echo "[run-server] Building frontend..."
    cd "$SCRIPT_DIR/teahouse-frontend"
    pnpm build
    if [ $? -ne 0 ]; then
        echo "[run-server] Frontend build failed, aborting."
        exit 1
    fi
    cd "$SCRIPT_DIR"
fi

echo "[run-server] Starting backend (port 8888, serving dist)..."
source "$SCRIPT_DIR/.venv/bin/activate"
exec python -m teahouse.app
