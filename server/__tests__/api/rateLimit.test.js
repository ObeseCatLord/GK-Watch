
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

// Mock Settings to bypass auth if needed (though getTestDb creates default settings table, we might need to ensure loginEnabled is false)
jest.mock('../../models/settings', () => ({
    get: jest.fn().mockReturnValue({ loginEnabled: false }),
    update: jest.fn()
}));

let app;

describe('Rate Limiter', () => {
    beforeAll(() => {
        // Suppress console logs
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Initialize Test DB
        getTestDb();

        // Load app
        jest.isolateModules(() => {
            app = require('../../server');
        });
    });

    afterAll(async () => {
        closeTestDb();
        jest.restoreAllMocks();
    });

    it('should NOT rate limit /api/status endpoint (150 requests)', async () => {
        const promises = [];
        for (let i = 0; i < 150; i++) {
            promises.push(request(app).get('/api/status'));
        }

        const responses = await Promise.all(promises);

        const tooManyRequests = responses.filter(res => res.status === 429);
        const okRequests = responses.filter(res => res.status === 200);

        expect(tooManyRequests.length).toBe(0);
        expect(okRequests.length).toBe(150);
    });

    it('should NOT rate limit /api/auth-status endpoint (150 requests)', async () => {
         const promises = [];
        for (let i = 0; i < 150; i++) {
            promises.push(request(app).get('/api/auth-status'));
        }
        const responses = await Promise.all(promises);
        const tooManyRequests = responses.filter(res => res.status === 429);
        expect(tooManyRequests.length).toBe(0);
    });

    it('should rate limit other endpoints (e.g. /api/watchlist)', async () => {
        // We need to hit it > 100 times.
        // Since apiLimiter is shared, previous tests might have contributed if not for the skip?
        // No, skip prevents counting.
        // So we start from 0 for this path.

        const promises = [];
        for (let i = 0; i < 110; i++) {
            promises.push(request(app).get('/api/watchlist'));
        }

        const responses = await Promise.all(promises);
        const tooManyRequests = responses.filter(res => res.status === 429);

        // Should have at least some blocked
        expect(tooManyRequests.length).toBeGreaterThan(0);
    });
});
