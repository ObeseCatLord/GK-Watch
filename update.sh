#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ "${1:-}" = "--check" ]; then
    exec node scripts/gkwatch-tasks.mjs doctor --skip-browser
fi

if [ "${GKWATCH_UPDATE_AFTER_PULL:-0}" != "1" ]; then
    if ! command -v git >/dev/null 2>&1; then
        echo "[ERROR] Git is required to download updates." >&2
        exit 1
    fi
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "[ERROR] This copy is not a Git checkout and cannot download updates." >&2
        echo "Clone https://github.com/ObeseCatLord/GK-Watch.git to enable in-place updates." >&2
        exit 1
    fi

    echo "Pulling latest changes..."
    git pull --ff-only

    # Run the newly pulled script instead of continuing stale update logic.
    export GKWATCH_UPDATE_AFTER_PULL=1
    exec "$SCRIPT_DIR/update.sh" "$@"
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed or is not available in PATH." >&2
    echo "Run ./deploy.sh first." >&2
    exit 1
fi

node scripts/gkwatch-tasks.mjs setup
echo "Update complete. Restart GK Watcher to run the new version."
