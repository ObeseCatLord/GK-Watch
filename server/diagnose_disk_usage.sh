#!/bin/bash

echo "=== GK Watch Disk Usage Diagnostic v2 ==="
echo "Date: $(date)"
echo "Run Location: $(pwd)"

# Attempt to find Project Root (assuming script is in server/ or root)
# If we are in server/data, go up 2 levels. If in server, go up 1.
if [[ "$(pwd)" == */server/data ]]; then
    PROJECT_ROOT="$(dirname "$(dirname "$(pwd)")")"
    SERVER_DIR="$(dirname "$(pwd)")"
elif [[ "$(pwd)" == */server ]]; then
    PROJECT_ROOT="$(dirname "$(pwd)")"
    SERVER_DIR="$(pwd)"
else
    PROJECT_ROOT="$(pwd)"
    SERVER_DIR="$(pwd)/server"
fi

echo "Detected Project Root: $PROJECT_ROOT"
echo "Detected Server Dir: $SERVER_DIR"
echo ""

# 1. Check Project Directory Size
echo "--- Project Directory Size ---"
if [ -d "$PROJECT_ROOT" ]; then
    du -sh "$PROJECT_ROOT"
    echo "Top 20 Largest Files in Project:"
    find "$PROJECT_ROOT" -type f -exec du -h {} + 2>/dev/null | sort -rh | head -n 20
else
    echo "Project root not accessible."
fi
echo ""

# 2. Check Specific Debug dumps
echo "--- check for Debug Files ---"
ls -lh "$SERVER_DIR/taobao_debug.html" 2>/dev/null || echo "taobao_debug.html not found"
ls -lh "$SERVER_DIR/taobao_debug.png" 2>/dev/null || echo "taobao_debug.png not found"
echo ""

# 3. Check ~/.cache (Chrome/Puppeteer downloads)
echo "--- Cache Directory (~/.cache) ---"
if [ -d "$HOME/.cache" ]; then
    du -sh "$HOME/.cache"
    echo "Top 10 Largest Cache Dirs:"
    du -h "$HOME/.cache" -d 1 2>/dev/null | sort -rh | head -n 10
fi
echo ""

# 4. Check /tmp again (System wide)
echo "--- Temporary Files (/tmp) ---"
# Check for any puppeteer/chrome related dirs regardless of user
echo "Puppeteer/Chrome related in /tmp:"
find /tmp -maxdepth 1 -name "*puppeteer*" -o -name "*chrome*" -o -name "*chromium*" 2>/dev/null | xargs du -sh 2>/dev/null | head -n 10
echo ""

# 5. Check PM2 Logs again
echo "--- PM2 Logs ---"
if [ -d "$HOME/.pm2/logs" ]; then
    du -sh "$HOME/.pm2/logs"
    ls -lh "$HOME/.pm2/logs" | sort -rh | head -n 5
fi

# 6. Check for Core Dumps anywhere in Home
echo "--- Core Dumps (in Home) ---"
find "$HOME" -maxdepth 3 -name "core" -o -name "core.*" -type f -ls 2>/dev/null | head -n 10
echo ""

# 7. Check Snap Private Tmp (Common Chromium Snap Issue)
echo "--- Snap Private Tmp (/tmp/snap-private-tmp) ---"
if [ -d "/tmp/snap-private-tmp" ]; then
    echo "Size of /tmp/snap-private-tmp (requires sudo for accuracy):"
    sudo du -sh /tmp/snap-private-tmp 2>/dev/null || echo "Unable to read size (Permission Denied). Try running with sudo."
    echo "Detailed breakdown (requires sudo):"
    sudo du -h -d 1 /tmp/snap-private-tmp 2>/dev/null | sort -hr | head -n 10
else
    echo "/tmp/snap-private-tmp not found."
fi
echo ""

echo "=== End of Diagnostic ==="
