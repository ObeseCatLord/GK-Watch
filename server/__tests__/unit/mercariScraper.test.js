
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

    const mockDoorzoFailure = () => mock.onGet('https://sig.doorzo.com/').reply(503, {});
    const mockEmptyNeokyo = () => mock.onGet(/https:\/\/neokyo\.com\/en\/search\/mercari.*/).reply(200, '<html></html>');

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
        mockDoorzoFailure();

        // Spy on console to check for retry logs
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

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
        errorSpy.mockRestore();
    });

    test('uses a newest-first native pass when Doorzo returns no items', async () => {
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 200,
            data: { items: null, nextPageToken: null }
        });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [{ id: 'm999', name: 'test query native item', price: '1000' }],
            meta: { nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const results = await search('test query');

        expect(results.map(item => item.link)).toEqual(['https://jp.mercari.com/item/m999']);
        expect(mock.history.post).toHaveLength(1);
        expect(JSON.parse(mock.history.post[0].data).searchCondition.sort).toBe('SORT_CREATED_TIME');
        expect(mock.history.post[0].timeout).toBe(3000);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Freshness merge successful'));

        logSpy.mockRestore();
    });

    test('merges native freshness results that Doorzo omits and deduplicates overlaps', async () => {
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: {
                items: [{ Asin: 'm111', Name: 'test query shared item', JPYPrice: 1000 }],
                nextPageToken: null
            }
        });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [
                { id: 'm111', name: 'test query shared item', price: '1000' },
                { id: 'm85302349482', name: 'test query native-only item', price: '16800' }
            ],
            meta: { nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const results = await search('test query', true, [], onProgress);

        expect(results.map(item => item.link)).toEqual([
            'https://jp.mercari.com/item/m111',
            'https://jp.mercari.com/item/m85302349482'
        ]);
        expect(onProgress.mock.calls.flatMap(([event]) => event.items.map(item => item.link))).toEqual([
            'https://jp.mercari.com/item/m111',
            'https://jp.mercari.com/item/m85302349482'
        ]);

        logSpy.mockRestore();
    });

    test('bounds the native freshness pass to two pages', async () => {
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });
        let page = 0;
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(() => {
            page++;
            return [200, {
                items: [{ id: 'm1', name: 'test query repeated item', price: '1000' }],
                meta: { nextPageToken: `page-${page + 1}` }
            }];
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const results = await search('test query', true, [], onProgress);

        expect(mock.history.post).toHaveLength(2);
        expect(results).toHaveLength(1);
        expect(onProgress.mock.calls.flatMap(([event]) => event.items.map(item => item.link)))
            .toEqual(['https://jp.mercari.com/item/m1']);
        expect(mock.history.post.map(request => JSON.parse(request.data).searchCondition.sort))
            .toEqual(['SORT_CREATED_TIME', 'SORT_CREATED_TIME']);

        logSpy.mockRestore();
    });

    test('bounds a closed-circuit burst to the freshness admission limit', async () => {
        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: { items: [], nextPageToken: null }
        });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => search(`test query ${index}`)));

        expect(results).toEqual(Array.from({ length: 8 }, () => []));
        expect(mock.history.post.length).toBeGreaterThan(0);
        expect(mock.history.post.length).toBeLessThanOrEqual(4);

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('starts Doorzo and the native freshness pass concurrently', async () => {
        let releaseDoorzo;
        let releaseDirect;
        mock.onGet('https://sig.doorzo.com/').reply(() => new Promise(resolve => {
            releaseDoorzo = resolve;
        }));
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(() => new Promise(resolve => {
            releaseDirect = resolve;
        }));

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const pending = search('test query');
        for (let attempt = 0; (!releaseDoorzo || !releaseDirect) && attempt < 50; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }

        expect(releaseDoorzo).toBeDefined();
        expect(releaseDirect).toBeDefined();
        releaseDoorzo([200, { code: 0, data: { items: [], nextPageToken: null } }]);
        releaseDirect([200, { items: [], meta: { nextPageToken: null } }]);
        await expect(pending).resolves.toEqual([]);

        logSpy.mockRestore();
    });

    test('returns Doorzo results when the freshness queue exceeds its deadline', async () => {
        const { mercariFreshnessPool } = require('../../utils/admissionControl');
        const releases = [];
        const blockers = Array.from({ length: 2 }, () => mercariFreshnessPool.run(() => new Promise(resolve => {
            releases.push(resolve);
        })));
        for (let attempt = 0; releases.length < 2 && attempt < 20; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(releases).toHaveLength(2);

        mock.onGet('https://sig.doorzo.com/').reply(200, {
            code: 0,
            data: {
                items: [{ Asin: 'm111', Name: 'test query Doorzo item', JPYPrice: 1000 }],
                nextPageToken: null
            }
        });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [{ id: 'm999', name: 'test query late native item', price: '1000' }],
            meta: { nextPageToken: null }
        });

        jest.useFakeTimers();
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const pending = search('test query');
            await Promise.resolve();
            jest.advanceTimersByTime(4000);
            const results = await pending;

            expect(results.map(item => item.link)).toEqual(['https://jp.mercari.com/item/m111']);
            expect(mock.history.post).toHaveLength(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Freshness pass exceeded 4000ms'));
        } finally {
            jest.useRealTimers();
            releases.forEach(resolve => resolve());
            await Promise.all(blockers);
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    test('deduplicates repeated Doorzo pages before streaming progress', async () => {
        let page = 0;
        mock.onGet('https://sig.doorzo.com/').reply(() => {
            page++;
            return [200, {
                code: 0,
                data: {
                    items: [{ Asin: 'm111', Name: 'test query repeated Doorzo item', JPYPrice: 1000 }],
                    nextPageToken: page === 1 ? 'next-page' : null
                }
            }];
        });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [],
            meta: { nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const results = await search('test query', true, [], onProgress);

        expect(results.map(item => item.link)).toEqual(['https://jp.mercari.com/item/m111']);
        expect(onProgress.mock.calls.flatMap(([event]) => event.items.map(item => item.link)))
            .toEqual(['https://jp.mercari.com/item/m111']);

        logSpy.mockRestore();
    });

    test('falls back to direct Axios for a malformed Doorzo API response', async () => {
        mock.onGet('https://sig.doorzo.com/').reply(200, { code: 123, data: {} });
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [{ id: 'm998', name: 'test query direct item', price: '1200' }],
            meta: { nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const results = await search('test query');

        expect(results).toHaveLength(1);
        expect(results[0].link).toBe('https://jp.mercari.com/item/m998');
        expect(mock.history.post).toHaveLength(1);
        expect(JSON.parse(mock.history.post[0].data).searchCondition.sort).toBe('SORT_CREATED_TIME');

        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('does not enter another fallback when an in-flight Doorzo search is aborted', async () => {
        let releaseDoorzo;
        mock.onGet('https://sig.doorzo.com/').reply(() => new Promise(resolve => {
            releaseDoorzo = resolve;
        }));
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [{ id: 'm997', name: 'must not be fetched', price: '1000' }],
            meta: { nextPageToken: null }
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const controller = new AbortController();
        const pending = search('test query', true, [], null, controller.signal);
        for (let attempt = 0; mock.history.get.length === 0 && attempt < 10; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        controller.abort();
        releaseDoorzo([200, { code: 0, data: { items: [], nextPageToken: null } }]);

        await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
        expect(mock.history.get.filter(request => request.url.startsWith('https://neokyo.com/'))).toHaveLength(0);

        logSpy.mockRestore();
    });

    test('fails after max retries and falls back', async () => {
        // Always 429
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mockDoorzoFailure();
        mockEmptyNeokyo();

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        // Fallback warnings
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        // One short retry distinguishes a transient response from a persistent limit.

        const results = await search('test query');

        expect(mock.history.post.length).toBe(2);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker opened'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('bypasses direct Axios while the rate-limit circuit breaker is open', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mockDoorzoFailure();
        mockEmptyNeokyo();

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
        mockDoorzoFailure();
        mockEmptyNeokyo();

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
        mockDoorzoFailure();
        mockEmptyNeokyo();

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
        mockDoorzoFailure();
        mockEmptyNeokyo();

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        const results = await search('test query');
        expect(results).toHaveLength(1);
        expect(results[0].link).toBe('https://jp.mercari.com/item/m444');
        expect(mock.history.post).toHaveLength(3);
        expect(mock.history.get.filter(request => request.url.startsWith('https://neokyo.com/'))).toHaveLength(0);

        await search('circuit remains open');
        expect(mock.history.post).toHaveLength(3);
        expect(mock.history.get.filter(request => request.url === 'https://sig.doorzo.com/')).toHaveLength(2);
        expect(mock.history.get.filter(request => request.url.startsWith('https://neokyo.com/'))).toHaveLength(1);

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('does not extend the cooldown when a recovery probe is aborted', async () => {
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(429, {});
        mockDoorzoFailure();
        mockEmptyNeokyo();

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        await search('opens circuit');
        const future = Date.now() + 16 * 60 * 1000;
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(future);

        let releaseProbe;
        mock.resetHandlers();
        mockDoorzoFailure();
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
        mockDoorzoFailure();
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

    test('retains Doorzo token pages when the native freshness pass is rate limited', async () => {
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

        const results = await search('test query', true, [], onProgress);

        expect(doorzoCallCount).toBe(2);
        expect(results).toHaveLength(2);
        expect(results.map(item => item.link)).toEqual([
            'https://jp.mercari.com/item/m111',
            'https://jp.mercari.com/item/m222'
        ]);
        expect(mock.history.post).toHaveLength(2);
        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress.mock.calls.flatMap(([event]) => event.items.map(item => item.link))).toEqual([
            'https://jp.mercari.com/item/m111',
            'https://jp.mercari.com/item/m222'
        ]);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Freshness merge successful'));

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
        expect(mock.history.post).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to Neokyo'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Neokyo search successful'));

        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
