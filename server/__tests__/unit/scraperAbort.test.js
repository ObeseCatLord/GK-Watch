const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

describe('Mercari and Yahoo cancellation', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('Mercari passes the supplied signal to its Axios request', async () => {
        const mock = new MockAdapter(axios);
        const signal = new AbortController().signal;
        mock.onPost('https://api.mercari.jp/v2/entities:search').reply(200, {
            items: [],
            meta: { nextPageToken: null }
        });

        const mercari = require('../../scrapers/mercari');
        await mercari.search('test', false, [], null, signal);

        expect(mock.history.post).toHaveLength(1);
        expect(mock.history.post[0].signal).toBe(signal);
        mock.restore();
    });

    test('Yahoo passes the supplied signal to its primary Axios request', async () => {
        const mock = new MockAdapter(axios);
        const signal = new AbortController().signal;
        mock.onPost(/https:\/\/sig\.doorzo\.com\//).reply(200, {
            data: { list: [] }
        });

        const yahoo = require('../../scrapers/yahoo');
        await yahoo.search('test', false, false, 'yahoo', [], signal);

        expect(mock.history.post).toHaveLength(1);
        expect(mock.history.post[0].signal).toBe(signal);
        mock.restore();
    });

    test('Doorzo passes the supplied signal to its Axios request', async () => {
        const mock = new MockAdapter(axios);
        const signal = new AbortController().signal;
        mock.onGet('https://sig.doorzo.com/').reply(200, { data: { items: [] } });

        const doorzo = require('../../scrapers/doorzo');
        await doorzo.search('test', 'paypay', signal);

        expect(mock.history.get).toHaveLength(1);
        expect(mock.history.get[0].signal).toBe(signal);
        mock.restore();
    });

    test('DEJapan passes the supplied signal to its Axios request', async () => {
        const mock = new MockAdapter(axios);
        const signal = new AbortController().signal;
        mock.onGet(/dejapan\.com/).reply(200, '<html><title>No results</title><body></body></html>');

        const dejapan = require('../../scrapers/dejapan');
        await dejapan.search('test', false, [], signal);

        expect(mock.history.get).toHaveLength(1);
        expect(mock.history.get[0].signal).toBe(signal);
        mock.restore();
    });

    test('Mercari admits its native fallback to browserPool and closes only its search context on abort', async () => {
        const mockBrowserPoolRun = jest.fn((task, options) => task(options.signal));
        let rejectGoto;
        const mockPage = {
            close: jest.fn(async () => { rejectGoto(new Error('page closed')); }),
            setRequestInterception: jest.fn(async () => {}),
            on: jest.fn(),
            setUserAgent: jest.fn(async () => {}),
            setExtraHTTPHeaders: jest.fn(async () => {}),
            evaluateOnNewDocument: jest.fn(async () => {}),
            goto: jest.fn(() => new Promise((resolve, reject) => { rejectGoto = reject; }))
        };
        const mockContext = {
            close: jest.fn(async () => {}),
            newPage: jest.fn(async () => mockPage)
        };
        const mockBrowser = {
            close: jest.fn(async () => {}),
            createBrowserContext: jest.fn(async () => mockContext),
            isConnected: jest.fn(() => true)
        };
        const mockAxios = {
            get: jest.fn().mockRejectedValue(new Error('fallback unavailable')),
            post: jest.fn().mockRejectedValue(new Error('primary unavailable'))
        };

        jest.resetModules();
        jest.doMock('axios', () => mockAxios);
        jest.doMock('puppeteer', () => ({ launch: jest.fn(async () => mockBrowser) }));
        jest.doMock('../../utils/admissionControl', () => ({ browserPool: { run: mockBrowserPoolRun } }));
        jest.doMock('../../utils/browserExecutable', () => ({ resolveBrowserExecutable: jest.fn(() => undefined) }));
        jest.doMock('../../scrapers/doorzo', () => ({ search: jest.fn(async () => null) }));
        jest.doMock('../../scrapers/dejapan', () => ({ search: jest.fn(async () => null) }));

        const mercari = require('../../scrapers/mercari');
        const controller = new AbortController();
        const search = mercari.search('test', false, [], null, controller.signal);

        for (let attempt = 0; !mockPage.goto.mock.calls.length && attempt < 10; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(mockPage.goto).toHaveBeenCalled();
        controller.abort();

        await expect(search).rejects.toMatchObject({ code: 'ABORT_ERR' });
        expect(mockBrowserPoolRun).toHaveBeenCalledWith(expect.any(Function), { signal: controller.signal });
        expect(mockPage.close).toHaveBeenCalled();
        expect(mockContext.close).toHaveBeenCalled();
        expect(mockBrowser.close).not.toHaveBeenCalled();
    });

    test('Yahoo admits its browser fallback to browserPool and closes it on abort', async () => {
        const mockBrowserPoolRun = jest.fn((task, options) => task(options.signal));
        let rejectGoto;
        const mockPage = {
            close: jest.fn(async () => { rejectGoto(new Error('page closed')); }),
            setRequestInterception: jest.fn(async () => {}),
            on: jest.fn(),
            goto: jest.fn(() => new Promise((resolve, reject) => { rejectGoto = reject; }))
        };
        const mockBrowser = {
            close: jest.fn(async () => {}),
            newPage: jest.fn(async () => mockPage)
        };
        const mockClient = { get: jest.fn().mockRejectedValue(new Error('native unavailable')) };
        const mockAxios = {
            create: jest.fn(() => mockClient),
            get: jest.fn(),
            post: jest.fn().mockRejectedValue(new Error('doorzo unavailable'))
        };

        jest.resetModules();
        jest.doMock('axios', () => mockAxios);
        jest.doMock('axios-retry', () => ({ default: jest.fn() }));
        jest.doMock('bottleneck', () => class {
            wrap(task) { return task; }
        });
        jest.doMock('puppeteer', () => ({ launch: jest.fn(async () => mockBrowser) }));
        jest.doMock('../../utils/admissionControl', () => ({ browserPool: { run: mockBrowserPoolRun } }));
        jest.doMock('../../utils/browserExecutable', () => ({ resolveBrowserExecutable: jest.fn(() => undefined) }));

        const yahoo = require('../../scrapers/yahoo');
        const controller = new AbortController();
        const search = yahoo.search('test', false, false, 'yahoo', [], controller.signal);

        for (let attempt = 0; !mockPage.goto.mock.calls.length && attempt < 10; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(mockPage.goto).toHaveBeenCalled();
        controller.abort();

        await expect(search).rejects.toMatchObject({ code: 'ABORT_ERR' });
        expect(mockBrowserPoolRun).toHaveBeenCalledWith(expect.any(Function), { signal: controller.signal });
        expect(mockPage.close).toHaveBeenCalled();
        expect(mockBrowser.close).toHaveBeenCalled();
    });
});
