/**
 * Integration Tests: Settings Model
 * 
 * Tests the Settings model against an isolated test database.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let db;
let Settings;

beforeAll(() => {
    db = getTestDb();
    Settings = require('../../models/settings');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    // Reset the internal cache
    Settings._resetCache();
});

describe('Settings', () => {
    describe('get', () => {
        test('returns default settings on fresh database', () => {
            const settings = Settings.get();
            expect(settings).toBeDefined();
            expect(settings.emailEnabled).toBe(false);
            expect(settings.loginEnabled).toBe(false);
            expect(settings.smtpPort).toBe(587);
            expect(settings.ntfyServer).toBe('https://ntfy.sh');
        });

        test('returns enabledSites defaults', () => {
            const settings = Settings.get();
            expect(settings.enabledSites).toBeDefined();
            expect(settings.enabledSites.mercari).toBe(true);
            expect(settings.enabledSites.yahoo).toBe(true);
            expect(settings.enabledSites.taobao).toBe(false);
            expect(settings.enabledSites.mandarake).toBe(false);
            expect(settings.strictFiltering.mandarake).toBe(true);
        });

        test('includes concurrency setting (from PR #39)', () => {
            const settings = Settings.get();
            expect(settings.concurrency).toBe(3);
        });

        test('returns a copy (not a reference to cache)', () => {
            const s1 = Settings.get();
            const s2 = Settings.get();
            s1.emailEnabled = true;
            expect(s2.emailEnabled).toBe(false);
        });

        test('normalizes a legacy numeric smtp port string without mutating it on read', async () => {
            await Settings.update({
                smtpPass: 'legacy-mail-secret',
                smtpUser: 'mailer',
                emailEnabled: true,
                enabledSites: { mercari: false },
                strictFiltering: { yahoo: false }
            });
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('smtpPort', JSON.stringify('2525'));
            Settings._resetCache();

            const legacy = Settings.get();
            expect(legacy.smtpPort).toBe(2525);
            expect(legacy.smtpPass).toBe('legacy-mail-secret');
            expect(legacy.enabledSites.mercari).toBe(false);
            expect(legacy.strictFiltering.yahoo).toBe(false);
            expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('smtpPort').value).toBe(JSON.stringify('2525'));

            await Settings.update({ ...legacy, email: 'legacy@example.com', smtpHost: 'smtp.example.com' });
            Settings._resetCache();

            const reloaded = Settings.get();
            expect(reloaded.smtpPort).toBe(2525);
            expect(reloaded.email).toBe('legacy@example.com');
            expect(reloaded.smtpHost).toBe('smtp.example.com');
            expect(reloaded.smtpPass).toBe('legacy-mail-secret');
            expect(reloaded.enabledSites.mercari).toBe(false);
            expect(reloaded.strictFiltering.yahoo).toBe(false);
        });

        test.each(['0', '65536', '587.0', '-587', 'not-a-port'])('leaves invalid stored smtp port %p unchanged', (smtpPort) => {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('smtpPort', JSON.stringify(smtpPort));
            Settings._resetCache();

            expect(Settings.get().smtpPort).toBe(smtpPort);
        });
    });

    describe('update', () => {
        test('updates and persists a simple setting', async () => {
            await Settings.update({ emailEnabled: true });
            const settings = Settings.get();
            expect(settings.emailEnabled).toBe(true);
        });

        test('updates concurrency setting', async () => {
            await Settings.update({ concurrency: 5 });
            const settings = Settings.get();
            expect(settings.concurrency).toBe(5);
        });

        test('preserves existing settings when updating one field', async () => {
            await Settings.update({ emailEnabled: true });
            const settings = Settings.get();
            expect(settings.emailEnabled).toBe(true);
            expect(settings.smtpPort).toBe(587);
        });

        test('encrypts smtpPass at rest', async () => {
            await Settings.update({ smtpPass: 'my_secret_password' });

            const settings = Settings.get();
            expect(settings.smtpPass).toBe('my_secret_password');

            // Check raw DB value is NOT plaintext
            const db = require('../../models/database');
            const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtpPass');
            expect(raw).toBeDefined();
            const rawValue = JSON.parse(raw.value);
            expect(rawValue).not.toBe('my_secret_password');
            expect(rawValue).toContain(':'); // IV:ciphertext format
        });

        test('hashes loginPassword at rest and verifies it without exposing plaintext', async () => {
            await Settings.update({ loginPassword: 'secure_pass_123' });
            const settings = Settings.get();
            expect(settings.loginPassword).toMatch(/^scrypt\$/);
            expect(settings.loginPassword).not.toContain('secure_pass_123');
            await expect(Settings.verifyLoginPassword('secure_pass_123')).resolves.toBe(true);
            await expect(Settings.verifyLoginPassword('wrong-password')).resolves.toBe(false);
        });

        test('rejects short passwords', async () => {
            await expect(Settings.update({ loginPassword: 'ab' }))
                .rejects.toThrow('Password must be at least 12 characters long');
        });

        test('disables login if password is empty', async () => {
            await Settings.update({ loginEnabled: true, loginPassword: 'valid-password-123' });
            await Settings.update({ loginEnabled: true, loginPassword: '' });
            const settings = Settings.get();
            expect(settings.loginEnabled).toBe(false);
        });

        test('handles nested objects (enabledSites)', async () => {
            await Settings.update({
                enabledSites: {
                    mercari: false,
                    yahoo: true,
                    paypay: false,
                    fril: true,
                    surugaya: false,
                    taobao: false
                }
            });
            const settings = Settings.get();
            expect(settings.enabledSites.mercari).toBe(false);
            expect(settings.enabledSites.yahoo).toBe(true);
            expect(settings.enabledSites.surugaya).toBe(false);
            expect(settings.enabledSites.mandarake).toBe(false);
        });

        test('rejects unknown settings and invalid concurrency', async () => {
            await expect(Settings.update({ unexpected: true })).rejects.toThrow('Unknown setting');
            await expect(Settings.update({ concurrency: 6 })).rejects.toThrow('concurrency');
            await expect(Settings.update({ concurrency: 1.5 })).rejects.toThrow('concurrency');
        });

        test.each(['587', '0', '65536', '587.0'])('rejects string smtp port %p in updates', async (smtpPort) => {
            await expect(Settings.update({ smtpPort })).rejects.toThrow('smtpPort must be an integer from 1 to 65535');
        });

        test('rejects non-HTTPS and non-allowlisted ntfy origins', async () => {
            await expect(Settings.update({ ntfyServer: 'http://ntfy.sh' })).rejects.toThrow('HTTPS');
            await expect(Settings.update({ ntfyServer: 'https://example.com' })).rejects.toThrow('allowlisted');
        });

        test('never returns recoverable credentials from a settings update', async () => {
            const updated = await Settings.update({ smtpPass: 'mail-secret', loginPassword: 'login-secret' });
            expect(updated.smtpPass).toBeNull();
            expect(updated.loginPassword).toBeNull();
            expect(updated.hasSmtpPass).toBe(true);
            expect(updated.hasLoginPassword).toBe(true);
        });
    });
});
