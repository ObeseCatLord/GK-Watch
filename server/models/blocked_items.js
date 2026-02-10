const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked_items.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure blocked file exists
if (!fs.existsSync(BLOCKED_FILE)) {
    fs.writeFileSync(BLOCKED_FILE, JSON.stringify([], null, 2));
}

let cachedItems = null;

const BlockedItems = {
    getAll: () => {
        if (cachedItems) {
            return [...cachedItems];
        }

        try {
            const data = fs.readFileSync(BLOCKED_FILE, 'utf8');
            cachedItems = JSON.parse(data);
            return [...cachedItems];
        } catch (err) {
            console.error('Error reading blocked items:', err);
            cachedItems = [];
            return [];
        }
    },

    add: (url, title, image) => {
        const list = BlockedItems.getAll(); // Uses cache if available
        // Check if already blocked
        if (list.some(item => item.url === url)) {
            return null;
        }

        const newItem = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            url,
            title,
            image: image || '',
            blockedAt: new Date().toISOString()
        };
        list.push(newItem);

        try {
            fs.writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2));
            cachedItems = list; // Update cache
            return newItem;
        } catch (err) {
            console.error('Error writing blocked items:', err);
            return null;
        }
    },

    remove: (id) => {
        let list = BlockedItems.getAll(); // Uses cache if available
        const initialLength = list.length;
        list = list.filter(item => item.id !== id);

        if (list.length === initialLength) {
            return { success: false, error: 'Item not found' };
        }

        try {
            fs.writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2));
            cachedItems = list; // Update cache
            return { success: true };
        } catch (err) {
            console.error('Error writing blocked items:', err);
            return { success: false, error: err.message };
        }
    },

    isBlocked: (url) => {
        const list = BlockedItems.getAll();
        return list.some(item => item.url === url);
    },

    // Helper to filter a list of results
    filterResults: (results) => {
        const list = BlockedItems.getAll();
        const blockedUrls = new Set(list.map(i => i.url));
        return results.filter(item => !blockedUrls.has(item.link));
    }
};

module.exports = BlockedItems;
