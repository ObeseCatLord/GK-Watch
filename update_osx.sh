#!/bin/bash
# GK Watcher Update Script (MacOS Version)
# Pulls latest code and rebuilds the client

set -euo pipefail
umask 077

echo "🔄 Updating GK Watcher (MacOS)..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull --ff-only

# Rebuild client
echo "🔨 Building client..."
cd client
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm test -- --run
npm run build
cd ..

# Install server dependencies
echo "📦 Installing server dependencies..."
cd server
npm ci
npm audit --omit=dev --audit-level=high
npm test -- --runInBand
cd ..

echo "✅ Update complete!"
