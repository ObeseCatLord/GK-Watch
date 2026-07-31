const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const queryMatcher = require('../utils/queryMatcher');
const { resolveBrowserExecutable } = require('../utils/browserExecutable');

// Seller blacklist (Recasters/Bootleggers to avoid)
const SELLER_BLACKLIST = [
    'GK CAST模工坊',
    '龙精石 GK手办',
    '幻都GK',
    '安少高精手办店',
    '异斯模型',
    '蜜梨工作室',
    '夏虫GK模型 单体代工涂装',
    '星如雨 GK工作室',
    '松鼠gk模型小店',
    'e2046手办网'
];

/**
 * Taobao scraper with cookie-based authentication
 * Cookies should be stored in server/data/taobao_cookies.json
 */

const TAOBAO_SEARCH_URL = 'https://s.taobao.com/search';
const COOKIES_FILE = path.join(__dirname, '../data/taobao_cookies.json');
const DELAY_BETWEEN_REQUESTS = 500; // ms delay to avoid rate limiting

// Cache cookies to avoid hitting the filesystem on every request
let cachedCookies = null;
let lastCookiesLoadTime = 0;

/**
 * Load cookies from file
 */
function loadCookies() {
    try {
        // First check if file exists and get stats
        // We use statSync which is lighter than readFileSync + JSON.parse
        let stats;
        try {
            stats = fs.statSync(COOKIES_FILE);
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.log('[Taobao] Warning: Cookie file not found at', COOKIES_FILE);
                cachedCookies = null;
                return null;
            }
            throw e;
        }

        // If we have cached cookies and file hasn't changed, return cache
        if (cachedCookies && stats.mtimeMs <= lastCookiesLoadTime) {
            return cachedCookies;
        }

        // File changed or no cache, reload
        // console.log('[Taobao] Reloading cookies from disk...');
        const cookieData = fs.readFileSync(COOKIES_FILE, 'utf8');
        const cookies = JSON.parse(cookieData);

        if (!Array.isArray(cookies) || cookies.length === 0) {
            console.log('[Taobao] Warning: Invalid or empty cookie file');
            cachedCookies = null;
            return null;
        }

        cachedCookies = cookies;
        lastCookiesLoadTime = stats.mtimeMs;

        return cookies;
    } catch (error) {
        console.error('[Taobao] Error loading cookies:', error.message);
        return null;
    }
}

/**
 * Build the search URL
 */
function buildSearchUrl(query) {
    const encodedQuery = encodeURIComponent(query);
    // Sort by default (综合排序), filter to only show items on sale
    return `${TAOBAO_SEARCH_URL}?q=${encodedQuery}&sort=default`;
}

let browserPromise = null;

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Search was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
}

async function getBrowser() {
    if (browserPromise) {
        const browser = await browserPromise;
        if (browser.isConnected()) {
            return browser;
        }
        // If disconnected, clear promise and retry
        try {
            await browser.close();
        } catch (e) { }
        browserPromise = null;
    }

    browserPromise = puppeteer.launch({
        headless: "new",
        executablePath: resolveBrowserExecutable(),
        pipe: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu']
    }).catch(err => {
        // If launch fails, clear the promise so next attempt can try again
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}

/**
 * Scrape with Puppeteer (fallback method for JS-heavy pages)
 */
async function searchWithPuppeteer(query, cookies, signal = null) {
    let context = null;
    let page = null;
    let closePromise = null;

    const closeOwnedResources = () => {
        if (!page && !context) return Promise.resolve();
        if (closePromise) return closePromise;
        closePromise = (async () => {
            if (page) {
                try { await page.close(); } catch (e) { }
            }
            if (context) {
                try { await context.close(); } catch (e) { }
            }
        })();
        return closePromise;
    };
    const onAbort = () => { void closeOwnedResources(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        throwIfAborted(signal);
        const browser = await getBrowser();
        throwIfAborted(signal);
        context = await browser.createBrowserContext();
        throwIfAborted(signal);
        page = await context.newPage();
        throwIfAborted(signal);

        const searchUrl = buildSearchUrl(query);

        // Set cookies if available
        if (cookies && Array.isArray(cookies)) {
            await page.setCookie(...cookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain || '.taobao.com',
                path: c.path || '/',
                expires: c.expires,
                httpOnly: c.httpOnly || false,
                secure: c.secure || false
            })));
        }

        // Optimize: Block images and fonts
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
            Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });
        });

        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        throwIfAborted(signal);

        // Wait for JavaScript to render products
        await new Promise(r => setTimeout(r, 5000));
        throwIfAborted(signal);

        // Extract products directly in the browser context
        let results = await page.evaluate(() => {
            const products = [];
            // Use the correct selector found during testing
            const cards = document.querySelectorAll('[class*="doubleCard"], .item');

            cards.forEach((card) => {
                try {
                    // Get all links in the card
                    const links = card.querySelectorAll('a');
                    const mainLink = links[0] ? links[0].href : '';

                    // Get title from card text
                    const titleText = card.innerText.split('\n')[0]; // First line usually contains title

                    // Get image
                    const img = card.querySelector('img');
                    const imageSrc = img ? (img.src || img.dataset.src || '') : '';

                    // Get price - look for price elements
                    const priceEl = card.querySelector('[class*="priceInt"], .price');
                    let price = 'N/A';
                    if (priceEl) {
                        const priceText = priceEl.textContent.trim();
                        if (priceText) {
                            price = `${priceText} RMB`;
                        }
                    }

                    // Get Shop Name
                    let shopName = 'Unknown';
                    const shopEl = card.querySelector('[class*="shopName"], .shop, .shop-name');
                    if (shopEl) {
                        shopName = shopEl.textContent.trim();
                    }

                    // Only add if we have essential data
                    if (titleText && mainLink && titleText.length > 3) {
                        products.push({
                            title: titleText,
                            link: mainLink,
                            image: imageSrc || 'https://img.alicdn.com/tps/i1/T1OjaVFl4dXXa.JOZB-114-114.png',
                            price: price,
                            source: 'Taobao',
                            shopName: shopName
                        });
                    }
                } catch (err) {
                    // Skip cards that fail to parse
                }
            });

            // Deduplicate by link within the page context
            const uniqueProducts = [];
            const seenLinks = new Set();
            for (const p of products) {
                if (!seenLinks.has(p.link)) {
                    seenLinks.add(p.link);
                    uniqueProducts.push(p);
                }
            }

            return uniqueProducts;
        });

        console.log(`[Taobao] Puppeteer found ${results.length} results`);

        if (results.length === 0) {
            // Check for Login/Baxia iframe
            const loginIframe = await page.$('#baxia-dialog-content');
            const loginSrc = await page.evaluate(() => {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                return iframes.find(f => f.src && f.src.includes('login.taobao.com'));
            });

            if (loginIframe || loginSrc) {
                console.log('[Taobao] BLOCK DETECTED: Login iframe found.');
                // Return a single error item so the frontend knows
                results = [{ error: 'Taobao Cookie Required', source: 'Taobao' }];
            } else {
                // Check if it's genuinely no results
                const bodyText = await page.evaluate(() => document.body.innerText);
                if (bodyText.includes('没有找到') || bodyText.includes('抱歉')) {
                    console.log('[Taobao] "No results" message found. Returning empty array.');
                    return []; // Explicit success with 0 items (no retry)
                }

                console.log('[Taobao] 0 results found, no login detected, and no "No results" message. Potential parsing error.');
                console.log('[Taobao] Saving debug dump...');
                const content = await page.content();
                fs.writeFileSync(path.join(__dirname, '../taobao_debug.html'), content);
                await page.screenshot({ path: path.join(__dirname, '../taobao_debug.png') });
                console.log('[Taobao] Saved debug dump. Returning NULL to trigger retry.');
                return null; // Return null to signal retry
            }
        }

        return results;

    } catch (error) {
        throwIfAborted(signal);
        // Suppress "Navigating frame was detached" noise, but log others
        if (error.message.includes('detached')) {
            console.log('[Taobao] Transient error: Navigating frame was detached. triggering retry.');
        } else {
            console.error('[Taobao] Puppeteer error:', error.message);
        }
        // Explicitly return null on error to signal retry (vs empty array for valid 0 results)
        return null;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await closeOwnedResources();
    }
}

/**
 * Main search function
 */
async function search(query, strict = true, signal = null) {
    throwIfAborted(signal);
    console.log(`[Taobao] Searching for: ${query}`);

    // Load cookies
    const cookies = loadCookies();
    if (!cookies) {
        console.log('[Taobao] Skipping search - no valid cookies available');
        return [{ error: 'Cookie Error', source: 'Taobao' }];
    }

    // Use Puppeteer only (more reliable)
    // Add Retry Logic
    let results = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        throwIfAborted(signal);
        attempts++;
        if (attempts > 1) {
            console.log(`[Taobao] Retry attempt ${attempts}/${maxAttempts}...`);
            await new Promise(r => setTimeout(r, 2000));
            throwIfAborted(signal);
        }

        results = await searchWithPuppeteer(query, cookies, signal);

        // If we got results (or explicit empty array from successful parse), break
        // If null (error), we retry
        if (results !== null) break;
    }

    if (!results) {
        console.log('[Taobao] No results found after retries');
        return null;
    }

    // Apply strict filtering if enabled or if quoted terms are present
    const parsedQuery = queryMatcher.parseQuery(query);
    const hasQuoted = queryMatcher.hasQuotedTerms(parsedQuery);

    if (strict || hasQuoted) {
        console.log(`[Taobao] Strict filtering enabled${hasQuoted ? ' (Quoted Terms Found)' : ''}. Checking ${results.length} items against query: "${query}" AND seller blacklist.`);
        const initialCount = results.length;

        const filteredResults = results.filter(item => {
            // 1. Skip error objects
            if (item.error) return false;

            // 2. Title Match
            const titleMatch = queryMatcher.matchesQuery(item.title, parsedQuery, strict);

            // 3. Seller Match (Only if strict is enabled)
            // Use partial matching to handle prefixes like "15年老店" (X years old shop)
            const isBlacklisted = SELLER_BLACKLIST.some(blacklistedName => item.shopName && item.shopName.includes(blacklistedName));

            if (isBlacklisted) {
                // console.log(`[Taobao] Strict Excluded (Blacklisted Seller): '${item.shopName}' - ${item.title}`);
            }

            return titleMatch && !isBlacklisted;
        });

        results = filteredResults;
        console.log(`[Taobao] Filtered ${initialCount - results.length} items (Title mismatch or Blacklisted). Remaining: ${results.length}`);
    } else {
        // If not strict, we might still want to log the shops found
        // results.forEach(r => console.log(`[Taobao] Found item from shop: '${r.shopName}'`));
    }

    return results;
}

/**
 * Check if valid cookies exist
 */
function hasValidCookies() {
    return loadCookies() !== null;
}

module.exports = { search, hasValidCookies };
