const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure blacklist file exists
if (!fs.existsSync(BLACKLIST_FILE)) {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([], null, 2));
}

let blacklistCache = null;

const loadCache = () => {
    if (blacklistCache) return blacklistCache;
    try {
        const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
        blacklistCache = JSON.parse(data);
    } catch (err) {
        console.error('Error reading blacklist:', err);
        blacklistCache = [];
    }
    return blacklistCache;
};

const Blacklist = {
    getAll: () => {
        const list = loadCache();
        return [...list]; // Return shallow copy to prevent mutation
    },

    add: (term) => {
        const list = loadCache();
        const normalized = term.trim().toLowerCase();

        // Check if already exists
        if (list.some(item => item.term.toLowerCase() === normalized)) {
            return null;
        }

        const newItem = {
            id: Date.now().toString(),
            term: term.trim(),
            addedAt: new Date().toISOString()
        };

        // Update file first, then cache
        const newList = [...list, newItem];
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(newList, null, 2));
        blacklistCache = newList;

        return newItem;
    },

    remove: (id) => {
        const list = loadCache();
        const newList = list.filter(item => item.id !== id);

        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(newList, null, 2));
        blacklistCache = newList;

        return { success: true };
    },

    replaceAll: (terms) => {
        // Terms is an array of strings
        if (!Array.isArray(terms)) return { error: 'Terms must be an array' };

        const newList = terms
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .filter((val, index, self) => self.indexOf(val) === index) // Unique
            .map(term => ({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                term: term,
                addedAt: new Date().toISOString()
            }));

        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(newList, null, 2));
        blacklistCache = newList;

        return newList;
    },

    // Check if a title contains any blacklisted terms
    isBlacklisted: (title) => {
        if (!title) return false;
        const list = loadCache();
        const titleLower = title.toLowerCase();
        return list.some(item => titleLower.includes(item.term.toLowerCase()));
    },

    // Filter results by blacklist terms
    filterResults: (results) => {
        const list = loadCache();
        if (list.length === 0) return results;

        const blacklistTerms = list.map(item => item.term.toLowerCase());
        return results.filter(item => {
            if (!item.title) return false; // Filter out items without titles safely
            const titleLower = item.title.toLowerCase();
            return !blacklistTerms.some(term => titleLower.includes(term));
        });
    }
};

module.exports = Blacklist;
