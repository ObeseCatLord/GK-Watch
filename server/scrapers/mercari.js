const puppeteer = require('puppeteer');
const { matchTitle } = require('../utils/queryMatcher');

let consecutiveTimeouts = 0;
let isDisabled = false;

function reset() {
    consecutiveTimeouts = 0;
    isDisabled = false;
    console.log('Mercari Scraper state reset.');
}

async function search(query, strictEnabled = true) {
    if (isDisabled) {
        console.log(`Mercari skipped (Disabled due to ${consecutiveTimeouts} consecutive timeouts).`);
        return [];
    }

    let browser = null;
    let timeoutHandle = null;

    // Search Logic Promise
    const runSearch = async () => {
        console.log(`Searching Mercari for ${query}...`);
        // Add status=on_sale to filter out sold items
        const searchUrl = `https://jp.mercari.com/search?keyword=${encodeURIComponent(query)}&status=on_sale`;

        // Use system Chromium only on ARM Linux (bundled Chrome doesn't work on ARM)
        // On x64 Linux and other platforms, use bundled Puppeteer Chrome (faster)
        const isARM = process.arch === 'arm' || process.arch === 'arm64';
        const executablePath = (process.platform === 'linux' && isARM)
            ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser')
            : undefined;

        browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const page = await browser.newPage();

        // Optimize: Block images and fonts
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP' });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja'] });
            Object.defineProperty(navigator, 'language', { get: () => 'ja-JP' });
        });

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Race check: Wait for either items OR no-results text
        // This avoids fixed waits and handles dynamic loading
        try {
            const checkResult = await page.waitForFunction(() => {
                const text = document.body.innerText;
                const matchesNoResults = text.includes('検索結果 0件') ||
                    text.includes('該当する商品は見つかりませんでした') ||
                    text.includes('出品された商品がありません');
                const hasItems = document.querySelectorAll('li[data-testid="item-cell"]').length > 0;

                if (matchesNoResults) return 'NO_RESULTS';
                if (hasItems) return 'HAS_ITEMS';
                return false;
            }, { timeout: 10000 }); // Wait up to 10s for initial load

            const status = await checkResult.jsonValue();
            if (status === 'NO_RESULTS') {
                console.log('Mercari: No results found (fast check).');
                return [];
            }
            // If HAS_ITEMS, simply proceed to scroll to get MORE items
        } catch (e) {
            // Timeout means neither clearly appeared. Proceed to scroll/fallback.
            console.log('Mercari: Fast check timed out, proceeding to fallback.');
        }

        // Scroll to bottom to trigger lazy loading
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 300;
                let attempts = 0;

                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if ((window.innerHeight + window.scrollY) >= scrollHeight) {
                        attempts++;
                        if (attempts > 10) {
                            clearInterval(timer);
                            resolve();
                        }
                    } else {
                        attempts = 0;
                    }

                    if (totalHeight > 50000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });

        // Wait a bit more for final items to render
        await new Promise(r => setTimeout(r, 4000));

        try {
            await page.waitForSelector('li[data-testid="item-cell"]', { timeout: 10000 });
        } catch (e) {
            console.log('Mercari: No items found or selector changed.');
            return [];
        }

        const results = await page.evaluate(() => {
            const items = document.querySelectorAll('li[data-testid="item-cell"]');
            const data = [];
            items.forEach(item => {
                try {
                    // Skip sold items
                    const soldLabel = item.querySelector('[data-testid="thumbnail-sticker"]');
                    if (soldLabel && (soldLabel.textContent.includes('SOLD') || soldLabel.textContent.includes('売り切れ'))) {
                        return;
                    }

                    const linkEl = item.querySelector('a[data-testid="thumbnail-link"]');
                    if (!linkEl) return;
                    const link = 'https://jp.mercari.com' + linkEl.getAttribute('href');

                    const thumbDiv = item.querySelector('div[role="img"]');
                    const ariaLabel = thumbDiv ? thumbDiv.getAttribute('aria-label') : '';
                    const imgEl = item.querySelector('img');
                    const image = imgEl ? imgEl.src : '';

                    const yenMatch = ariaLabel.match(/(\d{1,3}(,\d{3})*)円/);
                    let title = ariaLabel;
                    let price = 'N/A';

                    if (yenMatch) {
                        price = yenMatch[0];
                    } else {
                        const priceSpan = item.querySelector('span[class*="number"]');
                        if (priceSpan) price = priceSpan.innerText;
                    }

                    if (title.includes('の画像')) {
                        title = title.split('の画像')[0];
                    }

                    // Format price with ¥ prefix
                    let formattedPrice = 'N/A';
                    if (price && price !== 'N/A') {
                        const priceNum = price.replace(/[円,]/g, '').trim();
                        if (priceNum) formattedPrice = `¥${Number(priceNum).toLocaleString()}`;
                    }

                    data.push({
                        title: title || 'Unknown Item',
                        link,
                        image,
                        price: formattedPrice,
                        source: 'Mercari'
                    });
                } catch (err) { }
            });
            return data;
        });

        // Strict filtering using query matcher (supports | for OR, && for AND)
        if (strictEnabled) {
            const filteredResults = results.filter(item => matchTitle(item.title, query));
            console.log(`Mercari: Found ${results.length} items, ${filteredResults.length} after strict filter`);
            return filteredResults;
        }

        console.log(`Mercari: Found ${results.length} items (Strict filtering disabled)`);
        return results;
    };

    // Timeout Promise (1 min 30 sec)
    const timeoutPromise = new Promise(resolve => {
        timeoutHandle = setTimeout(() => {
            console.warn(`Mercari: Search for "${query}" timed out after 1m 30s.`);
            resolve('TIMEOUT');
        }, 90000);
    });

    try {
        const result = await Promise.race([runSearch(), timeoutPromise]);

        if (result === 'TIMEOUT') {
            consecutiveTimeouts++;
            console.log(`Mercari Consecutive Timeouts: ${consecutiveTimeouts}`);
            if (consecutiveTimeouts >= 5) {
                isDisabled = true;
                console.warn('Mercari scraper DISABLED for remainder of run due to 5 consecutive timeouts.');
            }
            return [];
        }

        clearTimeout(timeoutHandle);
        return result;

    } catch (error) {
        console.error('Mercari Scraper Error:', error.message);
        return [];
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

module.exports = { search, reset };
