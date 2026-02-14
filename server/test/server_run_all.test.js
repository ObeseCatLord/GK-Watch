
const request = require('supertest');
const app = require('../server'); // Adjust path as needed
const db = require('../models/database');
const Watchlist = require('../models/watchlist');
const Scheduler = require('../scheduler');

// Mock authentication middleware if needed, or use a test token
// For this test, we might need to mock requireAuth or obtain a valid token.
// Simplest is to mock the middleware in the app, but since app is already required, 
// we can use a valid token if we can generate one, or mock the db session lookup.

describe('Server Run All (Queue)', () => {
    let token;

    beforeAll(() => {
        // Setup a dummy session
        const stmt = db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)');
        token = 'test-token-run-all';
        stmt.run(token, Date.now() + 100000);

        // Mock Scheduler to avoid actual scraping
        jest.spyOn(Scheduler, 'runBatch').mockImplementation(async (items, type) => {
            return { success: true, count: items.length };
        });
    });

    afterAll(() => {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        jest.restoreAllMocks();
    });

    test('POST /api/run-now triggers batch run', async () => {
        const res = await request(app)
            .post('/api/run-now')
            .set('x-auth-token', token);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Scheduler.runBatch).toHaveBeenCalled();
    });

    test('POST /api/run-now returns 409 if already running', async () => {
        Scheduler.isRunning = true;

        const res = await request(app)
            .post('/api/run-now')
            .set('x-auth-token', token);

        expect(res.statusCode).toBe(409);

        Scheduler.isRunning = false; // Reset
    });
});
