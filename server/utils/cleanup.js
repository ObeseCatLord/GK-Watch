/**
 * Cleanup Utility for GK Watch
 * 
 * Provides automatic cleanup of:
 * - Log files (rotation when size exceeds limit)
 * - Expired results (remove items older than X days)
 */

const fs = require('fs');
const path = require('path');
const db = require('../models/database');

// Configuration
const CONFIG = {
    MAX_LOG_SIZE_BYTES: 1 * 1024 * 1024,  // 1 MB
    LOG_LINES_TO_KEEP: 1000,               // Keep last 1000 lines after rotation
    RESULTS_MAX_AGE_DAYS: 3,               // Remove items older than 3 days (if not seen)
};

const SERVER_LOG_PATH = path.join(__dirname, '..', 'server.log');

/**
 * Rotate the server.log file if it exceeds the max size.
 * Keeps the last N lines of the log.
 * 
 * @returns {Object} Statistics about the rotation
 */
function rotateLogIfNeeded() {
    const stats = {
        rotated: false,
        originalSize: 0,
        newSize: 0,
        linesRemoved: 0
    };

    try {
        if (!fs.existsSync(SERVER_LOG_PATH)) {
            return stats;
        }

        const fileStats = fs.statSync(SERVER_LOG_PATH);
        stats.originalSize = fileStats.size;

        if (fileStats.size <= CONFIG.MAX_LOG_SIZE_BYTES) {
            return stats; // No rotation needed
        }

        console.log(`[Cleanup] Log file size (${(fileStats.size / 1024 / 1024).toFixed(2)} MB) exceeds limit. Rotating...`);

        // Read the file and keep only the last N lines
        const content = fs.readFileSync(SERVER_LOG_PATH, 'utf8');
        const lines = content.split('\n');
        const originalLineCount = lines.length;

        // Keep the last N lines
        const linesToKeep = lines.slice(-CONFIG.LOG_LINES_TO_KEEP);
        const newContent = linesToKeep.join('\n');

        // Write back the truncated content
        fs.writeFileSync(SERVER_LOG_PATH, newContent);

        stats.rotated = true;
        stats.newSize = Buffer.byteLength(newContent, 'utf8');
        stats.linesRemoved = originalLineCount - linesToKeep.length;

        console.log(`[Cleanup] Log rotated: removed ${stats.linesRemoved} lines, kept ${linesToKeep.length} lines`);
        console.log(`[Cleanup] Log size reduced from ${(stats.originalSize / 1024).toFixed(1)} KB to ${(stats.newSize / 1024).toFixed(1)} KB`);

    } catch (error) {
        console.error('[Cleanup] Error rotating log:', error.message);
    }

    return stats;
}

/**
 * Remove expired results from the database that are older than the configured max age.
 * An item is considered "old" based on its lastSeen or firstSeen timestamp.
 * 
 * @returns {Object} Statistics about the cleanup
 */
function cleanupExpiredResults() {
    const stats = {
        cleaned: false,
        watchlistsProcessed: 0,
        itemsRemoved: 0,
        itemsKept: 0,
        originalSize: 0,
        newSize: 0
    };

    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - CONFIG.RESULTS_MAX_AGE_DAYS);
        const cutoffIso = cutoffDate.toISOString();

        // Count before
        const beforeCount = db.prepare('SELECT COUNT(*) as count FROM results').get().count;
        stats.originalSize = beforeCount;

        // Delete expired items:
        // Keep items that have no timestamps (legacy) or have been seen recently
        const deleteStmt = db.prepare(`
            DELETE FROM results 
            WHERE COALESCE(last_seen, first_seen) IS NOT NULL 
            AND COALESCE(last_seen, first_seen) < ?
        `);
        const result = deleteStmt.run(cutoffIso);
        stats.itemsRemoved = result.changes;

        // Count after
        const afterCount = db.prepare('SELECT COUNT(*) as count FROM results').get().count;
        stats.itemsKept = afterCount;
        stats.newSize = afterCount;

        // Update new_count in results_meta for affected watch IDs
        if (stats.itemsRemoved > 0) {
            stats.cleaned = true;

            // Recalculate new_count for all watch IDs
            db.prepare(`
                UPDATE results_meta SET new_count = (
                    SELECT COUNT(*) FROM results 
                    WHERE results.watch_id = results_meta.watch_id AND results.is_new = 1
                )
            `).run();

            console.log(`[Cleanup] Results cleanup: removed ${stats.itemsRemoved} expired items (older than ${CONFIG.RESULTS_MAX_AGE_DAYS} days)`);
            console.log(`[Cleanup] Results: ${beforeCount} → ${afterCount} items`);
        } else {
            console.log(`[Cleanup] Results cleanup: no expired items found`);
        }

        stats.watchlistsProcessed = db.prepare('SELECT COUNT(DISTINCT watch_id) as count FROM results').get().count;

    } catch (error) {
        console.error('[Cleanup] Error cleaning results:', error.message);
    }

    return stats;
}

/**
 * Remove Puppeteer temporary profile directories from /tmp.
 * Only removes directories older than 1 hour to ensure active sessions aren't killed.
 * 
 * @returns {Object} Statistics about the cleanup
 */
function cleanupPuppeteerTemp() {
    const stats = {
        cleaned: false,
        filesRemoved: 0,
        spaceFreed: 0
    };

    try {
        const tempDir = '/tmp';
        if (!fs.existsSync(tempDir)) return stats;

        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        const oneHourMs = 60 * 60 * 1000;

        files.forEach(file => {
            if (file.startsWith('puppeteer_dev_profile') || file.startsWith('puppeteer_dev_chrome_profile')) {
                const filePath = path.join(tempDir, file);
                try {
                    const fileStats = fs.statSync(filePath);
                    const age = now - fileStats.mtimeMs;

                    if (age > oneHourMs) {
                        // Calculate size roughly (just the folder entry usually, recursive size is expensive)
                        // For cleanup stats, we count folders removed.
                        fs.rmSync(filePath, { recursive: true, force: true });
                        stats.filesRemoved++;
                        stats.cleaned = true;
                    }
                } catch (e) {
                    // Ignore errors accessing/deleting specific files (permission, etc)
                }
            }
        });

        if (stats.cleaned) {
            console.log(`[Cleanup] Puppeteer temp cleanup: removed ${stats.filesRemoved} old profile directories.`);
        }

    } catch (error) {
        console.error('[Cleanup] Error cleaning Puppeteer temp:', error.message);
    }

    return stats;
}

/**
 * Cleanup debug files generated by scrapers.
 */
function cleanupDebugFiles() {
    const debugFiles = [
        '../yahoo_full.html',
        '../taobao_debug.html',
        '../taobao_debug.png'
    ];

    let removedCount = 0;

    debugFiles.forEach(file => {
        const filePath = path.join(__dirname, file);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                removedCount++;
            } catch (e) {
                console.error(`[Cleanup] Failed to remove ${file}:`, e.message);
            }
        }
    });

    if (removedCount > 0) {
        console.log(`[Cleanup] Removed ${removedCount} debug dump files.`);
    }
}

/**
 * Run all cleanup tasks.
 * 
 * @returns {Object} Combined statistics from all cleanup operations
 */
function runFullCleanup() {
    console.log('[Cleanup] Starting full cleanup...');

    const logStats = rotateLogIfNeeded();
    const resultsStats = cleanupExpiredResults();
    const puppeteerStats = cleanupPuppeteerTemp();
    cleanupDebugFiles();

    const summary = {
        log: logStats,
        results: resultsStats,
        puppeteer: puppeteerStats,
        timestamp: new Date().toISOString()
    };

    console.log('[Cleanup] Full cleanup complete.');
    return summary;
}

/**
 * Get current configuration values.
 */
function getConfig() {
    return { ...CONFIG };
}

/**
 * Update configuration values.
 * @param {Object} newConfig - New configuration values to merge
 */
function updateConfig(newConfig) {
    if (newConfig.maxLogSizeBytes !== undefined) {
        CONFIG.MAX_LOG_SIZE_BYTES = newConfig.maxLogSizeBytes;
    }
    if (newConfig.logLinesToKeep !== undefined) {
        CONFIG.LOG_LINES_TO_KEEP = newConfig.logLinesToKeep;
    }
    if (newConfig.resultsMaxAgeDays !== undefined) {
        CONFIG.RESULTS_MAX_AGE_DAYS = newConfig.resultsMaxAgeDays;
    }
    return { ...CONFIG };
}

module.exports = {
    rotateLogIfNeeded,
    cleanupExpiredResults,
    cleanupPuppeteerTemp,
    cleanupDebugFiles,
    runFullCleanup,
    getConfig,
    updateConfig
};
