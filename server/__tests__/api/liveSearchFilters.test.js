
const request = require('supertest');
const mockSearchAll = jest.fn();

// Mock the dependencies BEFORE requiring the app
jest.mock('../../scrapers', () => ({
    searchAll: mockSearchAll,
    // Add other exports if needed to prevent crashes
    hasValidCookies: () => true
}));

// Mock database to prevent actual DB connection/writes during test load
jest.mock('../../models/database', () => ({
    prepare: () => ({ run: () => { }, get: () => { } }),
    transaction: callback => callback,
    pragma: () => { },
    exec: () => { }
}));

// Mock Settings to avoid DB read and allow auth bypass
jest.mock('../../models/settings', () => ({
    get: () => ({
        loginEnabled: false, // Bypass auth for tests
        enabledHours: []
    })
}));

// Mock BlockedItems & Blacklist (optional, but good for isolation)
jest.mock('../../models/blocked_items', () => ({
    filterResults: (items) => items
}));
jest.mock('../../models/blacklist', () => ({
    getAll: () => [], // No global filters for this test
    filterResults: (items) => items
}));

// Mock Scheduler to prevent cron jobs starting
jest.mock('../../scheduler', () => ({
    start: jest.fn(),
    isRunning: false,
    progress: null,
    completionVersion: 12
}));

const app = require('../../server');

describe('Live Search Filters API', () => {
    beforeEach(() => {
        mockSearchAll.mockClear();
        // Default mock implementation to return empty array
        mockSearchAll.mockResolvedValue([]);
    });

    test('status exposes the scheduler completion version', async () => {
        const response = await request(app).get('/api/status');

        expect(response.status).toBe(200);
        expect(response.body.completionVersion).toBe(12);
    });

    test('parses comma-separated filters correctly', async () => {
        // GET /api/search?q=test&filters=foo,bar
        const response = await request(app).get('/api/search?q=test&filters=foo,bar');

        expect(response.status).toBe(200);
        // Verify searchAll was called with filters=['foo', 'bar']
        // searchAll(query, enabledOverride, strict, filters, onProgress, siteOptions)
        expect(mockSearchAll).toHaveBeenCalledWith(
            'test',
            null,
            true,
            expect.arrayContaining(['foo', 'bar']),
            null,
            {}
        );
    });

    test('parses array format filters correctly', async () => {
        // GET /api/search?q=test&filters[]=foo&filters[]=bar
        // Supertest handles array params slightly differently or standard URL encoding
        const response = await request(app)
            .get('/api/search')
            .query({ q: 'test', filters: ['foo', 'bar'] });

        expect(response.status).toBe(200);
        expect(mockSearchAll).toHaveBeenCalledWith(
            'test',
            null,
            true,
            expect.arrayContaining(['foo', 'bar']),
            null,
            {}
        );
    });

    test('handles single filter string', async () => {
        const response = await request(app).get('/api/search?q=test&filters=foo');
        expect(mockSearchAll).toHaveBeenCalledWith(
            'test',
            null,
            true,
            ['foo'],
            null,
            {}
        );
    });

    test('ignores empty filters', async () => {
        const response = await request(app).get('/api/search?q=test&filters=foo,,bar, ');
        expect(mockSearchAll).toHaveBeenCalledWith(
            'test',
            null,
            true,
            expect.arrayContaining(['foo', 'bar']),
            null,
            {}
        );
        // Should not contain empty string
        const calls = mockSearchAll.mock.calls[0];
        const filters = calls[3];
        expect(filters).toHaveLength(2);
    });

    test('passes Mandarake garage-kit mode to scraper options', async () => {
        const response = await request(app).get('/api/search?q=test&sites=mandarake&mandarakeMode=garageKit');

        expect(response.status).toBe(200);
        expect(mockSearchAll).toHaveBeenCalledWith(
            'test',
            expect.objectContaining({ mandarake: true }),
            true,
            [],
            null,
            { mandarake: { mode: 'garageKit' } }
        );
    });

    test('passes an AbortSignal to live SSE searches', async () => {
        const response = await request(app)
            .get('/api/search?q=test')
            .set('Accept', 'text/event-stream');

        expect(response.status).toBe(200);
        const signal = mockSearchAll.mock.calls[0][6];
        expect(signal).toBeDefined();
        expect(typeof signal.addEventListener).toBe('function');
        expect(signal.aborted).toBe(false);
    });
});
