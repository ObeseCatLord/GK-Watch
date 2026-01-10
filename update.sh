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

# Rebuild client
echo "🔨 Building client..."
cd client
npm install
npm run build
cd ..

echo "✅ Update complete!"
echo ""
echo "If you're using PM2, restart the backend with:"
echo "  pm2 restart gkwatch-api"
