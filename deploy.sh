#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

install_linux_dependency() {
    local package_name=$1
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y "$package_name"
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y "$package_name"
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm "$package_name"
    elif command -v zypper >/dev/null 2>&1; then
        sudo zypper install -y "$package_name"
    elif command -v apk >/dev/null 2>&1; then
        sudo apk add "$package_name"
    else
        echo "[ERROR] No supported Linux package manager was found." >&2
        return 1
    fi
}

echo "GK Watcher deployment setup"

if [ "$(uname -s)" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
        echo "[ERROR] Homebrew is required. Install it from https://brew.sh/." >&2
        exit 1
    fi
    command -v git >/dev/null 2>&1 || brew install git
    command -v node >/dev/null 2>&1 || brew install node

    if [ ! -x "${PUPPETEER_EXECUTABLE_PATH:-}" ] \
        && [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] \
        && [ ! -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ] \
        && [ ! -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
        brew install --cask google-chrome
    fi
else
    command -v git >/dev/null 2>&1 || install_linux_dependency git
    command -v node >/dev/null 2>&1 || install_linux_dependency nodejs
    command -v npm >/dev/null 2>&1 || install_linux_dependency npm

    if [ ! -x "${PUPPETEER_EXECUTABLE_PATH:-}" ] \
        && ! command -v chromium >/dev/null 2>&1 \
        && ! command -v chromium-browser >/dev/null 2>&1 \
        && ! command -v google-chrome >/dev/null 2>&1 \
        && ! command -v microsoft-edge >/dev/null 2>&1 \
        && ! command -v microsoft-edge-stable >/dev/null 2>&1; then
        install_linux_dependency chromium
    fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] Node.js and npm must be available in PATH." >&2
    exit 1
fi

if command -v gcc-10 >/dev/null 2>&1 && command -v g++-10 >/dev/null 2>&1; then
    export CC=gcc-10
    export CXX=g++-10
fi

node scripts/gkwatch-tasks.mjs setup
chmod 700 server/data 2>/dev/null || true

echo "Deployment setup complete. Start with ./start.sh --production."
