#!/bin/bash
# GK Watcher Deploy Script (MacOS Version)
# Checks and installs dependencies via Homebrew before starting the application

set -euo pipefail
umask 077

echo "🚀 GK Watcher Deployment Setup (MacOS)"
echo "===================================="

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Check for Homebrew
if ! command -v brew &> /dev/null; then
    echo "❌ Homebrew is not installed."
    echo "   Please install Homebrew first: https://brew.sh/"
    exit 1
fi
echo "✅ Homebrew found."

# 2. Check/Install Git
if ! command -v git &> /dev/null; then
    echo "⚙️  Git not found. Installing via Homebrew..."
    brew install git
else
    echo "✅ Git found."
fi

# 3. Check/Install Node.js
# Strategy: Check for 'node'. If missing, check for 'nvm'.
# If 'nvm' hints found, warn user. If no nvm, install via brew.

if ! command -v node &> /dev/null; then
    echo "⚙️  Node.js not found in PATH."
    
    # Check for NVM directory as a hint that NVM might be installed
    if [ -d "$HOME/.nvm" ]; then
        echo "⚠️  It looks like NVM is installed ($HOME/.nvm exists)."
        echo "   Please run 'nvm install 20' and 'nvm use 20' before running this script,"
        echo "   or ensure your shell is configured to load NVM."
        exit 1
    else
        echo "   No NVM detected. Installing Node.js via Homebrew..."
        brew install node
    fi
else
    echo "✅ Node.js $(node -v) found."
    
fi

# 4. Check/Install NPM (usually comes with node)
if ! command -v npm &> /dev/null; then
    echo "⚙️  npm not found. Installing node should have installed npm."
    echo "   Attempting to fix by reinstalling node..."
    brew reinstall node
fi

# Final Check
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "❌ Failed to install/detect Node.js/npm. Please install manually."
    exit 1
fi

if ! node -e "const [a,b,c]=process.versions.node.split('.').map(Number);const ok=(a===20&&(b>18||(b===18&&c>=1)))||(a>20&&a<27);process.exit(ok?0:1)"; then
    echo "❌ Node.js 20.18.1 through 26.x is required. Found $(node -v)."
    exit 1
fi

if [ ! -x "${PUPPETEER_EXECUTABLE_PATH:-}" ] \
    && [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] \
    && [ ! -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
    echo "⚙️  Chrome not found. Installing via Homebrew..."
    brew install --cask google-chrome
fi

# Install server dependencies
echo ""
echo "📦 Installing server dependencies..."
cd server
npm ci
npm audit --omit=dev --audit-level=high
npm test -- --runInBand
cd ..

# Install client dependencies
echo ""
echo "📦 Installing client dependencies..."
cd client
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm test -- --run

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
echo "===================================="
echo "✅ MacOS Deployment setup complete!"
echo ""
echo "To start the application, run:"
echo "  ./start_osx.sh"
