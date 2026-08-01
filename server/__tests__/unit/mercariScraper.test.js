
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
        mercariScraper.reset({ resetRateLimitCircuit: true });
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
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        // Fallback warnings
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        // One short retry distinguishes a transient response from a persistent limit.

        const results = await search('test query');

        expect(mock.history.post.length).toBe(2);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker opened'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('bypasses direct Axios while the rate-limit circuit breaker is open', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await search('first query');
        expect(mock.history.post).toHaveLength(2);

        mercariScraper.reset();
        await search('second query');
        expect(mock.history.post).toHaveLength(2);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker active'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('allows only one direct recovery probe after the cooldown', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await search('opens circuit');
        expect(mock.history.post).toHaveLength(2);

        const future = Date.now() + 16 * 60 * 1000;
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(future);
        mock.resetHandlers();
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [],
            meta: { nextPageToken: null }
        });
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        await Promise.all([
            search('probe one'),
            search('probe two'),
            search('probe three')
        ]);

        expect(mock.history.post).toHaveLength(3);
        expect(logSpy.mock.calls.filter(([message]) => String(message).includes('circuit breaker active'))).toHaveLength(2);

        await search('direct resumes');
        expect(mock.history.post).toHaveLength(4);

        dateSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('preserves direct results when a later page opens the circuit', async () => {
        let directCalls = 0;
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(() => {
            directCalls++;
            if (directCalls === 1) {
                return [200, {
                    items: [{ id: 'm444', name: 'test query item', price: '4000' }],
                    meta: { nextPageToken: 'page-two' }
                }];
            }
            return [429, {}];
        });
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        const results = await search('test query');
        expect(results).toHaveLength(1);
        expect(results[0].link).toBe('https://jp.mercari.com/item/m444');
        expect(mock.history.post).toHaveLength(3);
        expect(mock.history.get).toHaveLength(0);

        await search('circuit remains open');
        expect(mock.history.post).toHaveLength(3);
        expect(mock.history.get).toHaveLength(1);

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('does not extend the cooldown when a recovery probe is aborted', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await search('opens circuit');
        const future = Date.now() + 16 * 60 * 1000;
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(future);

        let releaseProbe;
        mock.resetHandlers();
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(() => new Promise(resolve => {
            releaseProbe = resolve;
        }));

        const controller = new AbortController();
        const probe = search('aborted probe', true, [], null, controller.signal);
        for (let attempt = 0; mock.history.post.length < 3 && attempt < 10; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        controller.abort();
        releaseProbe([200, { items: [], meta: { nextPageToken: null } }]);
        await expect(probe).rejects.toMatchObject({ code: 'ABORT_ERR' });

        mock.resetHandlers();
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [],
            meta: { nextPageToken: null }
        });
        await search('direct after abort');
        expect(mock.history.post).toHaveLength(4);

        dateSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('falls back to Doorzo before DEJapan and captures token pages', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});

        let doorzoCallCount = 0;
        mock.onGet('https://sig.doorzo.com/').reply(() => {
            doorzoCallCount++;
            if (doorzoCallCount === 1) {
                return [200, {
                    code: 0,
                    data: {
                        items: [{
                            ImageUrl: 'https://example.com/one.jpg',
                            Asin: 'm111',
                            Url: '',
                            Name: 'test query garage kit one',
                            JPYPrice: 1000
                        }],
                        nextPageToken: 'next-token'
                    }
                }];
            }

            return [200, {
                code: 0,
                data: {
                    items: [{
                        ImageUrl: 'https://example.com/two.jpg',
                        Asin: 'm222',
                        Url: '',
                        Name: 'test query garage kit two',
                        JPYPrice: 2000
                    }],
                    nextPageToken: null
                }
            }];
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        const results = await search('test query', true, []);

        expect(doorzoCallCount).toBe(2);
        expect(results).toHaveLength(2);
        expect(results.map(item => item.link)).toEqual([
            'https://jp.mercari.com/item/m111',
            'https://jp.mercari.com/item/m222'
        ]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to Doorzo'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Doorzo search successful'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('falls back from Doorzo to Neokyo before DEJapan', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mock.onGet('https://sig.doorzo.com/').reply(503, {});
        mock.onGet(/https:\/\/neokyo\.com\/en\/search\/mercari.*/).reply(200, `
            <div class="product-card">
                <a class="product-link" href="/en/product/mercari/m333">test query garage kit neokyo</a>
                <img class="card-img-top" src="https://example.com/neokyo.jpg" />
                <div class="price"><b>3,000 yen</b></div>
            </div>
        `);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        const results = await search('test query', true, []);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            title: 'test query garage kit neokyo',
            link: 'https://jp.mercari.com/item/m333',
            price: '¥3,000'
        });

        const requestedUrls = mock.history.get.map(request => request.url);
        expect(requestedUrls).toContain('https://sig.doorzo.com/');
        expect(requestedUrls.some(url => url.startsWith('https://neokyo.com/en/search/mercari'))).toBe(true);
        expect(requestedUrls.some(url => url.includes('dejapan.com/en/shopping/mercari'))).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to Neokyo'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Neokyo search successful'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
