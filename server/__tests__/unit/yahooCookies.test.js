const {
    cookiesToHeader,
    getSearchStrategy,
    hasValidCookies,
    isUsableYahooCookie,
    stripCookieOnUnsafeRedirect
} = require('../../scrapers/yahoo');

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const pastExpiry = Math.floor(Date.now() / 1000) - 3600;

describe('Yahoo cookie handling', () => {
    test('selects authenticated native search only for a valid Yahoo auth cookie', () => {
        expect(getSearchStrategy([
            { name: 'A', value: 'session-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ])).toBe('authenticated-native');

        expect(getSearchStrategy([
            { name: 'B', value: 'analytics-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ])).toBe('doorzo-first');
        expect(getSearchStrategy(null)).toBe('doorzo-first');
        expect(getSearchStrategy(null, { mode: 'live' })).toBe('native-first');
        expect(getSearchStrategy([
            { name: 'A', value: 'session-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ], { mode: 'live' })).toBe('authenticated-native');
    });

    test('accepts Yahoo session cookies and rejects expired or foreign cookies', () => {
        expect(isUsableYahooCookie({
            name: 'T', value: 'session-value', domain: 'auctions.yahoo.co.jp', expirationDate: null
        })).toBe(true);
        expect(hasValidCookies([
            { name: 'T', value: 'session-value', domain: '.yahoo.co.jp', expirationDate: pastExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: 'session-value', domain: '.example.com', expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: 'session-value', domain: 'login.yahoo.co.jp', hostOnly: true, expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: 'session-value', domain: '.yahoo.co.jp', path: '/account', expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: '', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: 'session-value', domain: 'co.jp', expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'a', value: 'session-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ])).toBe(false);
        expect(hasValidCookies([
            { name: 'A', value: 'session-value', domain: '.yahoo.co.jp', expirationDate: 'not-a-date' }
        ])).toBe(false);
    });

    test('builds a header only from safe, unexpired Yahoo cookies', () => {
        const header = cookiesToHeader([
            { name: 'A', value: 'auth-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry },
            { name: 'Y', value: 'prefs-value', domain: 'auctions.yahoo.co.jp' },
            { name: 'expired', value: 'old', domain: '.yahoo.co.jp', expirationDate: pastExpiry },
            { name: 'foreign', value: 'secret', domain: '.example.com', expirationDate: futureExpiry },
            { name: 'unsafe', value: 'one; injected=two', domain: '.yahoo.co.jp', expirationDate: futureExpiry }
        ]);

        expect(header).toBe('A=auth-value; Y=prefs-value');
        expect(header).not.toContain('secret');
        expect(header).not.toContain('injected');
    });

    test('removes cookies from redirects to a different hostname', () => {
        const crossHost = { hostname: 'login.yahoo.co.jp', protocol: 'https:', headers: { Cookie: 'A=auth-value', Accept: 'text/html' } };
        stripCookieOnUnsafeRedirect(crossHost);
        expect(crossHost.headers).toEqual({ Accept: 'text/html' });

        const insecure = { hostname: 'auctions.yahoo.co.jp', protocol: 'http:', headers: { Cookie: 'A=auth-value' } };
        stripCookieOnUnsafeRedirect(insecure);
        expect(insecure.headers).toEqual({});

        const sameHost = { hostname: 'auctions.yahoo.co.jp', protocol: 'https:', headers: { Cookie: 'A=auth-value' } };
        stripCookieOnUnsafeRedirect(sameHost);
        expect(sameHost.headers.Cookie).toBe('A=auth-value');
    });
});

describe('Yahoo live/watch provider routing', () => {
    function loadYahoo({ nativeGet, doorzoPost, cookies = null, realBottleneck = false }) {
        const retry = jest.fn();
        retry.exponentialDelay = jest.fn(() => 100);
        retry.isNetworkOrIdempotentRequestError = jest.fn(() => false);

        jest.resetModules();
        jest.doMock('axios', () => ({
            create: jest.fn(() => ({ get: nativeGet })),
            post: doorzoPost,
            get: jest.fn()
        }));
        jest.doMock('axios-retry', () => ({ default: retry }));
        if (realBottleneck) {
            jest.dontMock('bottleneck');
        } else {
            jest.doMock('bottleneck', () => class {
                wrap(task) { return task; }
            });
        }
        jest.doMock('puppeteer', () => ({ launch: jest.fn() }));
        jest.doMock('fs', () => ({
            ...jest.requireActual('fs'),
            accessSync: jest.fn(() => {
                if (cookies) return;
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            }),
            readFileSync: jest.fn(() => JSON.stringify(cookies || []))
        }));

        return { yahoo: require('../../scrapers/yahoo'), retry };
    }

    test('keeps cookie-free watch searches on Doorzo', async () => {
        const nativeGet = jest.fn();
        const doorzoPost = jest.fn().mockResolvedValue({ data: { data: { list: [] } } });
        const { yahoo } = loadYahoo({ nativeGet, doorzoPost });

        await expect(yahoo.search('test', false, false, 'yahoo', [], null, { mode: 'watch' })).resolves.toEqual([]);

        expect(doorzoPost).toHaveBeenCalledTimes(1);
        expect(nativeGet).not.toHaveBeenCalled();
    });

    test('uses native Yahoo first for cookie-free live searches', async () => {
        const nativeGet = jest.fn().mockResolvedValue({
            status: 200,
            data: '<ul class="Products__items"><li class="Product"><a class="Product__titleLink" href="https://auctions.yahoo.co.jp/jp/auction/live1">live item</a><span class="Product__priceValue">500円</span></li></ul>'
        });
        const doorzoPost = jest.fn();
        const { yahoo, retry } = loadYahoo({ nativeGet, doorzoPost });

        await expect(yahoo.search('test', false, false, 'yahoo', [], null, { mode: 'live' })).resolves.toEqual([
            expect.objectContaining({ title: 'live item', price: '¥500' })
        ]);

        expect(nativeGet).toHaveBeenCalledTimes(1);
        expect(doorzoPost).not.toHaveBeenCalled();
        expect(retry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            retries: 2,
            shouldResetTimeout: true
        }));
    });

    test('keeps authenticated watch searches native after another term times out', async () => {
        const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
        const nativeGet = jest.fn().mockRejectedValue(timeout);
        const doorzoPost = jest.fn().mockResolvedValue({ data: { data: { list: [] } } });
        const cookies = [{ name: 'A', value: 'auth-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry }];
        const { yahoo } = loadYahoo({ nativeGet, doorzoPost, cookies });

        await expect(yahoo.search('first', false, false, 'yahoo', [], null, { mode: 'watch' })).resolves.toEqual([]);
        await expect(yahoo.search('second', false, false, 'yahoo', [], null, { mode: 'watch' })).resolves.toEqual([]);

        expect(nativeGet).toHaveBeenCalledTimes(2);
        expect(nativeGet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            headers: { Cookie: 'A=auth-value' }
        }));
        expect(doorzoPost).toHaveBeenCalledTimes(2);
        expect(yahoo.getNativeState()).toMatchObject({
            cooldown: false,
            cooldownReason: null,
            maxConcurrent: 4
        });
    });

    test('opens native cooldown only for a definite Yahoo challenge response', async () => {
        const blocked = Object.assign(new Error('Request failed with status code 500'), {
            response: { status: 500, data: '<html>しばらく時間をおいてから再度お試しください</html>' }
        });
        const nativeGet = jest.fn().mockRejectedValue(blocked);
        const doorzoPost = jest.fn().mockResolvedValue({ data: { data: { list: [] } } });
        const { yahoo } = loadYahoo({ nativeGet, doorzoPost });

        await expect(yahoo.search('first', false, false, 'yahoo', [], null, { mode: 'live' })).resolves.toEqual([]);
        await expect(yahoo.search('second', false, false, 'yahoo', [], null, { mode: 'live' })).resolves.toEqual([]);

        expect(nativeGet).toHaveBeenCalledTimes(1);
        expect(doorzoPost).toHaveBeenCalledTimes(2);
        expect(yahoo.getNativeState()).toMatchObject({ cooldown: true });
    });

    test('stops queued native searches when one concurrent request is blocked', async () => {
        const releases = [];
        const nativeGet = jest.fn().mockImplementation(() => new Promise(resolve => {
            releases.push(resolve);
        }));
        const doorzoPost = jest.fn().mockResolvedValue({ data: { data: { list: [] } } });
        const { yahoo } = loadYahoo({ nativeGet, doorzoPost, realBottleneck: true });

        const searches = Array.from({ length: 5 }, (_, index) =>
            yahoo.search(`term-${index}`, false, false, 'yahoo', [], null, { mode: 'live' })
        );
        while (nativeGet.mock.calls.length < 4) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        releases[0]({
            status: 500,
            data: '<html>しばらく時間をおいてから再度お試しください</html>'
        });
        const product = '<ul class="Products__items"><li class="Product"><a class="Product__titleLink" href="https://auctions.yahoo.co.jp/jp/auction/concurrent1">item</a><span class="Product__priceValue">100円</span></li></ul>';
        for (const release of releases.slice(1)) release({ status: 200, data: product });

        const results = await Promise.all(searches);
        expect(results[0]).toEqual([]);
        expect(results.slice(1, 4)).toEqual([
            [expect.objectContaining({ title: 'item' })],
            [expect.objectContaining({ title: 'item' })],
            [expect.objectContaining({ title: 'item' })]
        ]);
        expect(results[4]).toEqual([]);
        expect(nativeGet).toHaveBeenCalledTimes(4);
        expect(doorzoPost).toHaveBeenCalledTimes(2);
        expect(yahoo.getNativeState()).toMatchObject({ cooldown: true, maxConcurrent: 4 });
    }, 10000);
});

describe('Yahoo authenticated search routing', () => {
    test('searches adult and standard scopes directly while deduplicating Yahoo results', async () => {
        const product = `
            <li class="Product">
                <a class="Product__titleLink" href="https://auctions.yahoo.co.jp/jp/auction/test123">test item</a>
                <span class="Product__priceValue">100円</span>
            </li>`;
        const nativeGet = jest.fn()
            .mockResolvedValueOnce({ data: `<ul class="Products__items">${product}${product}</ul>` })
            .mockResolvedValueOnce({ data: '<html><body>お探しのページは見つかりませんでした</body></html>' });
        const doorzoPost = jest.fn();
        const retry = jest.fn();
        retry.exponentialDelay = jest.fn();
        retry.isNetworkOrIdempotentRequestError = jest.fn(() => false);

        jest.resetModules();
        jest.doMock('axios', () => ({
            create: jest.fn(() => ({ get: nativeGet })),
            post: doorzoPost
        }));
        jest.doMock('axios-retry', () => ({ default: retry }));
        jest.doMock('bottleneck', () => class {
            wrap(task) { return task; }
        });
        jest.doMock('puppeteer', () => ({ launch: jest.fn() }));
        jest.doMock('fs', () => ({
            ...jest.requireActual('fs'),
            accessSync: jest.fn(),
            readFileSync: jest.fn(() => JSON.stringify([
                { name: 'A', value: 'auth-value', domain: '.yahoo.co.jp', expirationDate: futureExpiry },
                { name: 'foreign', value: 'secret', domain: '.example.com', expirationDate: futureExpiry }
            ]))
        }));

        const yahoo = require('../../scrapers/yahoo');
        await expect(yahoo.search('test', false, false, 'yahoo')).resolves.toEqual([
            expect.objectContaining({
                title: 'test item',
                link: 'https://auctions.yahoo.co.jp/jp/auction/test123',
                price: '¥100'
            })
        ]);

        expect(doorzoPost).not.toHaveBeenCalled();
        expect(nativeGet).toHaveBeenNthCalledWith(
            1,
            expect.stringMatching(/\/search\/search\?p=test.*auccat=26146/),
            expect.objectContaining({
                headers: { Cookie: 'A=auth-value' },
                beforeRedirect: expect.any(Function)
            })
        );
        expect(nativeGet).toHaveBeenNthCalledWith(
            2,
            expect.not.stringContaining('auccat=26146'),
            expect.objectContaining({ headers: { Cookie: 'A=auth-value' } })
        );
    });
});
