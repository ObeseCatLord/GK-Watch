const fs = require('fs');
const dejapan = require('./dejapan');
const doorzo = require('./doorzo');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const { webcrypto, randomUUID } = require('node:crypto');
const { subtle } = webcrypto;
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery, getSearchTerms } = require('../utils/queryMatcher');
const { resolveBrowserExecutable } = require('../utils/browserExecutable');
const { browserPool, mercariFreshnessPool } = require('../utils/admissionControl');
const { RequestPacer } = require('../utils/requestPacer');

function abortError() {
    const error = new Error('Mercari search aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function isAborted(signal, error) {
    return signal?.aborted || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function delay(ms, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        function done() {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function withAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function envInteger(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const DIRECT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const DIRECT_RATE_LIMIT_RETRY_MS = 500;
const MERCARI_NATIVE_MIN_TIME_MS = envInteger(
    'GKWATCH_MERCARI_NATIVE_MIN_TIME_MS',
    process.env.NODE_ENV === 'test' ? 0 : 1500,
    process.env.NODE_ENV === 'test' ? 0 : 1000,
    10000
);
const FRESHNESS_DEADLINE_MS = envInteger(
    'GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS',
    process.env.NODE_ENV === 'test' ? 4000 : 20000,
    1000,
    120000
);
const MERCARI_SEARCH_URL = 'https://api.mercari.jp/v2/entities:search';

// Mercari permits roughly 60 native requests per rolling minute. Keep a
// process-wide 25% safety margin and pace each HTTP request, including pages
// and retries, rather than pacing only logical searches.
const mercariNativeLimiter = new RequestPacer({
    name: 'Mercari native API',
    minTimeMs: MERCARI_NATIVE_MIN_TIME_MS,
    maxQueue: 4
});

class MercariRateLimitError extends Error {
    constructor(retryAfterMs = DIRECT_RATE_LIMIT_COOLDOWN_MS) {
        super('Mercari direct API remained rate limited');
        this.name = 'MercariRateLimitError';
        this.code = 'MERCARI_RATE_LIMITED';
        this.retryAfterMs = retryAfterMs;
        this.cooldownMs = retryAfterMs;
    }
}

class MercariCircuitOpenError extends Error {
    constructor() {
        super('Mercari direct API circuit is open');
        this.name = 'MercariCircuitOpenError';
        this.code = 'MERCARI_CIRCUIT_OPEN';
    }
}

let directCircuitState = 'closed';
let directCircuitOpenUntil = 0;

function beginDirectSearch(now = Date.now()) {
    if (directCircuitState === 'open') {
        if (now < directCircuitOpenUntil) return { allowed: false, probe: false };
        directCircuitState = 'half-open';
        return { allowed: true, probe: true };
    }

    if (directCircuitState === 'half-open') return { allowed: false, probe: false };
    return { allowed: true, probe: false };
}

function normalizeCooldownMs(value) {
    if (!Number.isFinite(value) || value < 0) return DIRECT_RATE_LIMIT_COOLDOWN_MS;
    return Math.min(Math.max(Math.ceil(value), 1000), Number.MAX_SAFE_INTEGER);
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (value === undefined || value === null || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return normalizeCooldownMs(seconds * 1000);

    const retryAt = Date.parse(String(value));
    if (!Number.isFinite(retryAt)) return null;
    return normalizeCooldownMs(Math.max(retryAt - now, 0));
}

function openDirectCircuit(now = Date.now(), cooldownMs = DIRECT_RATE_LIMIT_COOLDOWN_MS) {
    const normalizedCooldownMs = normalizeCooldownMs(cooldownMs);
    directCircuitState = 'open';
    const requestedOpenUntil = Math.min(Number.MAX_SAFE_INTEGER, now + normalizedCooldownMs);
    directCircuitOpenUntil = Math.max(directCircuitOpenUntil, requestedOpenUntil);
    return directCircuitOpenUntil - now;
}

function completeDirectSearch(probe) {
    if (!probe || directCircuitState !== 'half-open') return;
    directCircuitState = 'closed';
    directCircuitOpenUntil = 0;
}

function directCircuitIsOpen(now = Date.now()) {
    return directCircuitState === 'open' && now < directCircuitOpenUntil;
}

async function postNativeSearch(searchPayload, config, signal) {
    return mercariNativeLimiter.schedule(async () => {
        throwIfAborted(signal);
        if (directCircuitIsOpen()) throw new MercariCircuitOpenError();
        return axios.post(MERCARI_SEARCH_URL, searchPayload, config);
    }, { signal });
}

function getNativeRateLimitStats(now = Date.now()) {
    return {
        minTimeMs: MERCARI_NATIVE_MIN_TIME_MS,
        freshnessDeadlineMs: FRESHNESS_DEADLINE_MS,
        circuitState: directCircuitState === 'open' && !directCircuitIsOpen(now)
            ? 'ready'
            : directCircuitState,
        circuitRemainingMs: directCircuitIsOpen(now) ? directCircuitOpenUntil - now : 0,
        jobs: mercariNativeLimiter.stats()
    };
}

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
async function searchAxios(query, strictEnabled, filters, onProgress = null, signal = null, options = {}) {
    console.log(`[Mercari Axios] Searching for: "${query}"`);
    throwIfAborted(signal);

    const sort = options.sort || 'SORT_SCORE';
    const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
        ? options.maxPages
        : 50;
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 10000;

    // Generate Ephemeral Keys
    const keyPair = await subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    );

    const targetUrl = MERCARI_SEARCH_URL;
    const method = "POST";
    let allResults = [];

    // Check keyword structure
    const parsedQuery = parseQuery(query);
    const { include, exclude } = flattenQuery(parsedQuery);

    const positiveTerms = include.join(' ');
    const negativeTermsList = [...exclude, ...(filters || [])];
    const excludeKeyword = negativeTermsList.join(' ');

    for (let page = 0; page < maxPages; page++) {
        throwIfAborted(signal);
        const searchPayload = {
            "pageSize": 120,
            "searchSessionId": "axios_session_" + Date.now(),
            "pageToken": page > 0 ? (allResults._nextPageToken || "") : undefined,
            "searchCondition": {
                "keyword": positiveTerms,
                "sort": sort,
                "order": "ORDER_DESC",
                "status": ["STATUS_ON_SALE"],
                "excludeKeyword": excludeKeyword,
            },
        };

        // If passed page 0 and no next token, stop
        if (page > 0 && !allResults._nextPageToken) break;

        try {
            let response;
            let retries = 0;
            const MAX_RETRIES = 1;

            while (true) {
                throwIfAborted(signal);
                // Generate Token per request (good practice, though RFC allows reuse within time window)
                const dpopToken = await generateDPoP(targetUrl, method, keyPair);
                throwIfAborted(signal);

                try {
                    response = await postNativeSearch(searchPayload, {
                        headers: {
                            "X-Platform": "web",
                            "Content-Type": "application/json",
                            "DPoP": dpopToken,
                            "Origin": "https://jp.mercari.com",
                            "Referer": "https://jp.mercari.com/",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        },
                        timeout: timeoutMs,
                        signal
                    }, signal);
                    break; // Success
                } catch (err) {
                    if (isAborted(signal, err)) throw abortError();
                    if (err instanceof MercariCircuitOpenError) throw err;
                    if (err.response && err.response.status === 429) {
                        const retryAfterMs = parseRetryAfterMs(err.response.headers?.['retry-after']);
                        if (retryAfterMs !== null) throw new MercariRateLimitError(retryAfterMs);
                    }
                    if (err.response && err.response.status === 429 && retries < MAX_RETRIES) {
                        retries++;
                        const retryDelay = DIRECT_RATE_LIMIT_RETRY_MS;
                        console.log(`[Mercari Axios] Rate limited (429) on page ${page + 1}. Retrying in ${retryDelay}ms...`);
                        await delay(retryDelay, signal);
                        // Retry loop will regenerate DPoP
                    } else if (err.response && err.response.status === 429) {
                        throw new MercariRateLimitError();
                    } else {
                        throw err; // Propagate other errors
                    }
                }
            }

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

            // Emit partial results if callback provided
            if (onProgress) {
                // For streaming, we should support passing partial results up.
                // However, `loggedPromise` in index.js handles generic chunking.
                // Ideally we call onProgress directly here.
                // But index.js expects `onProgress` to take `{ type: 'result', items: ... }`
                // We'll trust the caller provided standard handler
                onProgress({ items: mapped, partial: true });
            }


            // Update Page Token
            if (response.data.meta && response.data.meta.nextPageToken) {
                allResults._nextPageToken = response.data.meta.nextPageToken;
            } else {
                allResults._nextPageToken = null;
            }

            // Safety break if token didn't change (prevent loop)
            if (page > 0 && !allResults._nextPageToken) break;

            await delay(100, signal); // Reduced polite delay

        } catch (err) {
            if (isAborted(signal, err)) throw abortError();
            if (err instanceof MercariCircuitOpenError) {
                if (allResults.length === 0) return null;
                break;
            }
            if (err instanceof MercariRateLimitError) {
                err.cooldownMs = openDirectCircuit(Date.now(), err.retryAfterMs);
                if (allResults.length === 0) throw err;
                console.warn(`[Mercari Axios] Rate limited after page ${page}; returning ${allResults.length} item(s) already fetched.`);
                break;
            }
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

    browserPromise = puppeteer.launch({
        headless: true,
        executablePath: resolveBrowserExecutable(),
        pipe: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu']
    }).catch(err => {
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}


function reset({ resetRateLimitCircuit = false } = {}) {
    consecutiveTimeouts = 0;
    isDisabled = false;
    if (resetRateLimitCircuit) {
        directCircuitState = 'closed';
        directCircuitOpenUntil = 0;
    }
    console.log('Mercari Scraper state reset.');
}

async function performSearch(query, strictEnabled, filters, signal = null) {
    // Optimization: Mercari doesn't support negative search terms in the URL query.
    // Also, Mercari's search engine interprets quotes differently, so we search for UNQUOTED terms
    // and rely on our server-side strict filtering (lines 241+) to enforce quotes if present.
    let effectiveQuery = getSearchTerms(query).replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`[Mercari] Searching for: "${effectiveQuery}" (Original: "${query}", Filters applied post-fetch)`);

    let context = null;
    let page = null;
    let timeoutHandle = null;
    let abortHandler = null;

    const closeSearchResources = async () => {
        if (page) {
            try { await page.close(); } catch (e) { }
            page = null;
        }
        if (context) {
            try { await context.close(); } catch (e) { }
            context = null;
        }
    };

    // Search Logic Promise
    const runSearch = async () => {
        throwIfAborted(signal);
        console.log(`Searching Mercari for ${effectiveQuery}...`);

        const MAX_PAGES = 30; // Increased to 30 for deep scraping fallback
        let allResults = [];

        const browser = await getBrowser();
        throwIfAborted(signal);
        context = await browser.createBrowserContext();
        throwIfAborted(signal);
        page = await context.newPage();
        throwIfAborted(signal);

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
            throwIfAborted(signal);
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            throwIfAborted(signal);

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

    const abortPromise = signal && new Promise((resolve, reject) => {
        abortHandler = () => {
            void closeSearchResources();
            reject(abortError());
        };
        signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
        throwIfAborted(signal);
        const result = await Promise.race([runSearch(), timeoutPromise, abortPromise].filter(Boolean));

        if (result === 'TIMEOUT') {
            throw new Error('TIMEOUT'); // Throw so wrapper catches it
        }

        clearTimeout(timeoutHandle);
        return result;

    } finally {
        signal?.removeEventListener('abort', abortHandler);
        await closeSearchResources();
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
async function searchNeokyo(query, strictEnabled, filters, signal = null) {
    // Mercari doesn't support negative filters natively via API usually, but Neokyo might pass it through?
    // User requested using '-' for filtered terms.
    let effectiveQuery = query;
    if (filters && filters.length > 0) {
        const negativeTerms = filters.map(f => `-${f}`).join(' ');
        effectiveQuery = `${query} ${negativeTerms}`;
        console.log(`[Mercari Fallback] Optimized search with negative terms: "${effectiveQuery}"`);
    }

    console.log(`[Mercari Fallback] Searching Neokyo for ${effectiveQuery}...`);
    throwIfAborted(signal);
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
            timeout: 15000,
            signal
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
            await delay(DELAY_BETWEEN_PAGES, signal);
            throwIfAborted(signal);
            const pageUrl = buildNeokyoUrl(effectiveQuery, page);

            try {
                const pRes = await axios.get(pageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                    timeout: 15000,
                    signal
                });
                const $p = cheerio.load(pRes.data);
                const pResults = parsePageResults($p);
                if (pResults.length === 0) break;
                allResults.push(...pResults);
            } catch (err) {
                if (isAborted(signal, err)) throw abortError();
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
        if (isAborted(signal, error)) throw abortError();
        console.error(`[Mercari Fallback] Error: ${error.message}`);
        return null;
    }
}

function filterDoorzoItems(results, query, strictEnabled, filters, logChanges = true) {
    let filtered = Array.isArray(results) ? results : [];

    if (filters && filters.length > 0) {
        const filterTerms = filters.map(f => String(f).trim().toLowerCase()).filter(Boolean);
        const preCount = filtered.length;
        filtered = filtered.filter(item => {
            const titleLower = String(item.title || '').toLowerCase();
            return !filterTerms.some(term => titleLower.includes(term));
        });
        if (logChanges) console.log(`[Mercari Doorzo] Negative filtering removed ${preCount - filtered.length} items.`);
    }

    const parsedQuery = parseQuery(query);
    const hasQuoted = hasQuotedTerms(parsedQuery);
    if (strictEnabled || hasQuoted || (filters && filters.length > 0)) {
        const preCount = filtered.length;
        filtered = filtered.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
        if (logChanges) console.log(`[Mercari Doorzo] Local filtering: ${preCount} -> ${filtered.length} items.`);
    }

    return filtered;
}

async function searchDoorzo(query, strictEnabled = true, filters = [], signal = null, onProgress = null) {
    console.log(`[Mercari Doorzo] Searching Doorzo for ${query}...`);
    throwIfAborted(signal);

    const emittedKeys = new Set();
    const onPage = onProgress ? pageItems => {
        const filteredPage = filterDoorzoItems(pageItems, query, strictEnabled, filters, false)
            .filter(item => {
                const key = resultKey(item);
                if (emittedKeys.has(key)) return false;
                emittedKeys.add(key);
                return true;
            });
        if (filteredPage.length > 0) onProgress({ items: filteredPage, partial: true });
    } : null;
    const results = await withAbort(doorzo.search(query, 'mercari', signal, onPage), signal);
    throwIfAborted(signal);
    if (results === null) return null;

    return filterDoorzoItems(results, query, strictEnabled, filters);
}

function resultKey(item) {
    const link = String(item?.link || '').trim();
    if (link) return link.split(/[?#]/, 1)[0].replace(/\/$/, '');
    return item;
}

function mergeUniqueResults(...groups) {
    const merged = [];
    const seen = new Set();

    for (const group of groups) {
        for (const item of group || []) {
            const key = resultKey(item);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
        }
    }

    return merged;
}

async function search(query, strictEnabled = true, filters = [], onProgress = null, signal = null) {

    throwIfAborted(signal);

    if (isDisabled) {
        console.log(`Mercari skipped (Disabled due to ${consecutiveTimeouts} consecutive timeouts).`);
        return [];
    }

    // Doorzo is fast but broad searches can omit valid older listings. Run a
    // bounded newest-first native pass alongside it and merge by canonical URL.
    const doorzoPromise = (async () => {
        try {
            return await searchDoorzo(query, strictEnabled, filters, signal, onProgress);
        } catch (err) {
            if (isAborted(signal, err)) throw abortError();
            console.warn(`[Mercari] Doorzo error: ${err.message}.`);
            return null;
        }
    })();

    const freshnessController = new AbortController();
    let freshnessTimedOut = false;
    const onSearchAbort = () => freshnessController.abort(signal?.reason);
    signal?.addEventListener('abort', onSearchAbort, { once: true });
    const freshnessDeadline = setTimeout(() => {
        freshnessTimedOut = true;
        freshnessController.abort();
    }, FRESHNESS_DEADLINE_MS);
    freshnessDeadline.unref?.();

    const directPromise = mercariFreshnessPool.run(async () => {
        const directAttempt = beginDirectSearch();
        if (!directAttempt.allowed) {
            console.log('[Mercari] Direct API rate-limit circuit breaker active. Skipping freshness pass.');
            return null;
        }

        try {
            return await searchAxios(query, strictEnabled, filters, null, freshnessController.signal, {
                sort: 'SORT_CREATED_TIME',
                maxPages: 2,
                timeoutMs: 3000
            });
        } catch (err) {
            if (signal?.aborted) throw abortError();
            if (freshnessController.signal.aborted) return null;
            if (isAborted(null, err)) throw abortError();
            if (err instanceof MercariRateLimitError) {
                const cooldownSeconds = Math.ceil(err.cooldownMs / 1000);
                console.warn(`[Mercari] Direct API rate-limit circuit breaker opened for ${cooldownSeconds} seconds.`);
            } else {
                console.warn(`[Mercari] Axios critical error: ${err.message}.`);
            }
            return null;
        } finally {
            completeDirectSearch(directAttempt.probe);
        }
    }, { signal: freshnessController.signal }).catch(err => {
        if (signal?.aborted) throw abortError();
        if (freshnessController.signal.aborted) return null;
        if (isAborted(null, err)) throw abortError();
        console.warn(`[Mercari] Freshness admission failed: ${err.message}.`);
        return null;
    }).finally(() => {
        clearTimeout(freshnessDeadline);
        signal?.removeEventListener('abort', onSearchAbort);
        if (freshnessTimedOut) console.warn(`[Mercari] Freshness pass exceeded ${FRESHNESS_DEADLINE_MS}ms; using proxy results.`);
    });

    const [doorzoResults, directResults] = await Promise.all([doorzoPromise, directPromise]);
    throwIfAborted(signal);

    if (doorzoResults !== null || directResults !== null) {
        const uniqueDirectResults = mergeUniqueResults(directResults);
        const merged = mergeUniqueResults(uniqueDirectResults, doorzoResults);

        if (onProgress && uniqueDirectResults.length > 0) {
            const doorzoKeys = new Set((doorzoResults || []).map(resultKey));
            const nativeOnly = uniqueDirectResults.filter(item => !doorzoKeys.has(resultKey(item)));
            if (nativeOnly.length > 0) onProgress({ items: nativeOnly, partial: true });
        }

        console.log(`[Mercari] Freshness merge successful (native=${uniqueDirectResults.length}, Doorzo=${doorzoResults?.length ?? 0}, merged=${merged.length}).`);
        return merged;
    }

    console.warn('[Mercari] Doorzo and direct API failed, falling back to Neokyo...');

    // Neokyo (Fast/Axios)
    try {
        console.log('[Mercari] Attempting Fallback: Neokyo...');
        const neokyoResults = await searchNeokyo(query, strictEnabled, filters, signal);
        if (neokyoResults !== null) {
            console.log(`[Mercari] Neokyo search successful (${neokyoResults.length} items).`);
            return neokyoResults;
        }
    } catch (err) {
        if (isAborted(signal, err)) throw abortError();
        console.warn(`[Mercari] Neokyo error: ${err.message}.`);
    }

    // Priority 4: DEJapan (Fast/Axios + Full Titles)
    try {
        const dejapanResults = await withAbort(dejapan.search(query, strictEnabled, filters, signal), signal);
        if (dejapanResults !== null) {
            console.log(`[Mercari] DEJapan search successful (${dejapanResults.length} items).`);
            return dejapanResults;
        }
        console.warn('[Mercari] DEJapan failed (returned null), falling back to native scraper...');
    } catch (err) {
        if (isAborted(signal, err)) throw abortError();
        console.warn(`[Mercari] DEJapan error: ${err.message}, falling back to native scraper...`);
    }

    // Priority 5: Native Scraper (Puppeteer) - Ultimate Fallback
    // Only used if ALL direct/proxy methods fail.
    console.log('[Mercari] All Axios methods failed. Attempting Native (Puppeteer) fallback...');
    const MAX_RETRIES = 1;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
            return await browserPool.run(() => performSearch(query, strictEnabled, filters, signal), { signal });
        } catch (error) {
            if (isAborted(signal, error)) throw abortError();
            console.error(`[Mercari] Native Attempt ${attempt}/${MAX_RETRIES + 1} failed: ${error.message}`);
            if (error.message === 'TIMEOUT' && attempt === MAX_RETRIES + 1) {
                consecutiveTimeouts++;
                if (consecutiveTimeouts >= 5) isDisabled = true;
            }
            if (attempt <= MAX_RETRIES) await delay(5000, signal);
        }
    }

    return [];
}


module.exports = { search, reset, searchAxios, searchDoorzo, searchNeokyo, getNativeRateLimitStats };
