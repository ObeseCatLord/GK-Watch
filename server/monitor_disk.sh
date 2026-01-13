#!/bin/bash

# Define paths
LOG_FILE="disk_usage.log"
DIAG_SCRIPT="./diagnose_disk_usage.sh"

# Ensure diagnostic script exists and is executable
if [ ! -f "$DIAG_SCRIPT" ]; then
    echo "Error: $DIAG_SCRIPT not found." >> "$LOG_FILE"
    exit 1
fi
chmod +x "$DIAG_SCRIPT"

# Run diagnostic and append to log
echo "========================================================" >> "$LOG_FILE"
echo "RUN TIMESTAMP: $(date)" >> "$LOG_FILE"
echo "========================================================" >> "$LOG_FILE"

./"$DIAG_SCRIPT" >> "$LOG_FILE" 2>&1

echo "" >> "$LOG_FILE"
