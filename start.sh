#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed or is not available in PATH." >&2
    echo "Run ./deploy.sh first." >&2
    exit 1
fi

exec node scripts/gkwatch-tasks.mjs start "$@"
