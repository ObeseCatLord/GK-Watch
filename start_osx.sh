#!/bin/bash

# GK Watcher Launch Script (MacOS Version)
# This script starts both the backend server and frontend dev server

cd "$(dirname "$0")"

echo "🚀 Starting GK Watcher (MacOS)..."

# unset TMPDIR
unset TMPDIR

# Kill any existing processes on ports 3000 and 5173
echo "Cleaning up any existing processes..."
# MacOS/BSD compatible way to find and kill processes on ports
# lsof -t -i :PORT returns only PIDs
for PORT in 3000 5173 5174; do
    PIDS=$(lsof -t -i :$PORT 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "   Killing process on port $PORT (PIDs: $PIDS)..."
        kill $PIDS
    fi
done

sleep 3

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
    
    # Ensure port processes are dead
    for PORT in 3000 5173; do
        PIDS=$(lsof -t -i :$PORT 2>/dev/null)
        if [ -n "$PIDS" ]; then
            kill $PIDS
        fi
    done
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait
