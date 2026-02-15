
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

describe('No Rate Limits', () => {
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

    it('should allow > 150 requests to any endpoint (no global limiter)', async () => {
        const promises = [];
        // Hit a generic endpoint that was previously rate limited
        for (let i = 0; i < 150; i++) {
            promises.push(request(app).get('/api/watchlist'));
        }

        const responses = await Promise.all(promises);

        const tooManyRequests = responses.filter(res => res.status === 429);
        const okRequests = responses.filter(res => res.status === 200);

        expect(tooManyRequests.length).toBe(0);
        expect(okRequests.length).toBe(150);
    });

    it('should allow > 20 requests to login endpoint (no login limiter)', async () => {
        const promises = [];
        for (let i = 0; i < 20; i++) {
            promises.push(request(app).post('/api/login').send({ password: 'test' }));
        }

        const responses = await Promise.all(promises);
        const tooManyRequests = responses.filter(res => res.status === 429);

        expect(tooManyRequests.length).toBe(0);
    });
});
