#!/usr/bin/env bash
set -euo pipefail

# Teahouse — Dev mode: backend (hot-reload, no dist) + Vite dev server.
# Frontend at http://<LAN-IP>:5173 proxies /api /v1 /events to 127.0.0.1:8888.
# Usage: ./run-server-dev.sh   (Ctrl+C stops both)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

cleanup() {
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev] Starting backend (--dev: reload, no dist) on :8888..."
source "$SCRIPT_DIR/.venv/bin/activate"
python -m teahouse.app --dev &
BACKEND_PID=$!

echo "[dev] Starting Vite dev server on :5173..."
(
    cd "$SCRIPT_DIR/teahouse-frontend"
    pnpm dev
) &
FRONTEND_PID=$!

wait
