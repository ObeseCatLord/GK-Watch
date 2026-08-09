const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');
const axiosRetry = require('axios-retry').default;
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Bottleneck = require('bottleneck');
const { resolveBrowserExecutable } = require('../utils/browserExecutable');
const { browserPool } = require('../utils/admissionControl');

const COOKIES_FILE = path.join(__dirname, '../data/yahoo_cookies.json');
const YAHOO_AUTH_COOKIE_NAMES = new Set(['A', 'T', 'Y', 'XA']);
const YAHOO_SEARCH_HOST = 'auctions.yahoo.co.jp';
const YAHOO_SEARCH_PATH = '/search/search';
const YAHOO_BLOCK_MARKERS = [
    'captcha',
    'unusual traffic',
    'access denied',
    'security check',
    'ロボットではない',
    'アクセスが集中',
    'しばらく時間をおいて'
];

function abortError() {
    const error = new Error('Yahoo search aborted');
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

// --- ROBUST HTTP CLIENT CONFIGURATION ---

// 1. Configure Persistent Agents (Keep-Alive) to prevent socket exhaustion
const agentConfig = {
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 60000
};

const httpAgent = new http.Agent(agentConfig);
const httpsAgent = new https.Agent(agentConfig);

function envInteger(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// 2. Create Axios Instance with default headers and agents
const client = axios.create({
    baseURL: 'https://auctions.yahoo.co.jp',
    timeout: envInteger('GKWATCH_YAHOO_NATIVE_TIMEOUT_MS', 30000, 5000, 120000),
    httpAgent,
    httpsAgent,
    validateStatus: status => status < 400 || status === 404,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://auctions.yahoo.co.jp/'
    }
});

function responseContainsBlockPage(response) {
    const body = typeof response?.data === 'string' ? response.data.toLowerCase() : '';
    return YAHOO_BLOCK_MARKERS.some(marker => body.includes(marker));
}

function isYahooBlockingResponse(response) {
    const status = Number(response?.status);
    return status === 403 || status === 429 || responseContainsBlockPage(response);
}

// Retry transient transport/upstream errors with a fresh timeout budget on every
// attempt. Definite blocking responses are handled by the provider cooldown and
// must not be amplified by immediate retries.
axiosRetry(client, {
    retries: 2,
    shouldResetTimeout: true,
    retryDelay: (retryCount) => {
        console.log(`[Yahoo Native] Request failed. Retrying attempt #${retryCount}...`);
        return Math.max(2000, axiosRetry.exponentialDelay(retryCount));
    },
    retryCondition: (error) => {
        if (error.config?.signal?.aborted) return false;
        if (isYahooBlockingResponse(error.response)) return false;
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
            (error.response && error.response.status >= 500 && error.response.status <= 599);
    }
});

// Yahoo tolerated high serial volume in testing but began challenge-blocking Foundry
// under concurrent bursts. Keep native requests single-flight process-wide.
const nativeMinTimeMs = envInteger('GKWATCH_YAHOO_NATIVE_MIN_TIME_MS', 750, 250, 10000);
const limiter = new Bottleneck({
    minTime: nativeMinTimeMs,
    maxConcurrent: 1
});

const nativeBlockCooldownMs = envInteger('GKWATCH_YAHOO_NATIVE_BLOCK_COOLDOWN_MS', 15 * 60 * 1000, 60000, 60 * 60 * 1000);
let nativeCooldownUntil = 0;
let nativeCooldownReason = null;

// Wrap the Axios GET method with rate limiting
const scheduledGet = limiter.wrap(async (url, config) => {
    // Searches can queue while another request discovers a block. Recheck at
    // execution time so already-queued terms cannot extend the block or clear it.
    if (nativeCooldownUntil > Date.now()) throw nativeCooldownError();
    try {
        const response = await client.get(url, config);
        if (isYahooBlockingResponse(response)) {
            const error = new Error(`Yahoo returned a challenge page (HTTP ${response.status})`);
            error.code = 'YAHOO_BLOCKED';
            error.response = response;
            throw error;
        }
        return response;
    } catch (error) {
        recordNativeFailure(error);
        throw error;
    }
});

// --- HELPER FUNCTIONS ---

function loadCookies() {
    try {
        try {
            fs.accessSync(COOKIES_FILE, fs.constants.R_OK);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }

        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
        return Array.isArray(cookies) && cookies.length > 0 ? cookies : null;
    } catch (error) {
        console.error('[Yahoo] Error loading cookies:', error.message);
        return null;
    }
}

function isUsableYahooCookie(cookie, nowSeconds = Date.now() / 1000) {
    if (!cookie || typeof cookie !== 'object') return false;
    const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    const name = String(cookie.name || '');
    const value = cookie.value;
    const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
    const isYahooDomain = domain === 'yahoo.co.jp' || domain.endsWith('.yahoo.co.jp');
    const domainMatches = cookie.hostOnly
        ? domain === YAHOO_SEARCH_HOST
        : YAHOO_SEARCH_HOST === domain || YAHOO_SEARCH_HOST.endsWith(`.${domain}`);
    const pathMatches = YAHOO_SEARCH_PATH === cookiePath ||
        YAHOO_SEARCH_PATH.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
    if (!isYahooDomain || !domainMatches || !pathMatches) return false;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return false;
    if (value === undefined || value === '' || /[\u0000-\u001f\u007f;]/.test(String(value))) return false;
    if (cookie.expirationDate != null) {
        const expirationDate = Number(cookie.expirationDate);
        if (!Number.isFinite(expirationDate) || expirationDate <= nowSeconds) return false;
    }
    return true;
}

function cookiesToHeader(cookies) {
    if (!Array.isArray(cookies)) return '';
    return cookies
        .filter(cookie => isUsableYahooCookie(cookie))
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

function hasValidCookies(cookies = loadCookies()) {
    return Array.isArray(cookies) && cookies.some(cookie =>
        isUsableYahooCookie(cookie) && YAHOO_AUTH_COOKIE_NAMES.has(String(cookie.name))
    );
}

function getSearchStrategy(cookies, { mode = 'watch' } = {}) {
    if (hasValidCookies(cookies)) return 'authenticated-native';
    return mode === 'live' ? 'native-first' : 'doorzo-first';
}

function nativeCooldownError() {
    const remainingMs = Math.max(0, nativeCooldownUntil - Date.now());
    const error = new Error(`Yahoo native temporarily unavailable (${nativeCooldownReason || 'cooldown'}, ${Math.ceil(remainingMs / 1000)}s remaining)`);
    error.code = 'YAHOO_NATIVE_COOLDOWN';
    return error;
}

function openNativeCooldown(reason, durationMs) {
    const nextUntil = Date.now() + durationMs;
    if (nextUntil > nativeCooldownUntil) {
        nativeCooldownUntil = nextUntil;
        nativeCooldownReason = reason;
        console.warn(`[Yahoo Native] Opening ${Math.ceil(durationMs / 1000)}s cooldown after ${reason}.`);
    }
}

function recordNativeFailure(error) {
    if (isYahooBlockingResponse(error?.response)) {
        openNativeCooldown(`HTTP ${error.response?.status || 'challenge'} block`, nativeBlockCooldownMs);
    }
}

function resetNativeState() {
    nativeCooldownUntil = 0;
    nativeCooldownReason = null;
}

function getNativeState() {
    const cooldown = nativeCooldownUntil > Date.now();
    return {
        cooldown,
        cooldownUntil: cooldown ? nativeCooldownUntil : null,
        cooldownReason: cooldown ? nativeCooldownReason : null,
        minTimeMs: nativeMinTimeMs,
        maxConcurrent: 1
    };
}

function stripCookieOnUnsafeRedirect(options) {
    const isSafeTarget = String(options?.hostname || '').toLowerCase() === YAHOO_SEARCH_HOST &&
        String(options?.protocol || '').toLowerCase() === 'https:';
    if (isSafeTarget || !options?.headers) return;
    for (const headerName of Object.keys(options.headers)) {
        if (headerName.toLowerCase() === 'cookie') delete options.headers[headerName];
    }
}

function formatYahooPrice(priceText) {
    if (!priceText || priceText === 'N/A') return 'N/A';
    // Remove existing ¥, 円, commas, spaces and extract number
    const cleaned = priceText.replace(/[¥円,\s]/g, '').trim();
    const match = cleaned.match(/\d+/);
    if (match) {
        return `¥${Number(match[0]).toLocaleString()}`;
    }
    return 'N/A';
}

function calculateEndTime(timeStr) {
    if (!timeStr) return null;

    const now = Date.now();
    let durationMs = 0;

    // Yahoo formats: "3日", "16時間", "10分", "10秒"
    // Doorzo formats: "6 Days", "10 Hours", etc.

    const cleanStr = timeStr.toLowerCase().replace(/,/g, '');

    if (cleanStr.includes('日') || cleanStr.includes('day')) {
        const days = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = days * 24 * 60 * 60 * 1000;
    } else if (cleanStr.includes('時間') || cleanStr.includes('hour')) {
        const hours = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = hours * 60 * 60 * 1000;
    } else if (cleanStr.includes('分') || cleanStr.includes('min')) {
        const minutes = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = minutes * 60 * 1000;
    } else if (cleanStr.includes('秒') || cleanStr.includes('sec')) {
        const seconds = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = seconds * 1000;
    }

    if (durationMs > 0) {
        return new Date(now + durationMs).toISOString(); // Return ISO timestamp
    }

    return null;
}

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

function sleep(ms, signal) {
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

// --- SEARCH FUNCTIONS ---

async function search(query, strictEnabled = true, allowInternationalShipping = false, targetSource = 'all', filters = [], signal = null, options = {}) {
    console.log(`Searching Yahoo Auctions for ${query} (Target: ${targetSource})...`);
    throwIfAborted(signal);
    const cookies = loadCookies();
    const fallbackEnabled = options.fallback !== false;
    const searchStrategy = options.provider === 'native'
        ? 'native-first'
        : options.provider === 'doorzo'
            ? 'doorzo-first'
            : getSearchStrategy(cookies, options);
    const cookieHeader = options.useCookies !== false &&
        (searchStrategy === 'authenticated-native' || options.provider === 'native') && hasValidCookies(cookies)
        ? cookiesToHeader(cookies)
        : '';
    let doorzoAttempted = false;
    let lastProviderError = null;

    // Watch runs remain on Doorzo unless authenticated. Live searches use native
    // Yahoo first and fall back to Doorzo when native is unavailable.
    if (searchStrategy === 'doorzo-first') {
        doorzoAttempted = true;
        try {
            const doorzoResults = await searchDoorzo(query, strictEnabled, allowInternationalShipping, targetSource, filters, signal);
            if (doorzoResults !== null) {
                console.log(`[Yahoo] Doorzo API successful (${doorzoResults.length} items). Skipping Native.`);
                return doorzoResults;
            }
            lastProviderError = new Error('Doorzo returned no completion result');
        } catch (doorzoError) {
            if (isAborted(signal, doorzoError)) throw abortError();
            lastProviderError = doorzoError;
            console.warn(`[Yahoo] Doorzo API failed (${doorzoError.message}), falling back to Native Axios...`);
        }
        if (!fallbackEnabled) throw lastProviderError;
    } else {
        console.log(searchStrategy === 'authenticated-native'
            ? '[Yahoo] Valid login cookies found. Using authenticated Native search first.'
            : '[Yahoo] Live search using Native Yahoo first.');
    }

    // Chain 2: Robust Native Axios Scraper (Fallback - Deep Search)
    try {
        if (nativeCooldownUntil > Date.now()) throw nativeCooldownError();
        let results = [];
        const MAX_PAGES = 200;
        const seenLinks = new Set();
        const itemsPerPage = 50;
        const searchScopes = cookieHeader && targetSource !== 'paypay'
            ? [
                { name: 'adult', querySuffix: '&auccat=26146&tab_ex=commerce&ei=utf-8' },
                { name: 'standard', querySuffix: '' }
            ]
            : [{ name: 'standard', querySuffix: '' }];
        let completedScopeCount = 0;
        let lastScopeError = null;
        let terminalNativeError = null;

        console.log(`[Yahoo Fallback] Starting Native Axios Scraper for ${query}...`);

        for (const scope of searchScopes) {
            let page = 0;
            let scopeCompleted = false;

            while (page < MAX_PAGES) {
                throwIfAborted(signal);
                try {
                    // Yahoo pagination: b=1 (page 1), b=51 (page 2), b=101 (page 3)
                    const offset = page * itemsPerPage + 1;
                    const url = `/search/search?p=${encodeURIComponent(query)}&b=${offset}&n=${itemsPerPage}${scope.querySuffix}`;

                    // Use the throttled, resilient client
                    // Note: client base URL is set, so we just pass the path
                    const response = await scheduledGet(url, {
                        signal,
                        ...(cookieHeader ? {
                            headers: { Cookie: cookieHeader },
                            beforeRedirect: stripCookieOnUnsafeRedirect
                        } : {})
                    });
                    if (isYahooBlockingResponse(response)) {
                        const error = new Error(`Yahoo returned a challenge page (HTTP ${response.status})`);
                        error.code = 'YAHOO_BLOCKED';
                        error.response = response;
                        throw error;
                    }
                    const data = response.data;

                    // Check for "Page Not Found" or "Invalid Page"
                    if (data.includes('お探しのページは見つかりませんでした') || data.includes('ご指定のページが見つかりません')) {
                        if (page === 0) {
                            const error = new Error(`Yahoo ${scope.name} search page invalid/404`);
                            error.code = 'YAHOO_INVALID_PAGE';
                            throw error;
                        }
                        break; // Stop pagination if page is empty/404
                    }
                    scopeCompleted = true;

                    // Check for "Partial Match" (Soft Match) - Yahoo returns broad results when exact match fails
                    // Text: "一致する商品はありません。キーワードの一部を利用した結果を表示しています"
                    if (data.includes('キーワードの一部を利用した結果を表示しています')) {
                        console.log(`[Yahoo Native] [${query}] ${scope.name} partial match detected. Stopping to avoid irrelevant results.`);
                        break;
                    }

                    const $ = cheerio.load(data);
                    let pageResults = [];

                    $('.Products__items li.Product').each((i, element) => {
                        try {
                            // International Shipping Filter
                            if (!allowInternationalShipping) {
                                const fullText = $(element).text();
                                if (fullText.includes('海外から発送')) {
                                    return; // Skip this item
                                }
                            }

                            const titleEl = $(element).find('.Product__titleLink');
                            const title = titleEl.text().trim();
                            const link = titleEl.attr('href');
                            const imageEl = $(element).find('.Product__imageData');
                            const image = imageEl.attr('src');

                            const timeEl = $(element).find('.Product__time');
                            const timeStr = timeEl.text().trim();
                            const endTime = calculateEndTime(timeStr);

                            const isPayPay = $(element).find('.Product__icon').text().includes('Yahoo!フリマ') || (link && link.includes('paypayfleamarket'));

                            if (targetSource === 'yahoo' && isPayPay) return;
                            if (targetSource === 'paypay' && !isPayPay) return;

                            const itemSource = isPayPay ? 'PayPay Flea Market' : 'Yahoo';

                            const priceElements = $(element).find('.Product__priceValue');
                            let bidPrice = '';
                            let binPrice = '';

                            if (priceElements.length >= 1) bidPrice = $(priceElements[0]).text().trim();
                            if (priceElements.length >= 2) binPrice = $(priceElements[1]).text().trim();

                            const price = bidPrice || 'N/A';

                            if (title && link) {
                                pageResults.push({
                                    title,
                                    link,
                                    image: image || '',
                                    price: formatYahooPrice(price),
                                    bidPrice: formatYahooPrice(bidPrice),
                                    binPrice: formatYahooPrice(binPrice),
                                    endTime,
                                    source: itemSource
                                });
                            }
                        } catch (err) {
                            console.error('Error parsing yahoo item:', err);
                        }
                    });

                    if (pageResults.length === 0) break; // Stop if no items found

                    // Deduplicate across pages and standard/adult search scopes.
                    const newResults = pageResults.filter(item => {
                        if (seenLinks.has(item.link)) return false;
                        seenLinks.add(item.link);
                        return true;
                    });

                    if (newResults.length === 0) {
                        console.log(`[Yahoo Native] [${query}] ${scope.name} page ${page + 1}: all items duplicates. Stopping.`);
                        break;
                    }

                    console.log(`[Yahoo Native] [${query}] ${scope.name} page ${page + 1} found ${newResults.length} new items.`);
                    results = results.concat(newResults);

                    // Early stop if last page (fewer items than requested)
                    if (pageResults.length < itemsPerPage) {
                        console.log(`[Yahoo Native] [${query}] ${scope.name} page ${page + 1} had ${pageResults.length} items (< ${itemsPerPage}). Last page reached.`);
                        break;
                    }

                    page++;

                } catch (err) {
                    if (isAborted(signal, err)) throw abortError();
                    lastScopeError = err;
                    console.warn(`[Yahoo Native] [${query}] ${scope.name} error on page ${page + 1} (${err.message}). Continuing with ${results.length} items found so far.`);
                    // An unauthenticated/expired adult scope may return Yahoo's normal
                    // 404 page. Continue to standard search, but treat all transport,
                    // timeout, block, and later-page failures as incomplete native runs.
                    const harmlessMissingScope = page === 0 && err.code === 'YAHOO_INVALID_PAGE' &&
                        (scope.name === 'adult' || results.length > 0);
                    if (!harmlessMissingScope) {
                        terminalNativeError = err;
                    }
                    break;
                }
            }

            if (scopeCompleted) completedScopeCount++;
            if (terminalNativeError) break;
        }

        if (terminalNativeError) throw terminalNativeError;
        if (completedScopeCount === 0 && lastScopeError) throw lastScopeError;

        // Apply negative filtering (server-side)
        if (filters && filters.length > 0) {
            const filterTerms = filters.map(f => f.toLowerCase());
            const preCount = results.length;
            results = results.filter(item => {
                const titleLower = item.title.toLowerCase();
                return !filterTerms.some(term => titleLower.includes(term));
            });
            console.log(`[Yahoo] Server-side negative filtering removed ${preCount - results.length} items. Remaining: ${results.length}`);
        }

        // Strict filtering
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const strictResults = results.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`Yahoo (Axios) found ${results.length} items, ${strictResults.length} after strict filtering.`);
            resetNativeState();
            return strictResults;
        }

        console.log(`Yahoo (Axios) found ${results.length} items (Strict filtering disabled).`);
        resetNativeState();
        return results;

    } catch (axiosError) {
        if (isAborted(signal, axiosError)) throw abortError();
        recordNativeFailure(axiosError);
        lastProviderError = axiosError;
        console.warn(`[Yahoo] Native Axios failed (${axiosError.message}).`);

        if (!doorzoAttempted && fallbackEnabled) {
            doorzoAttempted = true;
            console.warn('[Yahoo] Falling back from Native Yahoo to Doorzo...');
            try {
                const doorzoResults = await searchDoorzo(query, strictEnabled, allowInternationalShipping, targetSource, filters, signal);
                if (doorzoResults !== null) return doorzoResults;
                lastProviderError = new Error('Doorzo returned no completion result');
            } catch (doorzoError) {
                if (isAborted(signal, doorzoError)) throw abortError();
                lastProviderError = doorzoError;
            }
        }

        if (!fallbackEnabled) throw lastProviderError;
        console.warn(`[Yahoo] Primary providers failed (${lastProviderError.message}), switching to Neokyo fallback...`);
    }

    // Chain 3: Neokyo (Puppeteer)
    try {
        const neokyoResults = await browserPool.run(() => searchNeokyo(query, signal), { signal });
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            return neokyoResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
        }
        return neokyoResults;
    } catch (neokyoError) {
        if (isAborted(signal, neokyoError)) throw abortError();
        console.warn(`Neokyo failed (${neokyoError.message}), attempting Jauce fallback...`);
    }

    // Chain 4: Jauce (last resort)
    const jauceResults = await searchJauce(query, signal);
    const parsedQuery = parseQuery(query);
    const hasQuoted = hasQuotedTerms(parsedQuery);

    if (strictEnabled || hasQuoted) {
        return jauceResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
    }
    return jauceResults;
}

// Doorzo-based Yahoo Scraper (Fallback for Axios)
async function searchDoorzo(query, strictEnabled = true, allowInternationalShipping = false, targetSource = 'all', filters = [], signal = null) {
    console.log(`[Yahoo Fallback] Searching Yahoo via Doorzo for ${query}...`);
    throwIfAborted(signal);
    const ENDPOINT = 'https://sig.doorzo.com/';

    // URL Params for the signature endpoint
    const urlParams = {
        n: 'Sig.Front.SubSite.AppYahoo.Search',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        deviceId: generateDeviceId()
    };

    // Body Params for the search Query
    const bodyBase = {
        keyword: query,
        keywords: query,
        fixed: '1',
        goodsStatus: '',
        sellerType: '',
        pType: 'currentprice',
        shipmentType: '', // Note: 'domestic' breaks Doorzo pagination (wraps at page 2). No API field to post-filter either.
        is_appraisal: ''
    };

    let allItems = [];
    let page = 1;
    const MAX_PAGES = 200; // Deep search cap
    const seenIds = new Set();

    try {
        // Construct basic query string for the URL
        const queryString = Object.keys(urlParams)
            .map(key => `${key}=${encodeURIComponent(urlParams[key])}`)
            .join('&');
        const fullUrl = `${ENDPOINT}?${queryString}`;

        do {
            throwIfAborted(signal);
            const currentBody = { ...bodyBase, page: page };

            const res = await axios.post(fullUrl, currentBody, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://www.doorzo.com',
                    'Referer': 'https://www.doorzo.com/'
                },
                timeout: 30000,
                signal
            });

            if (res.data && res.data.data && Array.isArray(res.data.data.list)) {
                const items = res.data.data.list;
                if (items.length === 0) break; // End of results

                // Duplicate detection: stop if pagination wraps around
                let newCount = 0;
                for (const item of items) {
                    const id = item.Asin || item.Url;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        allItems.push(item);
                        newCount++;
                    }
                }

                console.log(`[Yahoo] Doorzo page ${page}: ${items.length} items (${newCount} new).`);

                if (newCount === 0) {
                    console.log(`[Yahoo] Doorzo pagination wraparound detected at page ${page}. Stopping.`);
                    break;
                }

                page++;

                // Be nice to the API
                if (page <= MAX_PAGES) await sleep(500, signal);

            } else {
                // End of results or invalid response
                break;
            }
        } while (page <= MAX_PAGES);

        let results = [];
        if (allItems.length > 0) {

            results = allItems.map(item => {
                // Use Asin for ID if available, otherwise try to extract from Url
                let link = '';
                if (item.Asin) {
                    link = `https://page.auctions.yahoo.co.jp/jp/auction/${item.Asin}`;
                } else if (item.Url) {
                    // Try to decode hex if Asin is missing (unlikely for Yahoo on Doorzo)
                    try {
                        const decoded = Buffer.from(item.Url, 'hex').toString('utf8');
                        link = decoded;
                    } catch {
                        link = `https://page.auctions.yahoo.co.jp/jp/auction/${item.Url}`;
                    }
                }

                // Check for PayPay Flea Market indicator
                // Doorzo might mix them? If website='yahoo', likely pure yahoo.
                const isPayPay = false; // Doorzo 'yahoo' endpoint usually filters to yahoo auctions

                const itemSource = 'Yahoo';

                // Format price: 15000 -> "¥15,000"
                const bidPrice = item.BidJPYPrice ? `¥${Number(item.BidJPYPrice).toLocaleString()}` : 'N/A';
                const binPrice = item.BuyNowPrice ? `¥${Number(item.BuyNowPrice).toLocaleString()}` : 'N/A';
                const price = bidPrice !== 'N/A' ? bidPrice : binPrice;

                return {
                    title: item.Name,
                    link,
                    image: item.ImageUrl,
                    price,
                    bidPrice,
                    binPrice,
                    endTime: calculateEndTime(item.RemainingTime),
                    source: itemSource
                };
            });

            console.log(`[Yahoo Fallback] Doorzo found ${results.length} total items.`);
        }

        // Apply Strict Filtering if enabled
        // Parsing is same as before
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const strictResults = results.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`[Yahoo Fallback] Doorzo found ${results.length} items, ${strictResults.length} after strict filtering.`);
            return strictResults;
        }

        return results;

    } catch (err) {
        if (isAborted(signal, err)) throw abortError();
        console.error('Doorzo Yahoo Fallback Error:', err.message);
        return null; // Return null to trigger next fallback
    }
}

async function searchNeokyo(query, signal = null) {
    console.log(`[Yahoo Fallback] Searching Neokyo (Puppeteer) for ${query}...`);
    let browser;
    let page;
    let abortHandler = null;

    const closeSearchResources = async () => {
        if (page) {
            try { await page.close(); } catch (e) { }
            page = null;
        }
        if (browser) {
            try { await browser.close(); } catch (e) { }
            browser = null;
        }
    };

    if (signal) {
        abortHandler = () => { void closeSearchResources(); };
        signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
        throwIfAborted(signal);
        browser = await puppeteer.launch({
            headless: true,
            executablePath: resolveBrowserExecutable(),
            args: ['--disable-dev-shm-usage']
        });
        throwIfAborted(signal);
        page = await browser.newPage();
        throwIfAborted(signal);

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Step 1: Go to homepage (10s timeout for faster fallback)
        await page.goto('https://neokyo.com/en', { waitUntil: 'domcontentloaded', timeout: 10000 });
        throwIfAborted(signal);

        // Step 2: Input Query
        await page.waitForSelector('.main-search-input', { timeout: 3000 });
        await page.type('.main-search-input', query);

        // Step 3: Submit (Use evaluate to avoid click errors)
        const submitted = await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn) {
                btn.click();
                return true;
            }
            const input = document.querySelector('.main-search-input');
            const form = input ? input.closest('form') : null;
            if (form) {
                form.submit();
                return true;
            }
            return false;
        });

        if (submitted) {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { });
        } else {
            console.log("Submit button/form not found, trying Enter key...");
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { });
        }

        // Step 4: Parse Results
        const content = await page.content();
        const $ = cheerio.load(content);
        const results = [];

        $('a').each((i, element) => {
            const link = $(element).attr('href');
            if (link && (link.includes('yahoo-auction/item/') || link.includes('yahoo/auction'))) {
                const title = $(element).text().trim();
                const img = $(element).find('img').attr('src') || '';
                const priceText = $(element).text().match(/[0-9,]+ yen/);
                const price = priceText ? priceText[0].replace(' yen', '') : 'N/A';

                const fullLink = link.startsWith('http') ? link : `https://neokyo.com${link}`;

                results.push({
                    title,
                    link: fullLink,
                    image: img,
                    price: formatYahooPrice(price),
                    source: 'Yahoo (Neokyo)'
                });
            }
        });

        const uniqueResults = results.filter((v, i, a) => a.findIndex(t => (t.link === v.link)) === i);

        console.log(`[Yahoo Fallback] Found ${uniqueResults.length} items on Neokyo.`);
        return uniqueResults;

    } catch (err) {
        if (isAborted(signal, err)) throw abortError();
        console.error('Neokyo Fallback Error:', err.message);
        return null;
    } finally {
        signal?.removeEventListener('abort', abortHandler);
        await closeSearchResources();
    }
}

async function searchJauce(query, signal = null) {
    console.log(`[Yahoo Fallback] Searching Jauce for ${query}...`);
    throwIfAborted(signal);
    try {
        const url = `https://www.jauce.com/search/${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 30000,
            signal
        });

        const $ = cheerio.load(data);
        const results = [];

        $('.article').each((i, element) => {
            try {
                let linkEl = $(element).closest('a');
                let link = linkEl.attr('href');

                if (!link) {
                    link = $(element).find('a').attr('href');
                }

                if (link) {
                    if (!link.startsWith('http')) {
                        link = `https://www.jauce.com${link}`;
                    }
                    link = link.replace('/auction/../auction/', '/auction/');
                }

                const imgEl = $(element).find('.spot img');
                const image = imgEl.attr('src');
                let title = imgEl.attr('alt') || $(element).text().trim();

                if (title && title.includes('</a>')) {
                    title = title.split('</a>')[0].replace(/<[^>]*>/g, '');
                }

                const infoText = $(element).find('.information').text();
                const priceMatch = infoText.match(/Bid:\s*([0-9,]+)/);
                const price = priceMatch ? `¥${priceMatch[1]}` : 'N/A';

                if (title && link) {
                    results.push({
                        title: title.trim(),
                        link,
                        image: image || '',
                        price: formatYahooPrice(price),
                        source: 'Yahoo (Jauce)'
                    });
                }
            } catch (err) {
                // ignore individual item parse errors
            }
        });

        console.log(`[Yahoo Fallback] Found ${results.length} items on Jauce.`);
        return results;

    } catch (err) {
        if (isAborted(signal, err)) throw abortError();
        console.error('Jauce Fallback Error:', err.message);
        return [];
    }
}

module.exports = {
    search,
    searchDoorzo,
    hasValidCookies,
    cookiesToHeader,
    isUsableYahooCookie,
    getSearchStrategy,
    stripCookieOnUnsafeRedirect,
    isYahooBlockingResponse,
    getNativeState,
    resetNativeState
};
