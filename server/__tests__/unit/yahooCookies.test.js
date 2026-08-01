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

describe('Yahoo authenticated search routing', () => {
    test('bypasses Doorzo and sends Yahoo cookies only to native search', async () => {
        const nativeGet = jest.fn().mockResolvedValue({ data: '<html><body></body></html>' });
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
        await expect(yahoo.search('test', false, false, 'yahoo')).resolves.toEqual([]);

        expect(doorzoPost).not.toHaveBeenCalled();
        expect(nativeGet).toHaveBeenCalledWith(
            expect.stringContaining('/search/search?p=test'),
            expect.objectContaining({
                headers: { Cookie: 'A=auth-value' },
                beforeRedirect: expect.any(Function)
            })
        );
    });
});
