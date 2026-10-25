#!/usr/bin/env zsh
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/Users/keechbr/.local/node/bin:$PATH"

echo "Starting Salvage Pulse AI Backend on http://127.0.0.1:8000 ..."
cd "$ROOT_DIR/backend"
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!

echo "Starting Salvage Pulse AI Frontend on http://127.0.0.1:5173 ..."
cd "$ROOT_DIR/frontend"
npm run dev -- --host 127.0.0.1 &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true" INT TERM EXIT
wait
