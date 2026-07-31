const mockPuppeteerLaunch = jest.fn();

jest.mock('puppeteer', () => ({ launch: mockPuppeteerLaunch }));
jest.mock('../../utils/browserExecutable', () => ({ resolveBrowserExecutable: () => '/usr/bin/chromium' }));

const fs = require('fs');

describe('Goofish scraper lifecycle', () => {
    let Goofish;
    let existsSpy;
    let statSpy;
    let readSpy;
    let mkdirSpy;
    let rmSpy;

    beforeAll(() => {
        Goofish = require('../../scrapers/goofish');
    });

    beforeEach(() => {
        mockPuppeteerLaunch.mockReset();
        existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation(filePath => String(filePath).endsWith('goofish_cookies.json'));
        statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 1 });
        readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify([{ name: 'session', value: 'cookie', domain: '.goofish.com' }]));
        mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
        rmSpy = jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('closes each browser exactly once during overlapping searches', async () => {
        const browsers = [];
        mockPuppeteerLaunch.mockImplementation(() => {
            const index = browsers.length;
            const handlers = {};
            const page = {
                on: jest.fn((event, handler) => { handlers[event] = handler; }),
                setCookie: jest.fn(),
                setUserAgent: jest.fn(),
                setRequestInterception: jest.fn(),
                evaluate: jest.fn(),
                goto: jest.fn(async () => {
                    if (index === 0) await new Promise(resolve => setTimeout(resolve, 10));
                    await handlers.response({
                        url: () => 'https://example.test/mtop.taobao.idlemtopsearch.pc.search',
                        text: async () => JSON.stringify({
                            data: { items: [{ title: index === 0 ? 'alpha figure' : 'beta figure', itemId: String(index + 1), price: '100' }] }
                        })
                    });
                })
            };
            const browser = { newPage: jest.fn(async () => page), close: jest.fn(async () => undefined) };
            browsers.push(browser);
            return browser;
        });

        const [alpha, beta] = await Promise.all([
            Goofish.search('alpha', true),
            Goofish.search('beta', true)
        ]);

        expect(alpha).toHaveLength(1);
        expect(beta).toHaveLength(1);
        expect(browsers).toHaveLength(2);
        expect(browsers[0].close).toHaveBeenCalledTimes(1);
        expect(browsers[1].close).toHaveBeenCalledTimes(1);
        for (const [launchOptions] of mockPuppeteerLaunch.mock.calls) {
            expect(launchOptions.args).not.toContain('--no-sandbox');
            expect(launchOptions.args).not.toContain('--disable-setuid-sandbox');
        }
        expect(mkdirSpy).toHaveBeenCalled();
        expect(rmSpy).not.toHaveBeenCalled();
    });

    test('closes only the aborted search browser while navigation is in progress', async () => {
        let rejectGoto;
        const page = {
            on: jest.fn(),
            setCookie: jest.fn(),
            setUserAgent: jest.fn(),
            setRequestInterception: jest.fn(),
            goto: jest.fn(() => new Promise((_resolve, reject) => { rejectGoto = reject; }))
        };
        const browser = {
            newPage: jest.fn(async () => page),
            close: jest.fn(async () => { rejectGoto(new Error('Target closed')); })
        };
        mockPuppeteerLaunch.mockResolvedValue(browser);

        const controller = new AbortController();
        const search = Goofish.search('alpha', true, controller.signal);
        await new Promise(resolve => setImmediate(resolve));

        expect(page.goto).toHaveBeenCalledTimes(1);
        controller.abort();

        await expect(search).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
        expect(browser.close).toHaveBeenCalledTimes(1);
    });
});
