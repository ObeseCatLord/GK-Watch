const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const KEY_FILE = path.join(DATA_DIR, 'master.key');
const LEGACY_ALGORITHM = 'aes-256-cbc';
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v2';

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
// Tighten pre-existing paths too; process umask alone is not sufficient for a key directory.
fs.chmodSync(DATA_DIR, 0o700);

function parseKey(value, source) {
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        throw new Error(`${source} must be a 32-byte hexadecimal key`);
    }
    return Buffer.from(value, 'hex');
}

function getMasterKey() {
    if (process.env.GK_MASTER_KEY) {
        return parseKey(process.env.GK_MASTER_KEY, 'GK_MASTER_KEY');
    }
    if (fs.existsSync(KEY_FILE)) {
        fs.chmodSync(KEY_FILE, 0o600);
        return parseKey(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'master.key');
    }

    const generatedKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, generatedKey.toString('hex'), { mode: 0o600 });
    return generatedKey;
}

const key = getMasterKey();

function isHex(value, bytes) {
    return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

const Encryption = {
    encrypt: (text) => {
        if (!text) return text;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    },

    decrypt: (text) => {
        if (!text) return text;
        if (typeof text !== 'string') {
            throw new Error('Encrypted value must be a string');
        }

        const parts = text.split(':');
        try {
            if (parts[0] === VERSION) {
                const [, ivHex, tagHex, encryptedHex] = parts;
                if (parts.length !== 4 || !isHex(ivHex, 12) || !isHex(tagHex, 16) || !/^[0-9a-f]+$/i.test(encryptedHex || '')) {
                    throw new Error('Invalid authenticated encrypted value');
                }
                const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
                decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
                return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
            }

            // Read legacy AES-CBC values only to migrate existing installations. New writes use GCM.
            if (parts.length === 2) {
                const [ivHex, encryptedHex] = parts;
                if (!isHex(ivHex, 16) || !/^[0-9a-f]+$/i.test(encryptedHex || '')) {
                    throw new Error('Invalid legacy encrypted value');
                }
                const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
                return decipher.update(encryptedHex, 'hex', 'utf8') + decipher.final('utf8');
            }

            // Plaintext was used before encryption existed. It remains readable solely for migration.
            if (!text.includes(':')) return text;
            throw new Error('Unsupported encrypted value version');
        } catch (error) {
            // Never return ciphertext as if it were a usable secret.
            throw new Error(`Unable to decrypt stored secret: ${error.message}`);
        }
    }
};

module.exports = Encryption;
