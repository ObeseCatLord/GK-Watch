#!/bin/bash
# GK Watcher Deploy Script (MacOS Version)
# Checks and installs dependencies via Homebrew before starting the application

set -e

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
        echo "   Please run 'nvm install 18' (or newer) and 'nvm use 18' before running this script,"
        echo "   or ensure your shell is configured to load NVM."
        exit 1
    else
        echo "   No NVM detected. Installing Node.js via Homebrew..."
        brew install node
    fi
else
    echo "✅ Node.js $(node -v) found."
    
    # Version warning
    NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [ "$NODE_VERSION" -lt 18 ]; then
         echo "⚠️  Warning: Node.js version is $NODE_VERSION. Recommended 18+."
    fi
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
echo "===================================="
echo "✅ MacOS Deployment setup complete!"
echo ""
echo "To start the application, run:"
echo "  ./start_osx.sh"
