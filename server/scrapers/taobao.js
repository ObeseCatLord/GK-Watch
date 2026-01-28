const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const queryMatcher = require('../utils/queryMatcher');

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

/**
 * Load cookies from file
 */
function loadCookies() {
    try {
        if (!fs.existsSync(COOKIES_FILE)) {
            console.log('[Taobao] Warning: Cookie file not found at', COOKIES_FILE);
            return null;
        }

        const cookieData = fs.readFileSync(COOKIES_FILE, 'utf8');
        const cookies = JSON.parse(cookieData);

        if (!Array.isArray(cookies) || cookies.length === 0) {
            console.log('[Taobao] Warning: Invalid or empty cookie file');
            return null;
        }

        return cookies;
    } catch (error) {
        console.error('[Taobao] Error loading cookies:', error.message);
        return null;
    }
}

/**
 * Convert cookies array to cookie header string
 */
function cookiesToHeader(cookies) {
    if (!cookies || !Array.isArray(cookies)) return '';

    return cookies
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

/**
 * Build the search URL
 */
function buildSearchUrl(query) {
    const encodedQuery = encodeURIComponent(query);
    // Sort by default (综合排序), filter to only show items on sale
    return `${TAOBAO_SEARCH_URL}?q=${encodedQuery}&sort=default`;
}

/**
 * Parse results from HTML content using Cheerio
 */
function parseResults($) {
    const results = [];

    // Taobao uses various selectors for product cards
    // Try multiple possible selectors
    const productCards = $('.item, .Card--doubleCardWrapper--L2XFE73, .item.J_MouserOnverReq');

    console.log(`[Taobao] Found ${productCards.length} product cards`);

    productCards.each((i, card) => {
        try {
            const $card = $(card);

            // Extract title
            let title = $card.find('.title a, .Card--titleText--WeJJlj7, a[class*="title"]').first().text().trim();
            if (!title) {
                // Fallback: try raw-title
                title = $card.find('.raw-title, .J_ClickStat').first().text().trim();
            }

            // Extract link
            let link = $card.find('.pic a, .Card--doubleCardWrapper--L2XFE73 a, .item-link').first().attr('href');
            if (link && !link.startsWith('http')) {
                link = link.startsWith('//') ? 'https:' + link : 'https:' + link;
            }

            // Extract image
            let image = $card.find('.pic img, .Card--mainPic--rcLNaCv img').first().attr('src');
            if (!image) {
                image = $card.find('.pic img, .Card--mainPic--rcLNaCv img').first().attr('data-src');
            }
            if (image && !image.startsWith('http')) {
                image = image.startsWith('//') ? 'https:' + image : 'https:' + image;
            }

            // Extract price (Chinese format: ¥123 or 123元)
            let priceText = $card.find('.price strong, .price, .Card--priceInt--ZlsSi_M, span[class*="price"]').first().text().trim();
            let price = 'N/A';

            if (priceText) {
                // Extract numeric price
                const priceMatch = priceText.match(/[\d,]+\.?\d*/);
                if (priceMatch) {
                    const priceNum = priceMatch[0].replace(/,/g, '');
                    price = `${priceNum} RMB`;
                }
            }

            // Extract Shop Name
            let shopName = $card.find('.shop, .shop-name, .ShopInfo--shopName--1_Q13Ww, .ShopInfo--shopName, [class*="shopName"], a[class*="shop"]').first().text().trim();
            if (!shopName) shopName = 'Unknown';

            // Only add if we have essential data
            if (title && link) {
                results.push({
                    title: title,
                    link: link,
                    image: image || 'https://img.alicdn.com/tps/i1/T1OjaVFl4dXXa.JOZB-114-114.png',
                    price: price,
                    source: 'Taobao',
                    shopName: shopName
                });
            }
        } catch (err) {
            // Skip this card if parsing fails
            console.log('[Taobao] Error parsing card:', err.message);
        }
    });

    // Deduplicate results
    const uniqueResults = [];
    const seenIds = new Set();

    results.forEach(item => {
        try {
            // Try to extract ID from link
            let id = null;
            const urlMatch = item.link.match(/[?&]id=(\d+)/);
            if (urlMatch) {
                id = urlMatch[1];
            } else {
                // Fallback: use full link without tracking params
                id = item.link.split('?')[0];
            }

            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                uniqueResults.push(item);
            } else if (!id) {
                // If we really can't identify it, let it through (unlikely)
                uniqueResults.push(item);
            }
        } catch (e) {
            uniqueResults.push(item);
        }
    });

    return uniqueResults;
}

/**
 * Try scraping with Axios (fast method)
 */
async function searchWithAxios(query, cookies) {
    try {
        const searchUrl = buildSearchUrl(query);
        const cookieHeader = cookiesToHeader(cookies);

        console.log(`[Taobao] Fetching with Axios: ${searchUrl}`);

        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cookie': cookieHeader,
                'Referer': 'https://www.taobao.com/',
                'Accept-Encoding': 'gzip, deflate, br',
            },
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);

        // Check for login redirect or error page
        const pageTitle = $('title').text();
        if (pageTitle.includes('登录') || pageTitle.includes('login')) {
            console.log('[Taobao] Login required - cookies may be invalid or expired');
            return null;
        }

        const results = parseResults($);

        if (results.length === 0) {
            // Check if it's genuinely no results or parsing failed
            const bodyText = $('body').text();
            if (bodyText.includes('没有找到') || bodyText.includes('抱歉')) {
                console.log('[Taobao] No results found for query');
                return [];
            }
            // If body has content but no results, parsing may have failed
            console.log('[Taobao] Axios parsing may have failed, returning null to try Puppeteer');
            return null;
        }

        console.log(`[Taobao] Axios found ${results.length} results`);
        return results;

    } catch (error) {
        console.log(`[Taobao] Axios failed: ${error.message}`);
        return null;
    }
}

let browserPromise = null;

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
        // If launch fails, clear the promise so next attempt can try again
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}

/**
 * Scrape with Puppeteer (fallback method for JS-heavy pages)
 */
async function searchWithPuppeteer(query, cookies) {
    let context = null;
    let page = null;

    try {
        const browser = await getBrowser();
        context = await browser.createBrowserContext();
        page = await context.newPage();

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

        // Wait for JavaScript to render products
        await new Promise(r => setTimeout(r, 5000));

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
        // Suppress "Navigating frame was detached" noise, but log others
        if (error.message.includes('detached')) {
            console.log('[Taobao] Transient error: Navigating frame was detached. triggering retry.');
        } else {
            console.error('[Taobao] Puppeteer error:', error.message);
        }
        // Explicitly return null on error to signal retry (vs empty array for valid 0 results)
        return null;
    } finally {
        if (page) {
            try { await page.close(); } catch (e) { }
        }
        if (context) {
            try { await context.close(); } catch (e) { }
        }
    }
}

/**
 * Main search function
 */
async function search(query, strict = true) {
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
        attempts++;
        if (attempts > 1) {
            console.log(`[Taobao] Retry attempt ${attempts}/${maxAttempts}...`);
            await new Promise(r => setTimeout(r, 2000));
        }

        results = await searchWithPuppeteer(query, cookies);

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
