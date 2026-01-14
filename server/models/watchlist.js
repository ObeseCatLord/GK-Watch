const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure watchlist file exists
if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify([], null, 2));
}

const Watchlist = {
    getAll: () => {
        try {
            const data = fs.readFileSync(WATCHLIST_FILE, 'utf8');
            const list = JSON.parse(data);
            return list.map(item => {
                // Migration: Ensure 'terms' array exists
                const terms = Array.isArray(item.terms) ? item.terms : [item.term];
                return {
                    ...item,
                    terms: terms,
                    // effective 'term' for display/legacy is the name or the first term
                    term: item.name || terms[0] || item.term,
                    name: item.name || terms[0] || item.term,
                    emailNotify: item.emailNotify !== undefined ? item.emailNotify : true,
                    priority: item.priority === true, // Ensure boolean
                    strict: item.strict !== false,    // Default to true
                    filters: item.filters || [], // Per-watch filter terms
                    enabledSites: item.enabledSites || {
                        mercari: true,
                        yahoo: true,
                        paypay: true,
                        fril: true,
                        surugaya: true,
                        taobao: false
                    }
                };
            });
        } catch (err) {
            console.error('Error reading watchlist:', err);
            return [];
        }
    },

    get: (id) => {
        return Watchlist.getAll().find(i => i.id === id) || null;
    },

    add: (data) => {
        const list = Watchlist.getAll();
        // Support both simple string (legacy) and object with terms
        const terms = typeof data === 'string' ? [data] : (data.terms || [data.term]);
        const name = data.name || terms[0];

        // Check for duplicates
        // We consider it a duplicate if the sorted JSON string representation of terms matches
        // OR if the name matches (optional, but name/term is often 1:1)
        const normalizeTerms = (t) => JSON.stringify(t.slice().sort());
        const newTermsNorm = normalizeTerms(terms);

        const existing = list.find(item => {
            const itemTerms = Array.isArray(item.terms) ? item.terms : [item.term];
            return normalizeTerms(itemTerms) === newTermsNorm || item.name === name;
        });

        if (existing) {
            return existing; // Return existing item without adding a new one
        }

        const newItem = {
            id: Date.now().toString(),
            name,
            term: name, // legacy support
            terms,
            createdAt: new Date().toISOString(),
            lastRun: null,
            active: true,
            emailNotify: true,
            lastRun: null,
            active: true,
            emailNotify: true,
            strict: data.strict !== false, // Default to true
            filters: data.filters || [], // Persist filters if provided (e.g. from import)
            enabledSites: data.enabledSites || {
                mercari: true,
                yahoo: true,
                paypay: true,
                fril: true,
                surugaya: true,
                taobao: false
            }
        };
        list.push(newItem);
        fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
        return newItem;
    },

    update: (id, updates) => {
        const list = Watchlist.getAll();
        const index = list.findIndex(i => i.id === id);
        if (index !== -1) {
            list[index] = { ...list[index], ...updates };
            // Ensure consistency
            if (list[index].terms && list[index].terms.length > 0) {
                if (!list[index].name) list[index].name = list[index].terms[0];
                list[index].term = list[index].name;
            }
            fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
            return list[index];
        }
        return null;
    },

    remove: (id) => {
        let list = Watchlist.getAll();
        list = list.filter(item => item.id !== id);
        fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
        return { success: true };
    },

    merge: (ids, newName) => {
        const list = Watchlist.getAll();
        const itemsToMerge = list.filter(i => ids.includes(i.id));

        if (itemsToMerge.length < 2) return null;

        // Collect all unique terms
        const allTerms = new Set();
        itemsToMerge.forEach(item => {
            if (item.terms) item.terms.forEach(t => allTerms.add(t));
            else if (item.term) allTerms.add(item.term);
        });

        // Create new merged item
        const mergedItem = {
            id: Date.now().toString(),
            name: newName || itemsToMerge[0].name || itemsToMerge[0].term,
            term: newName || itemsToMerge[0].name || itemsToMerge[0].term,
            terms: Array.from(allTerms),
            createdAt: new Date().toISOString(),
            lastRun: null, // Reset last run since it's a new combo
            active: true,
            emailNotify: itemsToMerge.some(i => i.emailNotify) // True if any had it on
        };

        // Remove old items and add new one
        const remainingList = list.filter(i => !ids.includes(i.id));
        remainingList.push(mergedItem);

        fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(remainingList, null, 2));
        return mergedItem;
    },

    updateLastRun: (id) => {
        const list = Watchlist.getAll();
        const item = list.find(i => i.id === id);
        if (item) {
            item.lastRun = new Date().toISOString();
            fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
        }
    },

    toggleEmailNotify: (id) => {
        const list = Watchlist.getAll();
        const item = list.find(i => i.id === id);
        if (item) {
            item.emailNotify = !item.emailNotify;
            fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
            return item.emailNotify;
        }
        return null;
    },

    toggleActive: (id) => {
        const list = Watchlist.getAll();
        const item = list.find(i => i.id === id);
        if (item) {
            // If active is undefined, default to true, so toggle makes it false
            const current = item.active !== undefined ? item.active : true;
            item.active = !current;
            fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
            return item.active;
        }
        return null;
    },

    reorder: (orderedIds) => {
        const list = Watchlist.getAll();
        const reordered = [];

        // Add items in the new order
        for (const id of orderedIds) {
            const item = list.find(i => i.id === id);
            if (item) {
                reordered.push(item);
            }
        }

        // Add any items that weren't in orderedIds
        for (const item of list) {
            if (!orderedIds.includes(item.id)) {
                reordered.push(item);
            }
        }

        fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(reordered, null, 2));
        return reordered;
    }
};

module.exports = Watchlist;
