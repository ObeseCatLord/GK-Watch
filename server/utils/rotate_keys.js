const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const KEY_FILE = path.join(DATA_DIR, 'master.key');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ALGORITHM = 'aes-256-cbc';

// 1. Read existing key
let oldKey;
if (fs.existsSync(KEY_FILE)) {
    oldKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
    console.log('Found existing master key.');
} else {
    console.error('No master key found. Nothing to rotate.');
    process.exit(1);
}

// 2. Read settings and decrypt with OLD key
let settings = {};
if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function decrypt(text, key) {
    if (!text || !text.includes(':')) return text;
    try {
        const [ivHex, encryptedHex] = text.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return text;
    }
}

// Decrypt fields
const smtpPass = decrypt(settings.smtpPass, oldKey);
const loginPassword = decrypt(settings.loginPassword, oldKey);
console.log('Decrypted existing secrets successfully.');

// 3. Generate NEW key
const newKey = crypto.randomBytes(32);
const newKeyHex = newKey.toString('hex');

// 4. Encrypt with NEW key
function encrypt(text, key) {
    if (!text) return text;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
}

settings.smtpPass = encrypt(smtpPass, newKey);
settings.loginPassword = encrypt(loginPassword, newKey);

// 5. Save everything
// Save new key
fs.writeFileSync(KEY_FILE, newKeyHex);
console.log('Saved new master key.');

// Save new settings
fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
console.log('Saved re-encrypted settings.');

console.log('Secrets rotation complete!');
