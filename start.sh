#!/bin/bash

set -euo pipefail
umask 077

# GK Watcher Launch Script
# This script starts both the backend server and frontend dev server (or production mode)

cd "$(dirname "$0")"

echo "🚀 Starting GK Watcher..."

# TMPDIR not needed as Snap is fixed
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

# Check for production build
if [ -f "client/dist/index.html" ]; then
    echo "ℹ️  Client build found. Starting in PRODUCTION mode..."
    echo ""
    echo "Starting server (backend serves frontend)..."
    cd server
    NODE_ENV=production node server.js &
    BACKEND_PID=$!
    cd ..

    echo ""
    echo "✅ GK Watcher is running at http://localhost:3000"
    echo ""
    echo "Press Ctrl+C to stop the server"

    wait "$BACKEND_PID"
else
    echo "ℹ️  Client build NOT found. Starting in DEV mode..."
    echo ""

    # Start the backend server
    echo "Starting backend server..."
    cd server
    node server.js &
    BACKEND_PID=$!
    cd ..

    # Wait a moment for backend to start
    sleep 2

    # Start the frontend dev server
    echo "Starting frontend..."
    cd client
    npm run dev &
    FRONTEND_PID=$!
    cd ..

    echo ""
    echo "✅ GK Watcher is running!"
    echo "   Backend:  http://localhost:3000"
    echo "   Frontend: http://localhost:5173"
    echo ""
    echo "Press Ctrl+C to stop both servers"

    wait -n "$BACKEND_PID" "$FRONTEND_PID"
fi
