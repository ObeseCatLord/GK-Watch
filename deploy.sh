#!/bin/bash
# GK Watcher Deploy Script (Multi-Distro)
# Checks and installs dependencies before starting the application

set -e

echo "🚀 GK Watcher Deployment Setup"
echo "================================"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Helper function to detect package manager and install
install_dependency() {
    local PKG_NAME=$1
    local CMD_NAME=$2 # Optional: if command differs from package name (e.g., git vs git-all)
    
    if command -v "$CMD_NAME" &> /dev/null || command -v "$PKG_NAME" &> /dev/null; then
        echo "✅ $PKG_NAME is already installed."
        return 0
    fi

    echo "⚙️  $PKG_NAME not found. Attempting install..."

    if command -v apt-get &> /dev/null; then
        echo "   Detected APT (Debian/Ubuntu). Using sudo..."
        sudo apt-get update
        sudo apt-get install -y "$PKG_NAME"
    elif command -v dnf &> /dev/null; then
        echo "   Detected DNF (Fedora/RHEL). Using sudo..."
        sudo dnf install -y "$PKG_NAME"
    elif command -v pacman &> /dev/null; then
        echo "   Detected Pacman (Arch). Using sudo..."
        sudo pacman -S --noconfirm "$PKG_NAME"
    elif command -v zypper &> /dev/null; then
        echo "   Detected Zypper (openSUSE). Using sudo..."
        sudo zypper install -y "$PKG_NAME"
    elif command -v apk &> /dev/null; then
        echo "   Detected APK (Alpine). Using sudo..."
        sudo apk add "$PKG_NAME"
    else
        echo "❌ Could not detect package manager. Please manually install '$PKG_NAME'."
        return 1
    fi
}

# 1. Check/Install Git
install_dependency git git

# 2. Check/Install Node.js
# Distros name it 'nodejs', 'npm' usually pulls it in. 
# Some need 'nodejs' and 'npm' separate.
if ! command -v node &> /dev/null; then
    echo "⚙️  Node.js not found. Installing..."
    install_dependency nodejs node
    
    # Check version
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
        if [ "$NODE_VERSION" -lt 18 ]; then
             echo "⚠️  Installed Node.js version is too old ($NODE_VERSION). Require 18+."
             echo "   Attempting to upgrade via n/nvm is tricky here. Please upgrade Node.js manually."
        fi
    fi
else
    echo "✅ Node.js $(node -v) found"
fi

# 3. Check/Install NPM
if ! command -v npm &> /dev/null; then
    echo "⚙️  npm not found. Installing..."
    install_dependency npm
fi

# Final Check
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "❌ Failed to install Node.js/npm. Please install manually."
    exit 1
fi

# Install server dependencies
echo ""
echo "📦 Installing server dependencies..."
cd server
if ! npm install; then
    echo "⚠️  npm install failed. Retrying with PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install
fi
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
