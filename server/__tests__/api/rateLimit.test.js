
const request = require('supertest');
const { getTestDb, closeTestDb } = require('../testSetup');

// Mock scheduler
jest.mock('../../scheduler', () => ({
    start: jest.fn(),
    isRunning: false,
    progress: { current: 0, total: 0 },
    getResults: jest.fn().mockResolvedValue({ items: [] }),
    getNewCounts: jest.fn().mockResolvedValue({}),
    abort: jest.fn(),
    saveResults: jest.fn().mockReturnValue({ newItems: [], totalCount: 0 }),
    pruneResults: jest.fn(),
    clearNewFlags: jest.fn(),
    markAllSeen: jest.fn()
}));

// Mock scrapers
jest.mock('../../scrapers', () => ({
    searchAll: jest.fn().mockResolvedValue([])
}));

// Mock Watchlist model
jest.mock('../../models/watchlist', () => ({
    getAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({})
}));

// Mock Settings to bypass auth
jest.mock('../../models/settings', () => ({
    get: jest.fn().mockReturnValue({ loginEnabled: false }),
    update: jest.fn()
}));

let app;

describe('Rate Limits', () => {
    beforeAll(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        getTestDb();

        jest.isolateModules(() => {
            app = require('../../server');
        });
    });

    afterAll(async () => {
        closeTestDb();
        jest.restoreAllMocks();
    });

    it('should allow > 150 requests to generic endpoints (no global limiter)', async () => {
        const promises = [];
        // Hit a generic endpoint that is NOT login
        for (let i = 0; i < 150; i++) {
            promises.push(request(app).get('/api/watchlist'));
        }

        const responses = await Promise.all(promises);

        const tooManyRequests = responses.filter(res => res.status === 429);
        const okRequests = responses.filter(res => res.status === 200);

        expect(tooManyRequests.length).toBe(0);
        expect(okRequests.length).toBe(150);
    });

    it('should rate limit login endpoint after 5 requests', async () => {
        // We need to be careful with parallel requests and rate limiter consistency.
        // But express-rate-limit memory store is synchronous.
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(request(app).post('/api/login').send({ password: 'test' }));
        }

        const responses = await Promise.all(promises);

        const okRequests = responses.filter(res => res.status === 200); // 200 because loginEnabled: false returns success
        const rateLimitedRequests = responses.filter(res => res.status === 429);

        // We expect exactly 5 to pass and 5 to fail
        expect(okRequests.length).toBe(5);
        expect(rateLimitedRequests.length).toBe(5);
    });
});
