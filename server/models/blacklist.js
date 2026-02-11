const db = require('./database');
const crypto = require('crypto');

// Prepared statements
const stmts = {
    getAll: db.prepare('SELECT id, term, added_at as addedAt FROM blacklist ORDER BY added_at DESC'),
    insert: db.prepare('INSERT INTO blacklist (id, term, added_at) VALUES (?, ?, ?)'),
    remove: db.prepare('DELETE FROM blacklist WHERE id = ?'),
    findByTerm: db.prepare('SELECT id FROM blacklist WHERE LOWER(term) = LOWER(?)'),
    clear: db.prepare('DELETE FROM blacklist'),
};

let cachedList = null;

function loadCache() {
    if (cachedList) return cachedList;
    cachedList = stmts.getAll.all();
    return cachedList;
}

function invalidateCache() {
    cachedList = null;
}

const Blacklist = {
    getAll: () => {
        const list = loadCache();
        return list.map(item => ({ ...item }));
    },

    add: (term) => {
        const trimmed = term.trim();
        if (!trimmed) return null;

        // Check for duplicate
        const existing = stmts.findByTerm.get(trimmed);
        if (existing) return null;

        const id = crypto.randomBytes(8).toString('hex');
        const addedAt = new Date().toISOString();

        stmts.insert.run(id, trimmed, addedAt);
        invalidateCache();

        return { id, term: trimmed, addedAt };
    },

    remove: (id) => {
        stmts.remove.run(id);
        invalidateCache();
    },

    /**
     * Replace all blacklist terms at once.
     * Used by the PUT /api/blacklist endpoint.
     */
    replaceAll: (terms) => {
        const replaceTransaction = db.transaction(() => {
            stmts.clear.run();
            const results = [];
            for (const term of terms) {
                const trimmed = (typeof term === 'string' ? term : term.term || '').trim();
                if (!trimmed) continue;

                const id = crypto.randomBytes(8).toString('hex');
                const addedAt = new Date().toISOString();
                stmts.insert.run(id, trimmed, addedAt);
                results.push({ id, term: trimmed, addedAt });
            }
            return results;
        });

        const results = replaceTransaction();
        invalidateCache();
        return results;
    },

    /**
     * Check if a title is blacklisted.
     */
    isBlacklisted: (title) => {
        if (!title) return false;
        const list = loadCache();
        const lowerTitle = title.toLowerCase();
        return list.some(item => lowerTitle.includes(item.term.toLowerCase()));
    },

    /**
     * Filter results by removing items whose titles match any blacklist term.
     */
    filterResults: (results) => {
        if (!results || results.length === 0) return results;
        const list = loadCache();
        if (list.length === 0) return results;

        const lowerTerms = list.map(item => item.term.toLowerCase());
        return results.filter(result => {
            const title = (result.title || '').toLowerCase();
            return !lowerTerms.some(term => title.includes(term));
        });
    }
};

module.exports = Blacklist;
