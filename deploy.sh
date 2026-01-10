#!/bin/bash
# GK Watcher Deploy Script
# Checks and installs dependencies before starting the application

set -e

echo "🚀 GK Watcher Deployment Setup"
echo "================================"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check for Node.js
echo ""
echo "📋 Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo "   Please install Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ required (found: $(node -v))"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    exit 1
fi
echo "✅ npm $(npm -v)"

# Check for git
if ! command -v git &> /dev/null; then
    echo "⚠️  Git is not installed (optional for updates)"
else
    echo "✅ Git $(git --version | cut -d' ' -f3)"
fi

# Install server dependencies
echo ""
echo "📦 Installing server dependencies..."
cd server
npm install
cd ..

# Install client dependencies
echo ""
echo "📦 Installing client dependencies..."
cd client
npm install

# Build client
echo ""
echo "🔨 Building client..."
npm run build
cd ..

# Create data directory
echo ""
echo "📁 Setting up data directory..."
mkdir -p server/data

echo ""
echo "================================"
echo "✅ Deployment setup complete!"
echo ""
echo "To start the application, run:"
echo "  ./start.sh"
