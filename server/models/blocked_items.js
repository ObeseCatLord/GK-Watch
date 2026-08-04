const db = require('./database');
const crypto = require('crypto');

// Prepared statements
const stmts = {
    getAll: db.prepare('SELECT id, url, title, image, blocked_at as blockedAt FROM blocked_items ORDER BY blocked_at DESC'),
    insert: db.prepare(`
        INSERT OR IGNORE INTO blocked_items
        (id, url, title, image, blocked_at, last_seen_at, missing_confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
    `),
    remove: db.prepare('DELETE FROM blocked_items WHERE id = ?'),
    clearMissingFromResults: db.prepare(`
        DELETE FROM blocked_items
        WHERE missing_confirmed_at IS NOT NULL
          AND (last_seen_at IS NULL OR missing_confirmed_at >= last_seen_at)
          AND NOT EXISTS (
            SELECT 1
            FROM results
            WHERE results.link = blocked_items.url
        )
    `),
    findByUrl: db.prepare('SELECT id FROM blocked_items WHERE url = ?'),
    recordSeen: db.prepare(`
        UPDATE blocked_items
        SET last_seen_at = CASE
                WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
                ELSE last_seen_at
            END,
            missing_confirmed_at = NULL
        WHERE url = ?
    `),
    confirmMissing: db.prepare(`
        UPDATE blocked_items
        SET missing_confirmed_at = CASE
                WHEN missing_confirmed_at IS NULL OR missing_confirmed_at < ? THEN ?
                ELSE missing_confirmed_at
            END
        WHERE url = ?
          AND NOT EXISTS (SELECT 1 FROM results WHERE results.link = blocked_items.url)
    `),
    suppressMatchingResults: db.prepare(`
        UPDATE results
        SET hidden = 1, is_new = 0, new_type = 'new', last_seen = ?
        WHERE link = ?
    `),
    refreshMatchingMeta: db.prepare(`
        UPDATE results_meta
        SET new_count = (
            SELECT COUNT(*)
            FROM results
            WHERE results.watch_id = results_meta.watch_id
              AND results.is_new = 1
              AND NOT EXISTS (SELECT 1 FROM blocked_items WHERE blocked_items.url = results.link)
        )
        WHERE watch_id IN (SELECT watch_id FROM results WHERE link = ?)
    `),
    refreshMatchingWatchCounts: db.prepare(`
        UPDATE watchlist
        SET last_result_count = (
            SELECT COUNT(*)
            FROM results
            WHERE results.watch_id = watchlist.id
              AND results.hidden = 0
              AND NOT EXISTS (SELECT 1 FROM blocked_items WHERE blocked_items.url = results.link)
        )
        WHERE id IN (SELECT watch_id FROM results WHERE link = ?)
    `),
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

        db.transaction(() => {
            stmts.insert.run(id, url, title || '', image || '', blockedAt, blockedAt);
            stmts.suppressMatchingResults.run(blockedAt, url);
            stmts.refreshMatchingMeta.run(url);
            stmts.refreshMatchingWatchCounts.run(url);
        })();
        invalidateCache();

        return { id, url, title: title || '', image: image || '', blockedAt };
    },

    remove: (id) => {
        stmts.remove.run(id);
        invalidateCache();
    },

    clearMissingFromResults: () => {
        const result = stmts.clearMissingFromResults.run();
        invalidateCache();
        return result.changes || 0;
    },

    getUrlSet: () => new Set(loadCache().map(item => item.url)),

    recordSeen: (results, seenAt = new Date().toISOString()) => {
        if (!Array.isArray(results) || results.length === 0) return 0;

        const blockedUrls = BlockedItems.getUrlSet();
        if (blockedUrls.size === 0) return 0;

        const seenUrls = new Set();
        for (const result of results) {
            if (!result || result.error) continue;
            const url = result.link || result.url;
            if (url && blockedUrls.has(url)) seenUrls.add(url);
        }

        if (seenUrls.size === 0) return 0;
        return db.transaction(() => {
            let changes = 0;
            for (const url of seenUrls) {
                changes += stmts.recordSeen.run(seenAt, seenAt, url).changes || 0;
            }
            return changes;
        })();
    },

    confirmMissing: (url, confirmedAt = new Date().toISOString()) => {
        if (!url) return false;
        return (stmts.confirmMissing.run(confirmedAt, confirmedAt, url).changes || 0) > 0;
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
