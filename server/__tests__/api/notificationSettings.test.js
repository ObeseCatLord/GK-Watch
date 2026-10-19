const request = require('supertest');
const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

jest.mock('../../scrapers', () => ({}));
jest.mock('../../scrapers/yahoo', () => ({ hasValidCookies: () => false }));
jest.mock('../../scheduler', () => ({ start: jest.fn(), isRunning: false }));
jest.mock('../../emailService', () => ({ sendTestEmail: jest.fn() }));

let app;
let db;
let Settings;
let EmailService;

beforeAll(() => {
    db = getTestDb();
    app = require('../../server');
    Settings = require('../../models/settings');
    EmailService = require('../../emailService');
});

beforeEach(() => {
    clearTestDb();
    Settings._resetCache();
    jest.clearAllMocks();
});

afterAll(() => closeTestDb());

test('round-trips legacy settings, replaces email and SMTP server, and tests the persisted replacement', async () => {
    await Settings.update({ email: 'old@example.com', smtpHost: 'old.example.com', smtpPass: 'existing-secret' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('smtpPort', JSON.stringify('465'));
    Settings._resetCache();

    const loaded = await request(app).get('/api/settings');
    expect(loaded.status).toBe(200);
    expect(loaded.body.smtpPort).toBe(465);
    const saved = await request(app).post('/api/settings').send({
        ...loaded.body, email: 'new@example.com', smtpHost: 'new.example.com'
    });
    expect(saved.status).toBe(200);
    Settings._resetCache();
    const reloaded = await request(app).get('/api/settings');
    expect(reloaded.body).toMatchObject({ email: 'new@example.com', smtpHost: 'new.example.com', smtpPort: 465, hasSmtpPass: true, smtpPass: null });
    expect(Settings.get().smtpPass).toBe('existing-secret');

    EmailService.sendTestEmail.mockImplementation(async () => {
        expect(Settings.get()).toMatchObject({ email: 'new@example.com', smtpHost: 'new.example.com', smtpPort: 465 });
        return { success: true };
    });
    const tested = await request(app).post('/api/settings/test-email');
    expect(tested.status).toBe(200);
    expect(tested.body.success).toBe(true);
    expect(EmailService.sendTestEmail).toHaveBeenCalledTimes(1);
});
