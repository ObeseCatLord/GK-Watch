const crypto = require('crypto');
const db = require('./database');
const Encryption = require('../utils/encryption');

const DEFAULT_SETTINGS = {
    email: '', emailEnabled: false, smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
    baseUrl: 'http://localhost:5173', loginEnabled: false, loginPassword: '',
    ntfyEnabled: false, ntfyTopic: '', ntfyServer: 'https://ntfy.sh',
    enabledSites: { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: false, goofish: false, mandarake: false },
    strictFiltering: { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: true, goofish: true, mandarake: true },
    allowYahooInternationalShipping: false,
    concurrency: 3
};

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const SITE_KEYS = new Set(Object.keys(DEFAULT_SETTINGS.enabledSites));
const NTFY_ALLOWED_ORIGINS = new Set(['https://ntfy.sh', ...(process.env.NTFY_ALLOWED_ORIGINS || '').split(',')]
    .map(value => {
        try {
            const url = new URL(value.trim());
            return url.protocol === 'https:' ? url.origin : null;
        } catch (_) { return null; }
    })
    .filter(Boolean));
const getAllSettings = db.prepare('SELECT key, value FROM settings');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const revokeSessions = db.prepare('DELETE FROM sessions');
let cachedSettings = null;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, key, maxLength = 2048) {
    if (typeof value !== 'string' || value.length > maxLength || /[\r\n]/.test(value)) {
        throw new Error(`${key} must be a valid string`);
    }
    return value;
}

function validateHttpUrl(value, key, { httpsOnly = false } = {}) {
    const text = requireString(value, key, 2048);
    let url;
    try { url = new URL(text); } catch (_) { throw new Error(`${key} must be a valid URL`); }
    if ((httpsOnly && url.protocol !== 'https:') || (!httpsOnly && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password) {
        throw new Error(`${key} must use ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} without credentials`);
    }
    return url.toString().replace(/\/$/, '');
}

function validateSiteMap(value, key) {
    if (!isPlainObject(value)) throw new Error(`${key} must be an object`);
    const normalized = {};
    for (const [site, enabled] of Object.entries(value)) {
        if (!SITE_KEYS.has(site) || typeof enabled !== 'boolean') throw new Error(`${key} contains an invalid site setting`);
        normalized[site] = enabled;
    }
    return normalized;
}

function hashPassword(password) {
    const cost = 16384;
    const salt = crypto.randomBytes(16);
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 32, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, hash) => {
            if (error) return reject(error);
            resolve(`scrypt$${cost}$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`);
        });
    });
}

function verifyPbkdf2Hash(password, encoded) {
    const [algorithm, iterationText, saltText, hashText] = String(encoded).split('$');
    const iterations = Number(iterationText);
    if (algorithm !== 'pbkdf2-sha512' || !Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 || !saltText || !hashText) return false;
    try {
        const expected = Buffer.from(hashText, 'base64url');
        const actual = crypto.pbkdf2Sync(password, Buffer.from(saltText, 'base64url'), iterations, expected.length, 'sha512');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) {
        return false;
    }
}

function verifyScryptHash(password, encoded) {
    const [algorithm, costText, blockSizeText, parallelText, saltText, hashText] = String(encoded).split('$');
    const cost = Number(costText);
    const blockSize = Number(blockSizeText);
    const parallel = Number(parallelText);
    if (algorithm !== 'scrypt' || cost !== 16384 || blockSize !== 8 || parallel !== 1 || !saltText || !hashText) return Promise.resolve(false);
    const expected = Buffer.from(hashText, 'base64url');
    return new Promise(resolve => {
        crypto.scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, { N: cost, r: blockSize, p: parallel, maxmem: 64 * 1024 * 1024 }, (error, actual) => {
            resolve(!error && expected.length === actual.length && crypto.timingSafeEqual(expected, actual));
        });
    });
}

function isPasswordHash(value) {
    return String(value).startsWith('scrypt$') || String(value).startsWith('pbkdf2-sha512$');
}

function safeLegacyCompare(password, legacyPassword) {
    const input = Buffer.from(password, 'utf8');
    const stored = Buffer.from(legacyPassword, 'utf8');
    const length = Math.max(input.length, stored.length, 1);
    const paddedInput = Buffer.alloc(length);
    const paddedStored = Buffer.alloc(length);
    input.copy(paddedInput);
    stored.copy(paddedStored);
    return input.length === stored.length && crypto.timingSafeEqual(paddedInput, paddedStored);
}

function publicSettings(settings) {
    const { loginPassword, smtpPass, ...safe } = settings;
    return { ...safe, loginPassword: null, smtpPass: null, hasLoginPassword: !!loginPassword || safe.hasLoginPassword === true, hasSmtpPass: !!smtpPass || safe.hasSmtpPass === true };
}

function validateUpdate(input) {
    if (!isPlainObject(input)) throw new Error('Settings payload must be an object');
    const validated = {};
    for (const [key, value] of Object.entries(input)) {
        if (!SETTING_KEYS.has(key)) throw new Error(`Unknown setting: ${key}`);
        switch (key) {
        case 'email':
            validated.email = requireString(value, key, 254);
            if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('email must be a valid email address');
            break;
        case 'emailEnabled': case 'loginEnabled': case 'ntfyEnabled': case 'allowYahooInternationalShipping':
            if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
            validated[key] = value;
            break;
        case 'smtpHost': validated.smtpHost = requireString(value, key, 253); break;
        case 'smtpUser': validated.smtpUser = requireString(value, key, 254); break;
        case 'smtpPass': validated.smtpPass = requireString(value, key, 4096); break;
        case 'smtpPort':
            if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('smtpPort must be an integer from 1 to 65535');
            validated.smtpPort = value; break;
        case 'baseUrl': validated.baseUrl = validateHttpUrl(value, key); break;
        case 'ntfyServer': {
            const server = validateHttpUrl(value, key, { httpsOnly: true });
            if (!NTFY_ALLOWED_ORIGINS.has(new URL(server).origin)) throw new Error('ntfyServer origin is not allowlisted');
            validated.ntfyServer = server;
            break;
        }
        case 'ntfyTopic': validated.ntfyTopic = requireString(value, key, 128); break;
        case 'loginPassword':
            validated.loginPassword = requireString(value, key, 1024);
            if (value && value.length < 12) throw new Error('Password must be at least 12 characters long');
            break;
        case 'concurrency':
            if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('concurrency must be an integer from 1 to 5');
            validated.concurrency = value; break;
        case 'enabledSites': case 'strictFiltering': validated[key] = validateSiteMap(value, key); break;
        default: throw new Error(`Unsupported setting: ${key}`);
        }
    }
    return validated;
}

const Settings = {
    get: () => {
        if (cachedSettings) return { ...cachedSettings, enabledSites: { ...cachedSettings.enabledSites }, strictFiltering: { ...cachedSettings.strictFiltering } };
        const stored = {};
        try {
            for (const row of getAllSettings.all()) {
                if (!SETTING_KEYS.has(row.key)) continue;
                try { stored[row.key] = JSON.parse(row.value); } catch (_) { stored[row.key] = row.value; }
            }
        } catch (error) {
            console.error('Error reading settings:', error.message);
        }
        const parsed = {
            ...DEFAULT_SETTINGS, ...stored,
            enabledSites: { ...DEFAULT_SETTINGS.enabledSites, ...(isPlainObject(stored.enabledSites) ? stored.enabledSites : {}) },
            strictFiltering: { ...DEFAULT_SETTINGS.strictFiltering, ...(isPlainObject(stored.strictFiltering) ? stored.strictFiltering : {}) }
        };
        for (const secret of ['smtpPass', 'loginPassword']) {
            if (parsed[secret] && !(secret === 'loginPassword' && isPasswordHash(parsed[secret]))) {
                try { parsed[secret] = Encryption.decrypt(parsed[secret]); }
                catch (error) { console.error(`Stored ${secret} is unusable:`, error.message); parsed[secret] = ''; }
            }
        }
        cachedSettings = parsed;
        return Settings.get();
    },

    update: async (newSettings) => {
        const input = validateUpdate(newSettings);
        const current = Settings.get();
        const updated = {
            ...current, ...input,
            enabledSites: input.enabledSites ? { ...current.enabledSites, ...input.enabledSites } : current.enabledSites,
            strictFiltering: input.strictFiltering ? { ...current.strictFiltering, ...input.strictFiltering } : current.strictFiltering
        };
        if (Object.prototype.hasOwnProperty.call(input, 'loginPassword')) updated.loginPassword = input.loginPassword ? await hashPassword(input.loginPassword) : '';
        if (updated.loginEnabled && !updated.loginPassword) updated.loginEnabled = false;

        const passwordChanged = Object.prototype.hasOwnProperty.call(input, 'loginPassword') || (input.loginEnabled === false && current.loginEnabled);
        const toSave = { ...updated, smtpPass: updated.smtpPass ? Encryption.encrypt(updated.smtpPass) : '' };
        const saveAll = db.transaction(() => {
            for (const [key, value] of Object.entries(toSave)) upsertSetting.run(key, JSON.stringify(value));
            if (passwordChanged) revokeSessions.run();
        });
        saveAll();
        cachedSettings = updated;
        return publicSettings(updated);
    },

    verifyLoginPassword: async (password) => {
        if (typeof password !== 'string') return false;
        const storedPassword = Settings.get().loginPassword;
        if (!storedPassword) return false;
        if (storedPassword.startsWith('scrypt$')) return verifyScryptHash(password, storedPassword);
        if (storedPassword.startsWith('pbkdf2-sha512$')) return verifyPbkdf2Hash(password, storedPassword);
        const matched = safeLegacyCompare(password, storedPassword);
        if (matched) {
            const migratedHash = await hashPassword(password);
            db.transaction(() => {
                upsertSetting.run('loginPassword', JSON.stringify(migratedHash));
                revokeSessions.run();
            })();
            cachedSettings = { ...Settings.get(), loginPassword: migratedHash };
        }
        return matched;
    },

    toPublic: publicSettings,
    _resetCache: () => { cachedSettings = null; }
};

module.exports = Settings;
