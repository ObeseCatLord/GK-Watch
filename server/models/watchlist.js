const db = require('./database');

// Prepared statements
const stmts = {
    getAll: db.prepare(`
        SELECT id, name, terms, created_at as createdAt, last_run as lastRun, 
               last_result_count as lastResultCount, active, email_notify as emailNotify, 
               priority, strict, filters, enabled_sites as enabledSites, site_options as siteOptions, sort_order as sortOrder
        FROM watchlist ORDER BY sort_order ASC, created_at ASC
    `),
    getById: db.prepare('SELECT * FROM watchlist WHERE id = ?'),
    insert: db.prepare(`
        INSERT INTO watchlist (id, name, terms, created_at, last_run, last_result_count, active, email_notify, priority, strict, filters, enabled_sites, site_options, sort_order)
        VALUES (@id, @name, @terms, @createdAt, @lastRun, @lastResultCount, @active, @emailNotify, @priority, @strict, @filters, @enabledSites, @siteOptions, @sortOrder)
    `),
    update: db.prepare(`
        UPDATE watchlist SET name=@name, terms=@terms, last_run=@lastRun, last_result_count=@lastResultCount, 
        active=@active, email_notify=@emailNotify, priority=@priority, strict=@strict, 
        filters=@filters, enabled_sites=@enabledSites, site_options=@siteOptions, sort_order=@sortOrder
        WHERE id=@id
    `),
    remove: db.prepare('DELETE FROM watchlist WHERE id = ?'),
    removeResults: db.prepare('DELETE FROM results WHERE watch_id = ?'),
    removeResultsMeta: db.prepare('DELETE FROM results_meta WHERE watch_id = ?'),
    updateLastRun: db.prepare('UPDATE watchlist SET last_run = ?, last_result_count = ? WHERE id = ?'),
    updateSortOrder: db.prepare('UPDATE watchlist SET sort_order = ? WHERE id = ?'),
    maxSortOrder: db.prepare('SELECT MAX(sort_order) as maxOrder FROM watchlist'),
    count: db.prepare('SELECT COUNT(*) as count FROM watchlist'),
};

const DEFAULT_ENABLED_SITES = {
    mercari: true,
    yahoo: true,
    paypay: true,
    fril: true,
    surugaya: true,
    taobao: false,
    goofish: false,
    mandarake: true
};

const DEFAULT_SITE_OPTIONS = {
    mandarake: {
        mode: 'garageKit'
    }
};

/**
 * Convert a raw DB row to the application-level watchlist item format
 */
function rowToItem(row) {
    if (!row) return null;

    const terms = JSON.parse(row.terms || '[]');
    const filters = JSON.parse(row.filters || '[]');
    const enabledSites = JSON.parse(row.enabledSites || '{}');
    const siteOptions = JSON.parse(row.siteOptions || '{}');

    return {
        id: row.id,
        name: row.name || terms[0],
        term: row.name || terms[0], // legacy support
        terms,
        createdAt: row.createdAt,
        lastRun: row.lastRun || null,
        lastResultCount: row.lastResultCount != null ? row.lastResultCount : 0,
        active: row.active === 1 || row.active === true,
        emailNotify: row.emailNotify === 1 || row.emailNotify === true,
        priority: row.priority === 1 || row.priority === true,
        strict: row.strict === 1 || row.strict === true || row.strict === undefined,
        filters,
        enabledSites: { ...DEFAULT_ENABLED_SITES, ...enabledSites },
        siteOptions: {
            ...DEFAULT_SITE_OPTIONS,
            ...siteOptions,
            mandarake: {
                ...DEFAULT_SITE_OPTIONS.mandarake,
                ...(siteOptions.mandarake || {})
            }
        },
        sortOrder: row.sortOrder
    };
}

/**
 * Convert a watchlist item to DB parameters
 */
function itemToParams(item) {
    return {
        id: item.id,
        name: item.name,
        terms: JSON.stringify(item.terms || []),
        createdAt: item.createdAt,
        lastRun: item.lastRun || null,
        lastResultCount: item.lastResultCount || null,
        active: item.active !== false ? 1 : 0,
        emailNotify: item.emailNotify !== false ? 1 : 0,
        priority: item.priority === true ? 1 : 0,
        strict: item.strict !== false ? 1 : 0,
        filters: JSON.stringify(item.filters || []),
        enabledSites: JSON.stringify(item.enabledSites || DEFAULT_ENABLED_SITES),
        siteOptions: JSON.stringify(item.siteOptions || DEFAULT_SITE_OPTIONS),
        sortOrder: item.sortOrder != null ? item.sortOrder : null
    };
}

const Watchlist = {
    getAll: async () => {
        try {
            const rows = stmts.getAll.all();
            return rows.map(rowToItem);
        } catch (err) {
            console.error('Error reading watchlist:', err);
            return [];
        }
    },

    get: async (id) => {
        try {
            const row = stmts.getById.get(id);
            if (!row) return null;
            return rowToItem({
                ...row,
                createdAt: row.created_at,
                lastRun: row.last_run,
                lastResultCount: row.last_result_count,
                emailNotify: row.email_notify,
                enabledSites: row.enabled_sites,
                siteOptions: row.site_options,
                sortOrder: row.sort_order
            });
        } catch (err) {
            console.error('Error getting watchlist item:', err);
            return null;
        }
    },

    add: async (data) => {
        const list = await Watchlist.getAll();

        // Support both simple string (legacy) and object with terms
        const terms = typeof data === 'string' ? [data] : (data.terms || [data.term]);
        const name = data.name || terms[0];

        // Check for duplicates
        const normalizeTerms = (t) => JSON.stringify(t.slice().sort());
        const newTermsNorm = normalizeTerms(terms);

        const existing = list.find(item => {
            const itemTerms = Array.isArray(item.terms) ? item.terms : [item.term];
            return normalizeTerms(itemTerms) === newTermsNorm || item.name === name;
        });

        if (existing) {
            return existing;
        }

        // Get max sort order
        const maxRow = stmts.maxSortOrder.get();
        const sortOrder = (maxRow && maxRow.maxOrder != null) ? maxRow.maxOrder + 1 : 0;

        const newItem = {
            id: Date.now().toString(),
            name,
            term: name,
            terms,
            createdAt: new Date().toISOString(),
            lastRun: null,
            lastResultCount: null,
            active: true,
            emailNotify: true,
            priority: false,
            strict: data.strict !== false,
            filters: data.filters || [],
            enabledSites: data.enabledSites || { ...DEFAULT_ENABLED_SITES },
            siteOptions: data.siteOptions || { ...DEFAULT_SITE_OPTIONS },
            sortOrder
        };

        stmts.insert.run(itemToParams(newItem));
        return newItem;
    },

    update: async (id, updates) => {
        const item = await Watchlist.get(id);
        if (!item) return null;

        const updated = { ...item, ...updates };

        // Ensure consistency
        if (updated.terms && updated.terms.length > 0) {
            if (!updated.name) updated.name = updated.terms[0];
            updated.term = updated.name;
        }

        stmts.update.run(itemToParams(updated));
        return updated;
    },

    remove: async (id) => {
        const removeTransaction = db.transaction(() => {
            // Explicitly remove dependent rows for existing databases created
            // before foreign-key cascades were added to the schema.
            stmts.removeResults.run(id);
            stmts.removeResultsMeta.run(id);
            stmts.remove.run(id);
        });
        removeTransaction();
        return { success: true };
    },

    merge: async (ids, newName) => {
        const list = await Watchlist.getAll();
        const itemsToMerge = list.filter(i => ids.includes(i.id));

        if (itemsToMerge.length < 2) return null;

        // Collect all unique terms
        const allTerms = new Set();
        itemsToMerge.forEach(item => {
            if (item.terms) item.terms.forEach(t => allTerms.add(t));
            else if (item.term) allTerms.add(item.term);
        });

        const maxRow = stmts.maxSortOrder.get();
        const sortOrder = (maxRow && maxRow.maxOrder != null) ? maxRow.maxOrder + 1 : 0;

        const mergedItem = {
            id: Date.now().toString(),
            name: newName || itemsToMerge[0].name || itemsToMerge[0].term,
            term: newName || itemsToMerge[0].name || itemsToMerge[0].term,
            terms: Array.from(allTerms),
            createdAt: new Date().toISOString(),
            lastRun: null,
            lastResultCount: null,
            active: true,
            emailNotify: itemsToMerge.some(i => i.emailNotify),
            priority: false,
            strict: true,
            filters: [],
            enabledSites: { ...DEFAULT_ENABLED_SITES },
            siteOptions: { ...DEFAULT_SITE_OPTIONS },
            sortOrder
        };

        // Merge in a transaction: remove old, insert new
        const mergeTransaction = db.transaction(() => {
            for (const id of ids) {
                stmts.removeResults.run(id);
                stmts.removeResultsMeta.run(id);
                stmts.remove.run(id);
            }
            stmts.insert.run(itemToParams(mergedItem));
        });
        mergeTransaction();

        return mergedItem;
    },

    updateLastRun: async (id, resultCount = null) => {
        stmts.updateLastRun.run(new Date().toISOString(), resultCount, id);
    },

    toggleEmailNotify: async (id) => {
        const item = await Watchlist.get(id);
        if (!item) return null;
        const newState = !item.emailNotify;
        stmts.update.run(itemToParams({ ...item, emailNotify: newState }));
        return newState;
    },

    toggleActive: async (id) => {
        const item = await Watchlist.get(id);
        if (!item) return null;
        const current = item.active !== undefined ? item.active : true;
        const newState = !current;
        stmts.update.run(itemToParams({ ...item, active: newState }));
        return newState;
    },

    reorder: async (orderedIds) => {
        const reorderTransaction = db.transaction(() => {
            orderedIds.forEach((id, index) => {
                stmts.updateSortOrder.run(index, id);
            });
        });
        reorderTransaction();

        return await Watchlist.getAll();
    }
};

module.exports = Watchlist;
