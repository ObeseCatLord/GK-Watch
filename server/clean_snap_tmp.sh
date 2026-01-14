#!/bin/bash

# Configuration
TARGET_DIR="/tmp/snap-private-tmp/snap.chromium/tmp"
LOG_FILE="/var/log/snap_cleanup.log"

# Check if directory exists
if [ -d "$TARGET_DIR" ]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Calculate size before cleanup
    SIZE_BEFORE=$(du -sh "$TARGET_DIR" 2>/dev/null | cut -f1)
    
    # Clean files older than 60 minutes
    find "$TARGET_DIR" -type f -mmin +60 -delete 2>/dev/null
    
    # Clean empty directories
    find "$TARGET_DIR" -type d -empty -delete 2>/dev/null
    
    # Calculate size after cleanup
    SIZE_AFTER=$(du -sh "$TARGET_DIR" 2>/dev/null | cut -f1)
    
    echo "[$TIMESTAMP] Cleaned $TARGET_DIR. Size: $SIZE_BEFORE -> $SIZE_AFTER" >> "$LOG_FILE"
else
    # Only log error if it's missing but expected (silence is golden otherwise)
    # echo "$(date): $TARGET_DIR not found." >> "$LOG_FILE"
    :
fi
