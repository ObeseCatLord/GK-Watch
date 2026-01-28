const fs = require('fs');
const dejapan = require('./dejapan');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const { webcrypto, randomUUID } = require('node:crypto');
const { subtle } = webcrypto;
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery, getSearchTerms } = require('../utils/queryMatcher');

// --- DPoP Utils ---
function encodeBase64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function encodeJwtInfo(str) {
    return new TextEncoder().encode(str);
}

async function generateDPoP(url, method, keyPair) {
    const { publicKey, privateKey } = keyPair;
    // Export public key to JWK for header
    const jwk = await subtle.exportKey("jwk", publicKey);

    const header = JSON.stringify({
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: {
            crv: jwk.crv,
            kty: jwk.kty,
            x: jwk.x,
            y: jwk.y
        }
    });

    const iat = Math.ceil(Date.now() / 1000);
    const jti = randomUUID();

    const payload = JSON.stringify({
        iat: iat,
        jti: jti,
        htu: url,
        htm: method,
        uuid: randomUUID()
    });

    const encodedHeader = encodeBase64Url(encodeJwtInfo(header));
    const encodedPayload = encodeBase64Url(encodeJwtInfo(payload));
    const jwtWrap = `${encodedHeader}.${encodedPayload}`;

    const signature = await subtle.sign(
        {
            name: "ECDSA",
            hash: { name: "SHA-256" },
        },
        privateKey,
        encodeJwtInfo(jwtWrap)
    );

    return `${jwtWrap}.${encodeBase64Url(signature)}`;
}

// --- Helper to flatten query tree for API ---
function flattenQuery(node, acc = { include: [], exclude: [] }) {
    if (!node) return acc;
    if (node.type === 'TERM') {
        let val = node.value;
        if (val.startsWith('-') && val.length > 1) {
            acc.exclude.push(val.slice(1));
        } else {
            if (node.quoted) val = `"${val}"`;
            acc.include.push(val);
        }
    } else if (node.children) {
        node.children.forEach(child => flattenQuery(child, acc));
    }
    return acc;
}

// --- Direct Axios Search ---
async function searchAxios(query, strictEnabled, filters) {
    console.log(`[Mercari Axios] Searching for: "${query}"`);

    // Generate Ephemeral Keys
    const keyPair = await subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    );

    const targetUrl = "https://api.mercari.jp/v2/entities:search";
    const method = "POST";
    const MAX_PAGES = 5; // Direct API is fast/large, 5 pages (600 items) is usually plenty
    let allResults = [];

    // Check keyword structure
    const parsedQuery = parseQuery(query);
    const { include, exclude } = flattenQuery(parsedQuery);

    const positiveTerms = include.join(' ');
    const negativeTermsList = [...exclude, ...(filters || [])];
    const excludeKeyword = negativeTermsList.join(' ');

    for (let page = 0; page < MAX_PAGES; page++) {
        // Generate Token per request (good practice, though RFC allows reuse within time window)
        const dpopToken = await generateDPoP(targetUrl, method, keyPair);

        const searchPayload = {
            "pageSize": 120,
            "searchSessionId": "axios_session_" + Date.now(),
            "pageToken": page > 0 ? (allResults._nextPageToken || "") : undefined,
            "searchCondition": {
                "keyword": positiveTerms,
                "sort": "SORT_SCORE",
                "order": "ORDER_DESC",
                "status": ["STATUS_ON_SALE"],
                "excludeKeyword": excludeKeyword,
            },
        };

        // If passed page 0 and no next token, stop
        if (page > 0 && !allResults._nextPageToken) break;

        try {
            const response = await axios.post(targetUrl, searchPayload, {
                headers: {
                    "X-Platform": "web",
                    "Content-Type": "application/json",
                    "DPoP": dpopToken,
                    "Origin": "https://jp.mercari.com",
                    "Referer": "https://jp.mercari.com/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                timeout: 10000
            });

            // Extract Items
            let items = [];
            if (response.data.items) {
                items = response.data.items;
            } else if (response.data.components) {
                const itemsComp = response.data.components.find(c => c.items);
                if (itemsComp) items = itemsComp.items;
            }

            if (items.length === 0) {
                console.log(`[Mercari Axios] Page ${page + 1} returned 0 items. Stopping.`);
                break;
            }

            // Map to common format
            const mapped = items.map(i => {
                let link = `https://jp.mercari.com/item/${i.id}`;
                // Shops items have alphanumeric IDs (not m + digits)
                if (!i.id.match(/^m\d+$/)) {
                    link = `https://jp.mercari.com/shops/product/${i.id}`;
                }

                return {
                    title: i.name,
                    link,
                    image: i.thumbnails ? i.thumbnails[0] : '',
                    price: `¥${Number(i.price).toLocaleString()}`,
                    source: 'Mercari'
                };
            });

            allResults.push(...mapped);
            console.log(`[Mercari Axios] Page ${page + 1} found ${items.length} items.`);

            // Update Page Token
            if (response.data.meta && response.data.meta.nextPageToken) {
                allResults._nextPageToken = response.data.meta.nextPageToken;
            } else {
                allResults._nextPageToken = null;
            }

            // Safety break if token didn't change (prevent loop)
            if (page > 0 && !allResults._nextPageToken) break;

            await new Promise(r => setTimeout(r, 500)); // Polite delay

        } catch (err) {
            console.error(`[Mercari Axios] Error on page ${page + 1}: ${err.message}`);
            if (allResults.length === 0) return null; // If first page fails, return null to trigger fallback
            break; // Otherwise return what we have
        }
    }

    // Client-side Strict Filtering (Double check)
    // Even though we excluded keywords at API level, we still run matchesQuery for Quotes & strict logic
    const hasQuoted = hasQuotedTerms(parsedQuery);
    if (strictEnabled || hasQuoted) {
        const filtered = allResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
        console.log(`[Mercari Axios] Strict filtering: ${allResults.length} -> ${filtered.length} items.`);
        return filtered;
    }

    return allResults;
}

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
        headless: true,
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
        context = await browser.createBrowserContext();
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
                        const priceNum = parseInt(priceMatch[1].replace(/,/g, ''), 10);
                        if (!isNaN(priceNum)) {
                            price = `¥${priceNum.toLocaleString()}`;
                        }
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

        const parsedQuery = parseQuery(effectiveQuery);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        // Filter results locally.
        // We pass strict=false to matchesQuery, which means:
        // 1. Positive terms are ignored (unless quoted), allowing truncated titles to pass.
        // 2. Negative terms are ENFORCED.
        // 3. Quoted terms are ENFORCED.
        const filtered = allResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));

        if (allResults.length !== filtered.length) {
            console.log(`[Mercari Fallback] Local filtering applied (strict=false). ${allResults.length} -> ${filtered.length} items.`);
        }

        return filtered;

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

    // Priority 1: Direct Axios (Fastest, DPoP Auth)
    try {
        const axiosResults = await searchAxios(query, strictEnabled, filters);
        if (axiosResults !== null) {
            console.log(`[Mercari] Axios search successful (${axiosResults.length} items).`);
            return axiosResults;
        }
        console.warn('[Mercari] Axios failed (returned null), falling back to DEJapan...');
    } catch (err) {
        console.warn(`[Mercari] Axios critical error: ${err.message}, falling back to DEJapan...`);
    }

    // Priority 2: DEJapan (Fast/Axios + Full Titles)
    try {
        const dejapanResults = await dejapan.search(query, strictEnabled, filters);
        if (dejapanResults !== null) {
            console.log(`[Mercari] DEJapan search successful (${dejapanResults.length} items).`);
            return dejapanResults;
        }
        console.warn('[Mercari] DEJapan failed (returned null), falling back to Neokyo...');
    } catch (err) {
        console.warn(`[Mercari] DEJapan error: ${err.message}, falling back to Neokyo...`);
    }

    // Priority 3: Neokyo (Fast/Axios)
    try {
        console.log('[Mercari] Attempting Fallback: Neokyo...');
        const neokyoResults = await searchNeokyo(query, strictEnabled, filters);
        if (neokyoResults !== null) {
            console.log(`[Mercari] Neokyo search successful (${neokyoResults.length} items).`);
            return neokyoResults;
        }
    } catch (err) {
        console.warn(`[Mercari] Neokyo error: ${err.message}.`);
    }

    // Priority 4: Native Scraper (Puppeteer) - Ultimate Fallback
    // Only used if ALL direct/proxy methods fail.
    console.log('[Mercari] All Axios methods failed. Attempting Native (Puppeteer) fallback...');
    const MAX_RETRIES = 1;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
            return await performSearch(query, strictEnabled, filters);
        } catch (error) {
            console.error(`[Mercari] Native Attempt ${attempt}/${MAX_RETRIES + 1} failed: ${error.message}`);
            if (error.message === 'TIMEOUT' && attempt === MAX_RETRIES + 1) {
                consecutiveTimeouts++;
                if (consecutiveTimeouts >= 5) isDisabled = true;
            }
            if (attempt <= MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    return [];
}


module.exports = { search, reset, searchNeokyo };
