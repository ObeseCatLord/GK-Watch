#!/bin/bash
# GK Watcher Deploy Script (Multi-Distro)
# Checks and installs dependencies before starting the application

set -euo pipefail
umask 077

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
    
else
    echo "✅ Node.js $(node -v) found"
fi

# 3. Check/Install NPM
if ! command -v npm &> /dev/null; then
    echo "⚙️  npm not found. Installing..."
    install_dependency npm
fi

# 4. Browser scrapers use the host browser so installs do not depend on large,
# failure-prone Puppeteer downloads.
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
    install_dependency chromium chromium
fi

# Final Check
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "❌ Failed to install Node.js/npm. Please install manually."
    exit 1
fi

if ! node -e "const [a,b,c]=process.versions.node.split('.').map(Number);const ok=(a===20&&(b>18||(b===18&&c>=1)))||(a>20&&a<27);process.exit(ok?0:1)"; then
    echo "❌ Node.js 20.18.1 through 26.x is required. Found $(node -v)."
    exit 1
fi

# Install server dependencies
echo ""
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
install -d -m 700 server/data

echo ""
echo "================================"
echo "✅ Deployment setup complete!"
echo ""
echo "To start the application, run:"
echo "  ./start.sh"
