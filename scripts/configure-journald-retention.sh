#!/bin/bash
# Install a small journald retention policy for hosts that run GK Watch continuously.

set -euo pipefail

MAX_USE="${GKWATCH_JOURNAL_MAX_USE:-512M}"
KEEP_FREE="${GKWATCH_JOURNAL_KEEP_FREE:-1G}"
MAX_FILE_SIZE="${GKWATCH_JOURNAL_MAX_FILE_SIZE:-64M}"
RUNTIME_MAX_USE="${GKWATCH_JOURNAL_RUNTIME_MAX_USE:-128M}"
RUNTIME_MAX_FILE_SIZE="${GKWATCH_JOURNAL_RUNTIME_MAX_FILE_SIZE:-32M}"
MAX_RETENTION="${GKWATCH_JOURNAL_MAX_RETENTION:-30d}"

DROPIN_DIR="/etc/systemd/journald.conf.d"
DROPIN_FILE="$DROPIN_DIR/gkwatch-retention.conf"

run_root() {
    if [ "${EUID:-$(id -u)}" -eq 0 ]; then
        "$@"
        return
    fi

    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        sudo "$@"
        return
    fi

    return 77
}

if ! command -v journalctl >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
    echo "ℹ️  systemd journal tools not found; skipping journal retention setup."
    exit 0
fi

if ! run_root true; then
    echo "ℹ️  Noninteractive sudo is not available; skipping journal retention setup."
    echo "   Run this script with sudo to install the journald retention policy."
    exit 0
fi

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

cat > "$tmp_file" <<EOF
# Managed by GK Watch. Limits systemd-journald disk usage on long-running hosts.
[Journal]
SystemMaxUse=$MAX_USE
SystemKeepFree=$KEEP_FREE
SystemMaxFileSize=$MAX_FILE_SIZE
RuntimeMaxUse=$RUNTIME_MAX_USE
RuntimeMaxFileSize=$RUNTIME_MAX_FILE_SIZE
MaxRetentionSec=$MAX_RETENTION
EOF

echo "🧹 Installing journald retention policy at $DROPIN_FILE"
run_root mkdir -p "$DROPIN_DIR"
run_root install -m 0644 "$tmp_file" "$DROPIN_FILE"

echo "🔄 Restarting systemd-journald..."
run_root systemctl restart systemd-journald.service

echo "🧹 Vacuuming existing journal files to $MAX_USE / $MAX_RETENTION..."
run_root journalctl --vacuum-size="$MAX_USE"
run_root journalctl --vacuum-time="$MAX_RETENTION"

journalctl --disk-usage || true
