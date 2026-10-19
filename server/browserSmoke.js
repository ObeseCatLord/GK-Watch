'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { resolveBrowserExecutable } = require('./utils/browserExecutable');

async function main() {
    // Load the actual scraper modules through Node, rather than Jest's mocks.
    for (const name of ['mercari', 'yahoo', 'taobao', 'goofish']) {
        assert.equal(typeof require(`./scrapers/${name}`).search, 'function');
    }

    // Snap browsers have a private /tmp; use a shared, owned directory so Node
    // can remove the profiles after the browser exits.
    const directory = fs.mkdtempSync(path.join(os.homedir(), 'gkwatch-browser-smoke-'));
    const server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<html><body><article class="listing"><a href="/item/1">Example kit</a><span class="price">1000</span></article></body></html>');
    });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const url = `http://127.0.0.1:${server.address().port}`;
        const executablePath = resolveBrowserExecutable();
        const configurations = [
            { name: 'mercari', pipe: true, isolated: true },
            { name: 'yahoo', pipe: false, isolated: false },
            { name: 'taobao', pipe: true, isolated: true },
            { name: 'goofish', pipe: true, isolated: false }
        ];
        for (const configuration of configurations) {
            let browser;
            try {
                browser = await puppeteer.launch({
                    headless: true,
                    executablePath,
                    pipe: configuration.pipe,
                    userDataDir: path.join(directory, configuration.name),
                    args: ['--disable-dev-shm-usage', '--disable-gpu'],
                    timeout: 20000
                });
                const context = configuration.isolated ? await browser.createBrowserContext() : browser.defaultBrowserContext();
                const page = await context.newPage();
                await page.setCookie({ name: 'fixture', value: 'local-only', url });
                await page.setUserAgent('GKWatch browser compatibility check');
                await page.setRequestInterception(true);
                page.on('request', request => {
                    if (request.url().startsWith(url)) void request.continue();
                    else void request.abort();
                });
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
                assert.equal(await page.$eval('.listing a', element => element.textContent), 'Example kit');
                assert.equal(await page.$eval('.price', element => element.textContent), '1000');
                assert.equal(await page.evaluate(() => navigator.userAgent), 'GKWatch browser compatibility check');
                assert.ok((await page.cookies()).some(cookie => cookie.name === 'fixture' && cookie.value === 'local-only'));
                await page.close();
                if (configuration.isolated) await context.close();
                console.log(JSON.stringify({ scraper: configuration.name, launch: true, cookies: true, navigation: true, extraction: true }));
            } finally {
                if (browser) await browser.close();
            }
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
