#!/bin/bash

set -euo pipefail
umask 077

# GK Watcher Launch Script (macOS Version)

cd "$(dirname "$0")"

echo "🚀 Starting GK Watcher (MacOS)..."

unset TMPDIR

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -z "$FRONTEND_PID" ] || kill "$FRONTEND_PID" 2>/dev/null || true
    [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
}

trap cleanup EXIT SIGINT SIGTERM

if [ -f "client/dist/index.html" ]; then
    echo "Client build found. Starting in production mode..."
    cd server
    NODE_ENV=production node server.js &
    BACKEND_PID=$!
    cd ..

    sleep 2
    echo "GK Watcher is running at http://localhost:3000"
    echo "Press Ctrl+C to stop the server"
    wait "$BACKEND_PID"
else
    echo "Client build not found. Starting in development mode..."
    cd server
    node server.js &
    BACKEND_PID=$!
    cd ..

    sleep 2
    cd client
    npm run dev &
    FRONTEND_PID=$!
    cd ..

    echo "Backend:  http://localhost:3000"
    echo "Frontend: http://localhost:5173"
    echo "Press Ctrl+C to stop both servers"
    while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
        sleep 1
    done
fi
