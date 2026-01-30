#!/bin/bash
# Stop script for local testing (MacOS Version)

echo "🛑 Stopping GK Watcher (Local Ports 3000 & 5173)..."

# Kill processes listening on ports using lsof (MacOS standard)
FOUND_PROCESSES=0
for PORT in 3000 5173; do
    PIDS=$(lsof -t -i :$PORT 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo "   Killing process on port $PORT (PIDs: $PIDS)..."
        kill $PIDS
        FOUND_PROCESSES=1
    fi
done

if [ $FOUND_PROCESSES -eq 0 ]; then
    # Fallback to pkill if ports weren't open but processes might be zombie
    echo "   No listening ports found. Checking process names..."
    pkill -f "node server/server.js"
    pkill -f "vite"
fi

echo "✅ Stopped."
