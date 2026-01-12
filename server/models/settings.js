const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    email: '',
    emailEnabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
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
    allowYahooInternationalShipping: false // Default to filtering out international shipping
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure settings file exists
if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
}

const Encryption = require('../utils/encryption');

const Settings = {
    get: () => {
        try {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
            // Decrypt sensitive fields
            if (parsed.smtpPass) {
                parsed.smtpPass = Encryption.decrypt(parsed.smtpPass);
            }
            if (parsed.loginPassword) {
                parsed.loginPassword = Encryption.decrypt(parsed.loginPassword);
            }
            return parsed;
        } catch (err) {
            console.error('Error reading settings:', err);
            return DEFAULT_SETTINGS;
        }
    },

    update: (newSettings) => {
        const current = Settings.get(); // this returns decrypted

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
            // If trying to enable (or keeping enabled) but no password exists or is being cleared
            // We force disable it to prevent lockout or insecure state, OR we could throw error.
            // Requirement: "If there is no valid password saved then the login screen will not be enabled."
            // So we silently set loginEnabled = false if password is missing.
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

        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toSave, null, 2));

        // Return decrypted version to the app/caller
        return updated;
    }
};

module.exports = Settings;
