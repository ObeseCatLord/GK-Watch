#!/bin/bash
# GK Watcher Update Script
# Pulls latest code and rebuilds the client

set -e

echo "🔄 Updating GK Watcher..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull

# Install server dependencies
echo "📦 Installing server dependencies..."
cd server
if ! npm install; then
    echo "⚠️  npm install failed. Retrying with PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install
fi
cd ..

# Install client dependencies
echo "📦 Installing client dependencies..."
cd client
npm install

# Rebuild client
echo "🔨 Building client..."
npm run build
cd ..

echo "✅ Update complete!"
