const db = require('./database');

const Encryption = require('../utils/encryption');

const DEFAULT_SETTINGS = {
    email: '',
    emailEnabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    baseUrl: 'http://localhost:5173',
    loginEnabled: false,
    loginPassword: '',
    ntfyEnabled: false,
    ntfyTopic: '',
    ntfyServer: 'https://ntfy.sh',
    enabledSites: {
        mercari: true,
        yahoo: true,
        paypay: true,
        fril: true,
        surugaya: true,
        taobao: false
    },
    strictFiltering: {
        mercari: true,
        yahoo: true,
        paypay: true,
        fril: true,
        surugaya: true,
        taobao: true
    },
    allowYahooInternationalShipping: false,
    concurrency: 3
};

// Prepared statements
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const getAllSettings = db.prepare('SELECT key, value FROM settings');

let cachedSettings = null;

const Settings = {
    get: () => {
        if (cachedSettings) {
            return { ...cachedSettings };
        }

        try {
            const rows = getAllSettings.all();
            const stored = {};
            for (const row of rows) {
                try {
                    stored[row.key] = JSON.parse(row.value);
                } catch (e) {
                    stored[row.key] = row.value;
                }
            }

            const parsed = { ...DEFAULT_SETTINGS, ...stored };

            // Decrypt sensitive fields
            if (parsed.smtpPass) {
                parsed.smtpPass = Encryption.decrypt(parsed.smtpPass);
            }
            if (parsed.loginPassword) {
                parsed.loginPassword = Encryption.decrypt(parsed.loginPassword);
            }

            cachedSettings = parsed;
            return { ...parsed };
        } catch (err) {
            console.error('Error reading settings:', err);
            cachedSettings = { ...DEFAULT_SETTINGS };
            return { ...DEFAULT_SETTINGS };
        }
    },

    update: async (newSettings) => {
        const current = Settings.get(); // returns decrypted

        // Validation: Password length
        if (newSettings.loginPassword !== undefined) {
            if (newSettings.loginPassword.length > 0 && newSettings.loginPassword.length < 5) {
                throw new Error('Password must be at least 5 characters long');
            }
        }

        // Validation: Cannot enable login without a password
        const effectivelyEnabled = newSettings.loginEnabled !== undefined ? newSettings.loginEnabled : current.loginEnabled;
        const effectivePassword = newSettings.loginPassword !== undefined ? newSettings.loginPassword : current.loginPassword;

        if (effectivelyEnabled && !effectivePassword) {
            newSettings.loginEnabled = false;
        }

        const updated = { ...current, ...newSettings };

        // Encrypt sensitive fields before saving
        const toSave = { ...updated };
        if (toSave.smtpPass) {
            toSave.smtpPass = Encryption.encrypt(toSave.smtpPass);
        }
        if (toSave.loginPassword) {
            toSave.loginPassword = Encryption.encrypt(toSave.loginPassword);
        }

        // Save each key-value pair to the database
        const saveAll = db.transaction(() => {
            for (const [key, value] of Object.entries(toSave)) {
                upsertSetting.run(key, JSON.stringify(value));
            }
        });
        saveAll();

        // Update cache with the new decrypted state
        cachedSettings = updated;

        return updated;
    }
};

module.exports = Settings;
