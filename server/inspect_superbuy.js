const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

async function inspect() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Log ALL requests/responses
        page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            // Filter noise
            if (!url.includes('.png') && !url.includes('.jpg') && !url.includes('.css') && !url.includes('google') && !url.includes('facebook')) {
                console.log(`[Response] ${status} ${url} (${contentType})`);

                // Capture potentially interesting JSON
                if (contentType.includes('application/json') && (url.includes('search') || url.includes('goods'))) {
                    try {
                        const json = await response.json();
                        console.log(`CAPTURED JSON from ${url}`);
                        fs.writeFileSync('superbuy_search_response.json', JSON.stringify(json, null, 2));
                    } catch (e) { }
                }
            }
        });

        const targetUrl = 'https://www.superbuy.com/en/page/search/?nTag=Home-search&from=search-input&keyword=%E4%B8%9C%E6%96%B9project%20%E7%99%BD%E6%A8%A1&platform=xy';
        console.log(`Navigating to ${targetUrl}...`);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('Waiting for loader to disappear or items to appear...');
        try {
            // Wait for loading spinner to be hidden OR items to exist
            await page.waitForFunction(() => {
                const loader = document.querySelector('.search-goods-loading');
                const itemsWrapper = document.querySelector('.good-list-content');
                // Check if wrapper has children divs that look like items
                // Inspecting previous HTML, .good-list-content contains .search-goods-loading
                // If items load, .search-goods-loading should go away or be replaced.
                return (!loader || getComputedStyle(loader).display === 'none');
            }, { timeout: 30000 });
        } catch (e) {
            console.log('Timeout waiting for state change.');
        }

        console.log('Page state settled. Taking screenshot...');
        await page.screenshot({ path: 'superbuy_inspection_2.png', fullPage: true });

        console.log('Dumping HTML...');
        const html = await page.content();
        fs.writeFileSync('superbuy_dump_2.html', html);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await browser.close();
    }
}

inspect();
