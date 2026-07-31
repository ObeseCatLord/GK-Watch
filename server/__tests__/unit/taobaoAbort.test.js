const mockPuppeteerLaunch = jest.fn();

jest.mock('puppeteer', () => ({ launch: mockPuppeteerLaunch }));
jest.mock('../../utils/browserExecutable', () => ({ resolveBrowserExecutable: () => '/usr/bin/chromium' }));

const fs = require('fs');
const taobao = require('../../scrapers/taobao');

describe('Taobao scraper abort support', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        mockPuppeteerLaunch.mockReset();
    });

    test('closes its page and context without closing the shared browser', async () => {
        let rejectGoto;
        const page = {
            setCookie: jest.fn(),
            setRequestInterception: jest.fn(),
            on: jest.fn(),
            setUserAgent: jest.fn(),
            setExtraHTTPHeaders: jest.fn(),
            evaluateOnNewDocument: jest.fn(),
            goto: jest.fn(() => new Promise((_resolve, reject) => { rejectGoto = reject; })),
            close: jest.fn(async () => { rejectGoto(new Error('Target closed')); })
        };
        const context = {
            newPage: jest.fn(async () => page),
            close: jest.fn(async () => undefined)
        };
        const browser = {
            isConnected: jest.fn(() => true),
            createBrowserContext: jest.fn(async () => context),
            close: jest.fn(async () => undefined)
        };
        mockPuppeteerLaunch.mockResolvedValue(browser);
        jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 1 });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify([
            { name: 'session', value: 'cookie', domain: '.taobao.com' }
        ]));

        const controller = new AbortController();
        const search = taobao.search('alpha', true, controller.signal);
        await new Promise(resolve => setImmediate(resolve));

        expect(page.goto).toHaveBeenCalledTimes(1);
        controller.abort();

        await expect(search).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
        expect(page.close).toHaveBeenCalledTimes(1);
        expect(context.close).toHaveBeenCalledTimes(1);
        expect(browser.close).not.toHaveBeenCalled();
    });
});
