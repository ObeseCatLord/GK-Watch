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

const BlockedItems = {
    getAll: () => {
        try {
            const data = fs.readFileSync(BLOCKED_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('Error reading blocked items:', err);
            return [];
        }
    },

    add: (url, title) => {
        const list = BlockedItems.getAll();
        // Check if already blocked
        if (list.some(item => item.url === url)) {
            return null;
        }

        const newItem = {
            id: Date.now().toString(),
            url,
            title,
            blockedAt: new Date().toISOString()
        };
        list.push(newItem);
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2));
        return newItem;
    },

    remove: (id) => {
        let list = BlockedItems.getAll();
        list = list.filter(item => item.id !== id);
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2));
        return { success: true };
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
