/**
 * Centralized SQLite Database Module for GK Watch
 * 
 * Provides a single shared database connection and schema initialization.
 * Handles auto-migration from legacy JSON files on first boot.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'gkwatch.db');

// Legacy JSON file paths (for migration)
const LEGACY_FILES = {
    watchlist: path.join(DATA_DIR, 'watchlist.json'),
    settings: path.join(DATA_DIR, 'settings.json'),
    schedule: path.join(DATA_DIR, 'schedule.json'),
    blacklist: path.join(DATA_DIR, 'blacklist.json'),
    blocked_items: path.join(DATA_DIR, 'blocked_items.json'),
    results: path.join(DATA_DIR, 'results.json')
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create and configure the database connection
const db = new Database(DB_PATH);

// Performance optimizations
db.pragma('journal_mode = WAL');      // Write-Ahead Logging for concurrent reads
db.pragma('synchronous = NORMAL');     // Faster writes, still safe with WAL
db.pragma('foreign_keys = ON');        // Enforce foreign key constraints
db.pragma('busy_timeout = 5000');      // Wait up to 5s if DB is locked

/**
 * Initialize all tables
 */
function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            terms TEXT NOT NULL DEFAULT '[]',
            created_at TEXT,
            last_run TEXT,
            last_result_count INTEGER,
            active INTEGER DEFAULT 1,
            email_notify INTEGER DEFAULT 1,
            priority INTEGER DEFAULT 0,
            strict INTEGER DEFAULT 1,
            filters TEXT DEFAULT '[]',
            enabled_sites TEXT DEFAULT '{}',
            sort_order INTEGER
        );

        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id TEXT NOT NULL,
            title TEXT,
            link TEXT NOT NULL,
            image TEXT,
            price TEXT,
            bid_price TEXT,
            bin_price TEXT,
            end_time TEXT,
            source TEXT,
            first_seen TEXT NOT NULL,
            last_seen TEXT,
            is_new INTEGER DEFAULT 1,
            hidden INTEGER DEFAULT 0,
            UNIQUE(watch_id, link)
        );

        CREATE TABLE IF NOT EXISTS results_meta (
            watch_id TEXT PRIMARY KEY,
            updated_at TEXT,
            new_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS blocked_items (
            id TEXT PRIMARY KEY,
            url TEXT UNIQUE NOT NULL,
            title TEXT,
            image TEXT,
            blocked_at TEXT
        );

        CREATE TABLE IF NOT EXISTS blacklist (
            id TEXT PRIMARY KEY,
            term TEXT NOT NULL,
            added_at TEXT
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedule (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // Create indexes (IF NOT EXISTS is implicit with CREATE INDEX IF NOT EXISTS)
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_results_watch_id ON results(watch_id);
        CREATE INDEX IF NOT EXISTS idx_results_link ON results(watch_id, link);
        CREATE INDEX IF NOT EXISTS idx_results_source ON results(watch_id, source);
        CREATE INDEX IF NOT EXISTS idx_results_first_seen ON results(first_seen);
        CREATE INDEX IF NOT EXISTS idx_results_last_seen ON results(last_seen);
        CREATE INDEX IF NOT EXISTS idx_results_is_new ON results(watch_id, is_new);
        CREATE INDEX IF NOT EXISTS idx_blocked_url ON blocked_items(url);
        CREATE INDEX IF NOT EXISTS idx_watchlist_sort ON watchlist(sort_order);
    `);
}

/**
 * Check if migration from JSON files is needed
 */
function needsMigration() {
    // Migration is needed if:
    // 1. The database has no data in key tables AND
    // 2. Legacy JSON files exist with data
    const watchCount = db.prepare('SELECT COUNT(*) as count FROM watchlist').get().count;
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get().count;

    // If we already have data, no migration needed
    if (watchCount > 0 || settingsCount > 0) {
        return false;
    }

    // Check if any legacy JSON files exist with content
    for (const [name, filePath] of Object.entries(LEGACY_FILES)) {
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(data);
                // Check if there's actual data
                if (Array.isArray(parsed) && parsed.length > 0) return true;
                if (typeof parsed === 'object' && Object.keys(parsed).length > 0) return true;
            } catch (e) {
                // Skip broken files
            }
        }
    }

    return false;
}

/**
 * Migrate data from legacy JSON files to SQLite
 */
function migrateFromJson() {
    console.log('[DB Migration] Starting migration from JSON files to SQLite...');

    const migrate = db.transaction(() => {
        // 1. Migrate Settings
        if (fs.existsSync(LEGACY_FILES.settings)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.settings, 'utf8'));
                const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
                for (const [key, value] of Object.entries(data)) {
                    insertSetting.run(key, JSON.stringify(value));
                }
                console.log(`[DB Migration] Migrated settings (${Object.keys(data).length} keys)`);
            } catch (e) {
                console.error('[DB Migration] Error migrating settings:', e.message);
            }
        }

        // 2. Migrate Schedule
        if (fs.existsSync(LEGACY_FILES.schedule)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.schedule, 'utf8'));
                const insertSchedule = db.prepare('INSERT OR REPLACE INTO schedule (key, value) VALUES (?, ?)');
                for (const [key, value] of Object.entries(data)) {
                    insertSchedule.run(key, JSON.stringify(value));
                }
                console.log(`[DB Migration] Migrated schedule (${Object.keys(data).length} keys)`);
            } catch (e) {
                console.error('[DB Migration] Error migrating schedule:', e.message);
            }
        }

        // 3. Migrate Blacklist
        if (fs.existsSync(LEGACY_FILES.blacklist)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.blacklist, 'utf8'));
                if (Array.isArray(data)) {
                    const insertBlacklist = db.prepare(
                        'INSERT OR IGNORE INTO blacklist (id, term, added_at) VALUES (?, ?, ?)'
                    );
                    for (const item of data) {
                        insertBlacklist.run(item.id, item.term, item.addedAt);
                    }
                    console.log(`[DB Migration] Migrated blacklist (${data.length} terms)`);
                }
            } catch (e) {
                console.error('[DB Migration] Error migrating blacklist:', e.message);
            }
        }

        // 4. Migrate Blocked Items
        if (fs.existsSync(LEGACY_FILES.blocked_items)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.blocked_items, 'utf8'));
                if (Array.isArray(data)) {
                    const insertBlocked = db.prepare(
                        'INSERT OR IGNORE INTO blocked_items (id, url, title, image, blocked_at) VALUES (?, ?, ?, ?, ?)'
                    );
                    for (const item of data) {
                        insertBlocked.run(item.id, item.url, item.title || '', item.image || '', item.blockedAt);
                    }
                    console.log(`[DB Migration] Migrated blocked items (${data.length} items)`);
                }
            } catch (e) {
                console.error('[DB Migration] Error migrating blocked items:', e.message);
            }
        }

        // 5. Migrate Watchlist
        if (fs.existsSync(LEGACY_FILES.watchlist)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.watchlist, 'utf8'));
                if (Array.isArray(data)) {
                    const insertWatch = db.prepare(`
                        INSERT OR IGNORE INTO watchlist 
                        (id, name, terms, created_at, last_run, last_result_count, active, email_notify, priority, strict, filters, enabled_sites, sort_order) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    data.forEach((item, index) => {
                        const terms = Array.isArray(item.terms) ? item.terms : [item.term];
                        insertWatch.run(
                            item.id,
                            item.name || terms[0] || item.term,
                            JSON.stringify(terms),
                            item.createdAt,
                            item.lastRun || null,
                            item.lastResultCount || null,
                            item.active !== false ? 1 : 0,
                            item.emailNotify !== false ? 1 : 0,
                            item.priority === true ? 1 : 0,
                            item.strict !== false ? 1 : 0,
                            JSON.stringify(item.filters || []),
                            JSON.stringify(item.enabledSites || {}),
                            index
                        );
                    });
                    console.log(`[DB Migration] Migrated watchlist (${data.length} items)`);
                }
            } catch (e) {
                console.error('[DB Migration] Error migrating watchlist:', e.message);
            }
        }

        // 6. Migrate Results (the big one)
        if (fs.existsSync(LEGACY_FILES.results)) {
            try {
                const data = JSON.parse(fs.readFileSync(LEGACY_FILES.results, 'utf8'));
                const insertResult = db.prepare(`
                    INSERT OR IGNORE INTO results 
                    (watch_id, title, link, image, price, bid_price, bin_price, end_time, source, first_seen, last_seen, is_new, hidden) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const insertMeta = db.prepare(`
                    INSERT OR REPLACE INTO results_meta (watch_id, updated_at, new_count) VALUES (?, ?, ?)
                `);

                let totalItems = 0;
                for (const [watchId, watchData] of Object.entries(data)) {
                    // Insert metadata
                    insertMeta.run(watchId, watchData.updatedAt || null, watchData.newCount || 0);

                    // Insert items
                    if (Array.isArray(watchData.items)) {
                        for (const item of watchData.items) {
                            insertResult.run(
                                watchId,
                                item.title || '',
                                item.link,
                                item.image || '',
                                item.price || '',
                                item.bidPrice || '',
                                item.binPrice || '',
                                item.endTime || '',
                                item.source || '',
                                item.firstSeen || new Date().toISOString(),
                                item.lastSeen || null,
                                item.isNew ? 1 : 0,
                                item.hidden ? 1 : 0
                            );
                            totalItems++;
                        }
                    }
                }
                console.log(`[DB Migration] Migrated results (${Object.keys(data).length} watches, ${totalItems} total items)`);
            } catch (e) {
                console.error('[DB Migration] Error migrating results:', e.message);
            }
        }
    });

    // Execute the migration in a single transaction
    migrate();

    // Rename old JSON files to .json.bak (don't delete, as backup)
    for (const [name, filePath] of Object.entries(LEGACY_FILES)) {
        if (fs.existsSync(filePath)) {
            const backupPath = filePath + '.bak';
            try {
                fs.renameSync(filePath, backupPath);
                console.log(`[DB Migration] Backed up ${name}.json → ${name}.json.bak`);
            } catch (e) {
                console.error(`[DB Migration] Could not rename ${name}.json:`, e.message);
            }
        }
    }

    console.log('[DB Migration] Migration complete!');
}

// Initialize
initSchema();

// Auto-migrate if legacy JSON files exist
if (needsMigration()) {
    migrateFromJson();
}

// Graceful shutdown
process.on('exit', () => {
    try { db.close(); } catch (e) { /* already closed */ }
});

module.exports = db;
