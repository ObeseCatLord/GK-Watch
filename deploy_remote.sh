#!/usr/bin/env bash

set -euo pipefail
umask 077

SERVER="${GKWATCH_REMOTE_HOST:-foundry}"
KEY="${GKWATCH_REMOTE_KEY:-}"
REMOTE_DIR="${GKWATCH_REMOTE_DIR:-/home/ubuntu/GK-Watch}"

SSH_ARGS=()
if [ -n "$KEY" ] && [ ! -f "$KEY" ]; then
    echo "[ERROR] SSH key not found: $KEY" >&2
    exit 1
fi
if [ -n "$KEY" ]; then
    SSH_ARGS=(-i "$KEY")
fi

echo "Deploying GK Watcher to $SERVER..."
ssh "${SSH_ARGS[@]}" "$SERVER" bash -s -- "$REMOTE_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077

REMOTE_DIR=$1
cd "$REMOTE_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "[ERROR] Refusing to deploy over uncommitted remote changes." >&2
    exit 1
fi

PREVIOUS_REV=$(git rev-parse HEAD)
DEPLOY_COMPLETE=0

configure_compiler() {
    if command -v gcc-10 >/dev/null 2>&1 && command -v g++-10 >/dev/null 2>&1; then
        export CC=gcc-10
        export CXX=g++-10
    fi
}

rollback() {
    status=$?
    trap - EXIT

    if [ "$status" -ne 0 ] && [ "$DEPLOY_COMPLETE" -eq 0 ]; then
        echo "[ERROR] Deployment failed; restoring revision $PREVIOUS_REV..." >&2
        git reset --hard "$PREVIOUS_REV" || true
        configure_compiler

        # Keep rollback compatible with revisions that predate the shared task runner.
        PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true npm --prefix server ci || true
        PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true npm --prefix client ci || true
        npm --prefix client run build || true
        pm2 startOrReload ecosystem.config.js --env production || true
        sleep 3
        curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null || \
            echo "[ERROR] Rollback health check failed; manual intervention is required." >&2
    fi

    exit "$status"
}
trap rollback EXIT

if [ -f server/data/gkwatch.db ]; then
    echo "Creating pre-deployment database backup..."
    npm --prefix server run backup
fi

echo "Pulling latest changes..."
git pull --ff-only
mkdir -p server/data
chmod 700 server/data

configure_compiler

node scripts/gkwatch-tasks.mjs setup

echo "Reloading PM2 application..."
pm2 startOrReload ecosystem.config.js --env production
sleep 3
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
printf '\n'
DEPLOY_COMPLETE=1
trap - EXIT
REMOTE_SCRIPT

echo "Remote deployment completed successfully."
