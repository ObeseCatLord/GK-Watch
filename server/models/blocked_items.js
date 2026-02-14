const db = require('./database');
const crypto = require('crypto');

// Prepared statements
const stmts = {
    getAll: db.prepare('SELECT id, url, title, image, blocked_at as blockedAt FROM blocked_items ORDER BY blocked_at DESC'),
    insert: db.prepare('INSERT OR IGNORE INTO blocked_items (id, url, title, image, blocked_at) VALUES (?, ?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM blocked_items WHERE id = ?'),
    findByUrl: db.prepare('SELECT id FROM blocked_items WHERE url = ?'),
    count: db.prepare('SELECT COUNT(*) as count FROM blocked_items'),
};

let cachedItems = null;

function loadCache() {
    if (cachedItems) return cachedItems;
    cachedItems = stmts.getAll.all();
    return cachedItems;
}

function invalidateCache() {
    cachedItems = null;
}

const BlockedItems = {
    getAll: () => {
        const list = loadCache();
        return list.map(item => ({ ...item }));
    },

    add: (url, title, image) => {
        if (!url) return null;

        // Check for duplicate
        const existing = stmts.findByUrl.get(url);
        if (existing) return null;

        const id = crypto.randomBytes(8).toString('hex');
        const blockedAt = new Date().toISOString();

        stmts.insert.run(id, url, title || '', image || '', blockedAt);
        invalidateCache();

        return { id, url, title: title || '', image: image || '', blockedAt };
    },

    remove: (id) => {
        stmts.remove.run(id);
        invalidateCache();
    },

    /**
     * Check if a specific URL is blocked.
     */
    isBlocked: (url) => {
        if (!url) return false;
        const result = stmts.findByUrl.get(url);
        return !!result;
    },

    /**
     * Filter results by removing items whose URLs are in the blocklist.
     */
    filterResults: (results) => {
        if (!results || results.length === 0) return results;

        // Build a Set of blocked URLs for O(1) lookup
        const list = loadCache();
        if (list.length === 0) return results;

        const blockedUrls = new Set(list.map(item => item.url));
        return results.filter(result => {
            const link = result.link || result.url;
            return !blockedUrls.has(link);
        });
    },

    _resetCache: () => {
        cachedItems = null;
    }
};

module.exports = BlockedItems;
