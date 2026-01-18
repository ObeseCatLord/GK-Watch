const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery, getSearchTerms } = require('../utils/queryMatcher');

let consecutiveTimeouts = 0;
let isDisabled = false;

let browserPromise = null;

async function getBrowser() {
    if (browserPromise) {
        const browser = await browserPromise;
        if (browser.isConnected()) {
            return browser;
        }
        try {
            await browser.close();
        } catch (e) {}
        browserPromise = null;
    }

    const isARM = process.arch === 'arm' || process.arch === 'arm64';
    const executablePath = (process.platform === 'linux' && isARM)
        ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser')
        : undefined;

    browserPromise = puppeteer.launch({
        headless: "new",
        executablePath,
        pipe: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }).catch(err => {
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}

function reset() {
    consecutiveTimeouts = 0;
    isDisabled = false;
    console.log('Mercari Scraper state reset.');
}

async function performSearch(query, strictEnabled, filters) {
    // Optimization: Mercari doesn't support negative search terms in the URL query.
    // Also, Mercari's search engine interprets quotes differently, so we search for UNQUOTED terms
    // and rely on our server-side strict filtering (lines 241+) to enforce quotes if present.
    let effectiveQuery = getSearchTerms(query).replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`[Mercari] Searching for: "${effectiveQuery}" (Original: "${query}", Filters applied post-fetch)`);

    let context = null;
    let page = null;
    let timeoutHandle = null;

    // Search Logic Promise
    const runSearch = async () => {
        console.log(`Searching Mercari for ${effectiveQuery}...`);

        let allResults = [];
        const MAX_PAGES = 10;

        const browser = await getBrowser();
        context = await browser.createIncognitoBrowserContext();
        page = await context.newPage();

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

        // Initial URL
        let currentUrl = `https://jp.mercari.com/search?keyword=${encodeURIComponent(effectiveQuery)}&status=on_sale`;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            if (pageNum > 1) {
                console.log(`Mercari: Navigating to page ${pageNum}...`);
                await new Promise(r => setTimeout(r, 2000)); // Delay between pages
            }

            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Race check: Wait for either items OR no-results text
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
                }, { timeout: 10000 });

                const status = await checkResult.jsonValue();
                if (status === 'NO_RESULTS') {
                    console.log(`Mercari: No results found on page ${pageNum}. Stopping.`);
                    break;
                }
            } catch (e) {
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
                            if (attempts > 10) { clearInterval(timer); resolve(); }
                        } else {
                            attempts = 0;
                        }
                        if (totalHeight > 50000) { clearInterval(timer); resolve(); }
                    }, 200);
                });
            });

            // Wait a bit more for final items to render
            await new Promise(r => setTimeout(r, 4000));

            const pageResults = await page.evaluate(() => {
                const items = document.querySelectorAll('li[data-testid="item-cell"]');
                const data = [];
                items.forEach(item => {
                    try {
                        // Skip sold items
                        const soldLabel = item.querySelector('[data-testid="thumbnail-sticker"]');
                        if (soldLabel && (soldLabel.textContent.includes('SOLD') || soldLabel.textContent.includes('売り切れ'))) return;

                        const linkEl = item.querySelector('a[data-testid="thumbnail-link"]');
                        if (!linkEl) return;
                        const link = 'https://jp.mercari.com' + linkEl.getAttribute('href');

                        const thumbDiv = item.querySelector('div[role="img"]');
                        const ariaLabel = thumbDiv ? thumbDiv.getAttribute('aria-label') : '';

                        const yenMatch = ariaLabel.match(/(\d{1,3}(,\d{3})*)円/);
                        let title = ariaLabel;
                        let price = 'N/A';
                        if (yenMatch) {
                            price = yenMatch[0];
                        } else {
                            const priceSpan = item.querySelector('span[class*="number"]');
                            if (priceSpan) price = priceSpan.innerText;
                        }

                        if (title.includes('の画像')) title = title.split('の画像')[0];

                        let formattedPrice = 'N/A';
                        if (price && price !== 'N/A') {
                            const priceNum = price.replace(/[円,]/g, '').trim();
                            if (priceNum) formattedPrice = `¥${Number(priceNum).toLocaleString()}`;
                        }

                        // Extract Image URL
                        let imageUrl = '';
                        const imgEl = item.querySelector('img');
                        if (imgEl) {
                            imageUrl = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
                        }

                        data.push({
                            title: title || 'Unknown Item',
                            link,
                            image: imageUrl,
                            price: formattedPrice,
                            source: 'Mercari'
                        });
                    } catch (err) { }
                });
                return data;
            });

            if (pageResults.length > 0) {
                console.log(`Mercari: Page ${pageNum} found ${pageResults.length} items.`);
                allResults = [...allResults, ...pageResults];
            }

            // Check for next page button
            const nextButtonHref = await page.evaluate(() => {
                const nextBtn = document.querySelector('a[data-testid="pagination-next-button"]');
                return nextBtn ? nextBtn.getAttribute('href') : null;
            });

            if (nextButtonHref && pageNum < MAX_PAGES) {
                if (nextButtonHref.startsWith('http')) {
                    currentUrl = nextButtonHref;
                } else {
                    currentUrl = 'https://jp.mercari.com' + nextButtonHref;
                }
            } else {
                console.log('Mercari: No next page or max pages reached.');
                break;
            }
        }

        // Strict filtering using query matcher (supports | for OR, && for AND)
        // Also apply negative filters here since Mercari API doesn't support them
        let finalResults = allResults;
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (filters && filters.length > 0) {
            const filterTerms = filters.map(f => f.toLowerCase());
            const preCount = finalResults.length;
            finalResults = finalResults.filter(item => {
                const titleLower = item.title.toLowerCase();
                return !filterTerms.some(term => titleLower.includes(term));
            });
            console.log(`[Mercari] Server-side negative filtering removed ${preCount - finalResults.length} items.`);
        }

        if (strictEnabled || hasQuoted) {
            const filteredResults = finalResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`Mercari: Total ${allResults.length} items, ${filteredResults.length} after strict filter${hasQuoted ? ' (Quoted Terms Enforced)' : ''}`);
            return filteredResults;
        }

        console.log(`Mercari: Total ${allResults.length} items (Strict filtering disabled). Returning filtered set: ${finalResults.length}`);
        return finalResults;
    };

    // Timeout Promise (4 min) to match frontend 5 min safety
    const timeoutPromise = new Promise(resolve => {
        timeoutHandle = setTimeout(() => {
            // Do not warn here, allow wrapper to handle. Just resolve with TIMEOUT
            resolve('TIMEOUT');
        }, 240000);
    });

    try {
        const result = await Promise.race([runSearch(), timeoutPromise]);

        if (result === 'TIMEOUT') {
            throw new Error('TIMEOUT'); // Throw so wrapper catches it
        }

        clearTimeout(timeoutHandle);
        return result;

    } finally {
        if (page) {
            try { await page.close(); } catch (e) { }
        }
        if (context) {
            try { await context.close(); } catch (e) { }
        }
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

async function search(query, strictEnabled = true, filters = []) {
    if (isDisabled) {
        console.log(`Mercari skipped (Disabled due to ${consecutiveTimeouts} consecutive timeouts).`);
        return [];
    }

    const MAX_RETRIES = 1; // 1 retry = 2 attempts total
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
            return await performSearch(query, strictEnabled, filters);
        } catch (error) {
            console.error(`[Mercari] Attempt ${attempt}/${MAX_RETRIES + 1} failed: ${error.message}`);

            // If it's a timeout, track consecutive timeouts logic
            if (error.message === 'TIMEOUT') {
                // If it's the LAST attempt
                if (attempt === MAX_RETRIES + 1) {
                    consecutiveTimeouts++;
                    console.log(`Mercari Consecutive Timeouts: ${consecutiveTimeouts}`);
                    if (consecutiveTimeouts >= 5) {
                        isDisabled = true;
                        console.warn('Mercari scraper DISABLED for remainder of run due to 5 consecutive timeouts.');
                    }
                }
            } else {
                // If it was NOT a timeout (some other error), reset consecutive timeouts because the scraper is "alive" but failing? 
                // Or preserve it? Probably preserve. If it errors out, it's not a timeout.
            }

            if (attempt <= MAX_RETRIES) {
                console.log(`[Mercari] Retrying in 5 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.error('[Mercari] All attempts failed. Returning empty.');
                return null;
            }
        }
    }
}

module.exports = { search, reset };
