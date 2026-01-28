const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery, getSearchTerms } = require('../utils/queryMatcher');

const NEOKYO_SEARCH_URL = 'https://neokyo.com/en/search/mercari';
const DELAY_BETWEEN_PAGES = 300; // ms


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
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}

async function warmup() {
    const isARM = process.arch === 'arm' || process.arch === 'arm64';
    if (isARM) {
        console.log('[Mercari] Warming up browser for ARM architecture...');
        try {
            await getBrowser();
            console.log('[Mercari] Browser armed and ready.');
        } catch (err) {
            console.error('[Mercari] Warmup failed:', err);
        }
    }
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
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Race check: Wait for either items OR no-results text
            try {
                const checkResult = await page.waitForFunction(() => {
                    const text = document.body.innerText;
                    const matchesNoResults = text.includes('検索結果 0件') ||
                        text.includes('該当する商品は見つかりませんでした') ||
                        text.includes('出品された商品がありません');
                    const hasItems = !!document.querySelector('li[data-testid="item-cell"]');

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

            // Optimize: Wait for network idle instead of hardcoded 4s delay
            // This handles lazy loading more efficiently.
            try {
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
            } catch (e) {
                // Ignore timeout, just proceed
            }

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


/**
 * Build Neokyo Search URL
 */
function buildNeokyoUrl(query, page = 1) {
    const encodedQuery = encodeURIComponent(query);
    if (page === 1) {
        return `${NEOKYO_SEARCH_URL}?provider=mercari&translate=0&order-tag=created_time%3Adesc&keyword=${encodedQuery}`;
    }
    return `${NEOKYO_SEARCH_URL}?page=${page}&keyword=${encodedQuery}&translate=0&order-tag=created_time%3Adesc&google_translate=&category[level_1]=&category[level_2]=&category[level_3]=&condition=&shipping_charges=&item_shop=3`;
}

/**
 * Convert Neokyo link to Mercari link for deduplication
 * Neokyo: https://neokyo.com/en/product/mercari/m123456789
 * Mercari: https://jp.mercari.com/item/m123456789
 */
function convertToMercariLink(neokyoLink) {
    const match = neokyoLink.match(/\/product\/mercari\/(m\d+)/);
    if (match && match[1]) {
        return `https://jp.mercari.com/item/${match[1]}`;
    }
    return neokyoLink;
}

/**
 * Search via Neokyo (Secondary Fallback)
 */
async function searchNeokyo(query, strictEnabled, filters) {
    // Mercari doesn't support negative filters natively via API usually, but Neokyo might pass it through?
    // User requested using '-' for filtered terms.
    let effectiveQuery = query;
    if (filters && filters.length > 0) {
        const negativeTerms = filters.map(f => `-${f}`).join(' ');
        effectiveQuery = `${query} ${negativeTerms}`;
        console.log(`[Mercari Fallback] Optimized search with negative terms: "${effectiveQuery}"`);
    }

    console.log(`[Mercari Fallback] Searching Neokyo for ${effectiveQuery}...`);
    const allResults = [];
    let totalPages = 1;

    try {
        // Page 1
        const firstUrl = buildNeokyoUrl(effectiveQuery, 1);
        console.log(`[Mercari Fallback] Fetching Neokyo page 1`);

        const response = await axios.get(firstUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);

        // Parse results
        const parsePageResults = ($CHEERIO) => {
            const results = [];
            $CHEERIO('.product-card').each((i, el) => {
                const title = $CHEERIO(el).find('a.product-link').text().trim();
                const relativeLink = $CHEERIO(el).find('a.product-link').attr('href');
                const neokyoLink = relativeLink ? `https://neokyo.com${relativeLink}` : '';
                const image = $CHEERIO(el).find('img.card-img-top').attr('src');

                let price = 'N/A';
                const priceText = $CHEERIO(el).find('.price b').text().trim();
                if (priceText) {
                    const priceMatch = priceText.match(/([\d,]+)/);
                    if (priceMatch) {
                        price = `¥${priceMatch[1]}`;
                    }
                }

                if (title && neokyoLink) {
                    results.push({
                        title,
                        link: convertToMercariLink(neokyoLink), // Convert to native link for dedup
                        image,
                        price,
                        source: 'Mercari'
                    });
                }
            });
            return results;
        };

        const page1Results = parsePageResults($);

        if (page1Results.length === 0) {
            // Check for no results message
            const hasNoResultsMsg = $('.container.no-result-container').length > 0
                || $('body').text().includes('Sorry, we found no results');

            if (hasNoResultsMsg) {
                console.log('[Mercari Fallback] No results found on Neokyo.');
                return [];
            }
            console.log('[Mercari Fallback] Found 0 items on Neokyo.');
            return []; // or null? No, empty array means success but no items.
        }

        allResults.push(...page1Results);

        // Get total pages
        // Similar pagination logic to Suruga-ya
        let maxPage = 1;
        $('a[href*="page="]').each((i, link) => {
            const href = $(link).attr('href');
            const match = href.match(/page=(\d+)/);
            if (match) {
                const p = parseInt(match[1], 10);
                if (p > maxPage) maxPage = p;
            }
        });

        // Limit max pages to 10 for Mercari fallback (same as native limit)
        totalPages = Math.min(maxPage, 10);

        // Fetch remaining pages
        for (let page = 2; page <= totalPages; page++) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
            const pageUrl = buildNeokyoUrl(effectiveQuery, page);

            try {
                const pRes = await axios.get(pageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                    timeout: 15000
                });
                const $p = cheerio.load(pRes.data);
                const pResults = parsePageResults($p);
                if (pResults.length === 0) break;
                allResults.push(...pResults);
            } catch (err) {
                console.error(`[Mercari Fallback] Error fetching page ${page}:`, err.message);
            }
        }

        // Apply strict filtering locally
        // Neokyo concat titles shouldn't be an issue for validation if we check strictness
        // Note: The user said "Neokyo concatenates titles so titles aren't always reliable".
        // This suggests we should be careful. 
        // But for strict filtering, if the title found on Neokyo contains the query, it's a match.
        // We will stick to our standard queryMatcher logic.

        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const filtered = allResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`[Mercari Fallback] Strict filtering applied. ${allResults.length} -> ${filtered.length} items.`);
            return filtered;
        }

        return allResults;

    } catch (error) {
        console.error(`[Mercari Fallback] Error: ${error.message}`);
        return null;
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
                console.error('[Mercari] All attempts failed. Falling back to Neokyo...');
                return await searchNeokyo(query, strictEnabled, filters);
            }

        }
    }
}


module.exports = { search, reset, searchNeokyo, warmup };
