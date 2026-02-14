
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');
const mercariScraper = require('../../scrapers/mercari');
const { search } = mercariScraper;

// Mock callbacks
const onProgress = jest.fn();

describe('Mercari Scraper Retry Logic', () => {
    let mock;

    jest.setTimeout(30000); // Increase timeout for retries

    beforeAll(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        mock.reset();
        onProgress.mockClear();
    });

    afterAll(() => {
        mock.restore();
    });

    test('retries on 429 error and succeeds eventually', async () => {
        // Mock DPoP generation is internal and uses crypto, which works in Node.
        // We mock the HTTP endpoints.

        const searchResponse = {
            searchSessionId: 'test-session',
            items: [
                { id: 'm123', name: 'Test Query Item', price: '1000' }
            ],
            meta: {
                nextPageToken: null
            }
        };

        // First call fails with 429
        // Conditional reply: 429 first, then 200
        let callCount = 0;
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(() => {
            callCount++;
            if (callCount === 1) {
                return [429, {}];
            }
            return [200, searchResponse];
        });

        // Spy on console to check for retry logs
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        const results = await search('test query');

        // Assert
        expect(results).toBeDefined();
        // With strict mode on, it should still return the item because title matches query
        expect(results.length).toBe(1);
        expect(results[0].title).toBe('Test Query Item');

        // Verify we hit the endpoint twice
        expect(mock.history.post.length).toBe(2);

        // Verify retry log
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limited (429)'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('fails after max retries and falls back', async () => {
        // Always 429
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        // Fallback warnings
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        // Mock fallback to avoid real network or puppeteer
        // We can't easily mock internal imports unless we use jest.mock on the module itself
        // But since we are integration testing the file, we rely on it calling fallbacks.
        // Fallbacks will likely fail or timeout in this environment without mocks, 
        // but 'search' catches errors and returns [] eventually.

        // Just verify axios retries happened 4 times (1 + 3 retries)

        const results = await search('test query');

        // It consumes all retries, then throws, then catches and logs warning, then tries fallbacks...
        // We expect axios calls to be 4.
        expect(mock.history.post.length).toBeGreaterThanOrEqual(4);

        // FIXED: Expect the actual warning message
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Axios failed (returned null)'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
    });
});
