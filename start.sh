#!/bin/bash

# GK Watcher Launch Script
# This script starts both the backend server and frontend dev server (or production mode)

cd "$(dirname "$0")"

echo "🚀 Starting GK Watcher..."

# TMPDIR not needed as Snap is fixed
unset TMPDIR

# Kill any existing processes on ports 3000 and 5173
echo "Cleaning up any existing processes..."
fuser -k 3000/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
fuser -k 5174/tcp 2>/dev/null
sleep 3

# Check for production build
if [ -f "client/dist/index.html" ]; then
    echo "ℹ️  Client build found. Starting in PRODUCTION mode..."
    echo ""
    echo "Starting server (backend serves frontend)..."
    cd server
    node server.js &
    BACKEND_PID=$!
    cd ..

    echo ""
    echo "✅ GK Watcher is running at http://localhost:3000"
    echo ""
    echo "Press Ctrl+C to stop the server"

    # Handle cleanup on exit
    cleanup() {
        echo ""
        echo "Shutting down..."
        kill $BACKEND_PID 2>/dev/null
        fuser -k 3000/tcp 2>/dev/null
        exit 0
    }

    trap cleanup SIGINT SIGTERM

    wait
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

    # Handle cleanup on exit
    cleanup() {
        echo ""
        echo "Shutting down..."
        kill $BACKEND_PID 2>/dev/null
        kill $FRONTEND_PID 2>/dev/null
        fuser -k 3000/tcp 2>/dev/null
        fuser -k 5173/tcp 2>/dev/null
        exit 0
    }

    trap cleanup SIGINT SIGTERM

    wait
fi
