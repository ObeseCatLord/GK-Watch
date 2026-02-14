/**
 * Test Setup Helper
 * 
 * Provides a fresh, isolated SQLite database for each test suite.
 * This replaces the production database module during testing so that
 * tests never touch real data.
 * 
 * IMPORTANT: Call getTestDb() in beforeAll BEFORE requiring any models.
 * This replaces the database module in the require cache so all subsequent
 * requires of models use the test DB.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

let testDb = null;
let testDbPath = null;

/**
 * Create a fresh temporary SQLite database with the full schema.
 * Replaces the require cache for '../models/database' so that
 * all models loaded AFTER this call will use the test DB.
 */
function getTestDb() {
    if (testDb) return testDb;

    // Create a temp file for the test database
    testDbPath = path.join(os.tmpdir(), `gkwatch_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    testDb = new Database(testDbPath);

    // Apply pragmas matching production
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('synchronous = NORMAL');
    testDb.pragma('foreign_keys = ON');
    testDb.pragma('busy_timeout = 5000');

    // Initialize schema (copied from database.js initSchema)
    testDb.exec(`
        CREATE TABLE IF NOT EXISTS watchlist (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            terms TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_run TEXT,
            last_result_count INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1,
            email_notify INTEGER DEFAULT 0,
            priority INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            enabled_sites TEXT DEFAULT '{}',
            strict INTEGER DEFAULT 1,
            filters TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id TEXT NOT NULL,
            title TEXT NOT NULL,
            link TEXT NOT NULL,
            image TEXT DEFAULT '',
            price TEXT DEFAULT '',
            bid_price TEXT DEFAULT '',
            bin_price TEXT DEFAULT '',
            end_time TEXT DEFAULT '',
            source TEXT DEFAULT '',
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            is_new INTEGER DEFAULT 1,
            hidden INTEGER DEFAULT 0,
            FOREIGN KEY (watch_id) REFERENCES watchlist(id) ON DELETE CASCADE,
            UNIQUE(watch_id, link)
        );

        CREATE TABLE IF NOT EXISTS results_meta (
            watch_id TEXT PRIMARY KEY,
            updated_at TEXT NOT NULL,
            new_count INTEGER DEFAULT 0,
            FOREIGN KEY (watch_id) REFERENCES watchlist(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS blocked_items (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            title TEXT DEFAULT '',
            image TEXT DEFAULT '',
            blocked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blacklist (
            id TEXT PRIMARY KEY,
            term TEXT NOT NULL,
            added_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedule (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
        );
    `);

    // Create indexes
    testDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_results_watch_id ON results(watch_id);
        CREATE INDEX IF NOT EXISTS idx_results_link ON results(link);
        CREATE INDEX IF NOT EXISTS idx_results_new ON results(watch_id, is_new);
        CREATE INDEX IF NOT EXISTS idx_blocked_url ON blocked_items(url);
    `);

    // Replace the database module in require cache BEFORE any model is loaded
    const dbModulePath = require.resolve('../models/database');
    jest.doMock(dbModulePath, () => testDb);
    // Also mock relative path just in case
    jest.doMock('../models/database', () => testDb);

    return testDb;
}

/**
 * Close and clean up the test database.
 */
function closeTestDb() {
    // Clear all module caches for models so next test suite gets fresh modules
    const modulesToClear = [
        '../models/database',
        '../models/settings',
        '../models/watchlist',
        '../models/blacklist',
        '../models/blocked_items',
        '../models/schedule',
    ];

    for (const modPath of modulesToClear) {
        try {
            const resolved = require.resolve(modPath);
            delete require.cache[resolved];
        } catch (e) { /* ignore */ }
    }

    if (testDb) {
        try { testDb.close(); } catch (e) { /* already closed */ }
        testDb = null;
    }

    if (testDbPath) {
        try {
            if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
            if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
            if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
        } catch (e) { /* ignore */ }
        testDbPath = null;
    }
}

/**
 * Clear all data from the test database tables.
 * Also invalidates model-level caches by re-requiring modules.
 */
function clearTestDb() {
    if (!testDb) return;

    // Disable foreign keys temporarily for clean deletion
    testDb.pragma('foreign_keys = OFF');
    testDb.exec(`
        DELETE FROM results_meta;
        DELETE FROM results;
        DELETE FROM watchlist;
        DELETE FROM blocked_items;
        DELETE FROM blacklist;
        DELETE FROM settings;
        DELETE FROM schedule;
        DELETE FROM sessions;
    `);

    testDb.pragma('foreign_keys = ON');
}

module.exports = { getTestDb, closeTestDb, clearTestDb };
