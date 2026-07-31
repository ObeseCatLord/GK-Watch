#!/bin/bash
# GK Watcher Update Script
# Pulls latest code and rebuilds the client

set -euo pipefail
umask 077

echo "🔄 Updating GK Watcher..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if command -v gcc-10 >/dev/null 2>&1 && command -v g++-10 >/dev/null 2>&1; then
    export CC=gcc-10
    export CXX=g++-10
fi

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull --ff-only

# Install server dependencies
echo "📦 Installing server dependencies..."
cd server
if ! npm ci; then
    echo "⚠️  npm ci failed. Retrying with PUPPETEER_SKIP_DOWNLOAD=true..."
    PUPPETEER_SKIP_DOWNLOAD=true npm ci
fi
npm audit --omit=dev --audit-level=high
npm test -- --runInBand
cd ..

# Install client dependencies
echo "📦 Installing client dependencies..."
cd client
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm test -- --run

# Rebuild client
echo "🔨 Building client..."
npm run build
cd ..

echo "✅ Update complete!"
