const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const KEY_FILE = path.join(DATA_DIR, 'master.key');
const ALGORITHM = 'aes-256-cbc';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Get or create master key
function getMasterKey() {
    if (fs.existsSync(KEY_FILE)) {
        return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('hex'));
    return key;
}

const key = getMasterKey();

const Encryption = {
    encrypt: (text) => {
        if (!text) return text;
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString('hex')}:${encrypted}`;
    },

    decrypt: (text) => {
        if (!text) return text;
        // Check if it looks encrypted (has IV separator)
        if (!text.includes(':')) return text; // Return as-is if not encrypted (migration support)

        try {
            const [ivHex, encryptedHex] = text.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (err) {
            console.error('Decryption failed:', err);
            return text; // Return original if decryption fails
        }
    }
};

module.exports = Encryption;
