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

const Blacklist = {
    getAll: () => {
        try {
            const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('Error reading blacklist:', err);
            return [];
        }
    },

    add: (term) => {
        const list = Blacklist.getAll();
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
        list.push(newItem);
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(list, null, 2));
        return newItem;
    },

    remove: (id) => {
        let list = Blacklist.getAll();
        list = list.filter(item => item.id !== id);
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(list, null, 2));
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
        return newList;
    },

    // Check if a title contains any blacklisted terms
    isBlacklisted: (title) => {
        if (!title) return false;
        const list = Blacklist.getAll();
        const titleLower = title.toLowerCase();
        return list.some(item => titleLower.includes(item.term.toLowerCase()));
    },

    // Filter results by blacklist terms
    filterResults: (results) => {
        const list = Blacklist.getAll();
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
