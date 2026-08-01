const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const queryMatcher = require('../utils/queryMatcher');

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Search was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
}

const MANDARAKE_BASE_URL = 'https://order.mandarake.co.jp';
const MANDARAKE_SEARCH_URL = `${MANDARAKE_BASE_URL}/order/listPage/list`;
const COOKIES_FILE = path.join(__dirname, '../data/mandarake_cookies.json');
const DETAIL_CACHE_FILE = path.join(__dirname, '../data/mandarake_detail_cache.json');

const EVERYTHING_CATEGORY_CODE = '00';
const GARAGE_KIT_CATEGORY_CODE = '020107';
const DETAIL_CATEGORY_CONCURRENCY = 4;
const DETAIL_CACHE_VERSION = 1;
const DETAIL_CACHE_MAX_BYTES = 10 * 1024 * 1024;
const DETAIL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_CACHE_MAX_ENTRIES = 5000;
const GARAGE_KIT_CATALOG_TTL_MS = 30 * 60 * 1000;

const DEFAULT_SEARCH_PARAMS = {
    keyword: '',
    categoryCode: EVERYTHING_CATEGORY_CODE,
    shop: '0',
    dispAdult: '0',
    soldOut: '1',
    upToMinutes: '0',
    sort: 'arrival',
    sortOrder: '1',
    dispCount: '240',
    lang: 'ja'
};

const GARAGE_KIT_SUFFIXES = [
    'ガレージキット',
    'レジンキット',
    'レジンキャストキット',
    'レジンキャスト',
    'ガレキ',
    'garage kit',
    'resin kit',
    'resin cast kit'
];

let cachedCookies = null;
let lastCookiesLoadTime = 0;
let detailCacheLoaded = false;
let detailCache = new Map();
let detailFetches = new Map();
let garageKitCatalog = [];
let garageKitCatalogFetchedAt = 0;
let garageKitCatalogRefresh = null;
let detailCacheDirty = false;

function loadCookies() {
    try {
        let stats;
        try {
            stats = fs.statSync(COOKIES_FILE);
        } catch (err) {
            if (err.code === 'ENOENT') {
                cachedCookies = null;
                lastCookiesLoadTime = 0;
                return null;
            }
            throw err;
        }

        if (cachedCookies && stats.mtimeMs <= lastCookiesLoadTime) {
            return cachedCookies;
        }

        const cookieData = fs.readFileSync(COOKIES_FILE, 'utf8');
        const cookies = JSON.parse(cookieData);

        if (!Array.isArray(cookies) || cookies.length === 0) {
            cachedCookies = null;
            lastCookiesLoadTime = 0;
            return null;
        }

        cachedCookies = cookies;
        lastCookiesLoadTime = stats.mtimeMs;
        return cookies;
    } catch (error) {
        console.error('[Mandarake] Error loading cookies:', error.message);
        cachedCookies = null;
        lastCookiesLoadTime = 0;
        return null;
    }
}

function cookiesToHeader(cookies) {
    if (!Array.isArray(cookies)) return '';
    return cookies
        .filter(cookie => cookie && cookie.name && cookie.value !== undefined)
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

function isMandarakeCookie(cookie) {
    const domain = String(cookie.domain || '').toLowerCase();
    const name = String(cookie.name || '').toLowerCase();
    return domain.includes('mandarake.co.jp') || name.includes('mndrk') || name.includes('mandarake');
}

function hasValidCookies() {
    const cookies = loadCookies();
    return Array.isArray(cookies) && cookies.some(isMandarakeCookie);
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isCacheMetadata(value) {
    return value && typeof value === 'object' &&
        typeof value.categoryPath === 'string' &&
        typeof value.itemInformation === 'string' &&
        Number.isFinite(value.fetchedAt) &&
        Number.isFinite(value.lastSeenAt);
}

function sanitizeCatalogItem(value) {
    if (!value || typeof value !== 'object') return null;

    const itemCode = getItemCode(value);
    const title = normalizeText(value.title);
    const link = absoluteUrl(value.link);
    if (!itemCode || !title || !link) return null;

    return {
        title,
        link,
        image: absoluteUrl(value.image),
        price: normalizeText(value.price) || 'N/A',
        source: 'Mandarake',
        shopName: normalizeText(value.shopName),
        itemNo: Array.isArray(value.itemNo) ? value.itemNo.map(normalizeText).filter(Boolean) : [],
        inStorefront: value.inStorefront === true
    };
}

function loadDetailCache() {
    if (detailCacheLoaded) return;
    detailCacheLoaded = true;

    try {
        const stats = fs.statSync(DETAIL_CACHE_FILE);
        if (!stats.isFile() || stats.size > DETAIL_CACHE_MAX_BYTES) {
            console.warn('[Mandarake] Ignoring invalid or oversized detail cache');
            return;
        }

        const stored = JSON.parse(fs.readFileSync(DETAIL_CACHE_FILE, 'utf8'));
        if (!stored || stored.version !== DETAIL_CACHE_VERSION || !stored.entries || typeof stored.entries !== 'object') {
            console.warn('[Mandarake] Ignoring incompatible detail cache');
            return;
        }

        for (const [itemCode, metadata] of Object.entries(stored.entries)) {
            if (/^\d+$/.test(itemCode) && isCacheMetadata(metadata)) {
                detailCache.set(itemCode, {
                    categoryPath: normalizeText(metadata.categoryPath),
                    itemInformation: normalizeText(metadata.itemInformation),
                    fetchedAt: metadata.fetchedAt,
                    lastSeenAt: metadata.lastSeenAt
                });
            }
        }

        const catalogFetchedAt = Number(stored.catalog?.fetchedAt);
        if (Number.isFinite(catalogFetchedAt) && Array.isArray(stored.catalog?.items)) {
            garageKitCatalog = stored.catalog.items.map(sanitizeCatalogItem).filter(Boolean);
            garageKitCatalogFetchedAt = catalogFetchedAt;
        }

        console.log(`[Mandarake] Loaded ${detailCache.size} cached detail record(s).`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[Mandarake] Failed to load detail cache:', error.message);
        }
    }
}

function pruneDetailCache(now = Date.now()) {
    const entries = Array.from(detailCache.entries())
        .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);

    detailCache = new Map(entries.slice(0, DETAIL_CACHE_MAX_ENTRIES));

    for (const [itemCode, metadata] of detailCache) {
        if (now - metadata.lastSeenAt > DETAIL_CACHE_TTL_MS) {
            detailCache.delete(itemCode);
        }
    }
}

function persistDetailCache() {
    loadDetailCache();
    if (!detailCacheDirty) return;

    const now = Date.now();
    pruneDetailCache(now);

    try {
        fs.mkdirSync(path.dirname(DETAIL_CACHE_FILE), { recursive: true, mode: 0o700 });
        const temporary = `${DETAIL_CACHE_FILE}.${process.pid}.tmp`;
        const buildPayload = () => JSON.stringify({
            version: DETAIL_CACHE_VERSION,
            entries: Object.fromEntries(detailCache),
            catalog: { fetchedAt: garageKitCatalogFetchedAt, items: garageKitCatalog }
        });
        let serialized = buildPayload();

        while (Buffer.byteLength(serialized) > DETAIL_CACHE_MAX_BYTES && detailCache.size > 0) {
            const oldestItemCode = Array.from(detailCache.keys()).at(-1);
            detailCache.delete(oldestItemCode);
            serialized = buildPayload();
        }
        if (Buffer.byteLength(serialized) > DETAIL_CACHE_MAX_BYTES) {
            throw new Error('cache payload exceeds size limit');
        }

        fs.writeFileSync(temporary, serialized, { mode: 0o600 });
        fs.renameSync(temporary, DETAIL_CACHE_FILE);
        detailCacheDirty = false;
    } catch (error) {
        console.warn('[Mandarake] Failed to persist detail cache:', error.message);
    }
}

function normalizeMode(options = {}) {
    if (options.mode === 'garageKit' || options.mandarakeMode === 'garageKit') {
        return 'garageKit';
    }
    if (options.categoryCode === GARAGE_KIT_CATEGORY_CODE) {
        return 'garageKit';
    }
    return 'full';
}

function getEffectiveQuery(query, options = {}) {
    const mode = normalizeMode(options);
    let effectiveQuery = String(query || '').trim();

    if (mode === 'garageKit') {
        for (const suffix of GARAGE_KIT_SUFFIXES) {
            const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            effectiveQuery = effectiveQuery
                .replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '')
                .replace(new RegExp(`^${escaped}\\s+`, 'i'), '')
                .trim();
        }
    }

    return effectiveQuery;
}

function buildSearchUrl(query, options = {}) {
    const mode = normalizeMode(options);
    const params = new URLSearchParams({
        ...DEFAULT_SEARCH_PARAMS,
        keyword: getEffectiveQuery(query, options),
        categoryCode: mode === 'garageKit' ? GARAGE_KIT_CATEGORY_CODE : EVERYTHING_CATEGORY_CODE
    });

    return `${MANDARAKE_SEARCH_URL}?${params.toString()}`;
}

function absoluteUrl(value) {
    if (!value) return '';
    const url = String(value).trim();
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return new URL(url, MANDARAKE_BASE_URL).toString();
}

function buildAdultLink(itemCode) {
    if (!itemCode) return '';
    return `${MANDARAKE_BASE_URL}/order/detailPage/item?itemCode=${encodeURIComponent(String(itemCode).trim())}&ref=list`;
}

function buildDetailUrl(itemCode) {
    if (!itemCode) return '';
    return `${MANDARAKE_BASE_URL}/order/detailPage/item?itemCode=${encodeURIComponent(String(itemCode).trim())}&lang=ja`;
}

function getItemCode(itemOrLink) {
    const link = typeof itemOrLink === 'string' ? itemOrLink : itemOrLink?.link;
    if (!link) return '';

    try {
        const url = new URL(link, MANDARAKE_BASE_URL);
        return url.searchParams.get('itemCode') || '';
    } catch (error) {
        const match = String(link).match(/[?&]itemCode=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : '';
    }
}

function parsePrice(priceText) {
    if (!priceText) return 'N/A';
    const match = String(priceText).match(/(?:[¥￥]\s*|)([0-9][0-9,]*)\s*(?:yen|円)?/i);
    if (!match) return 'N/A';

    const amount = Number.parseInt(match[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(amount) || amount <= 0) return 'N/A';
    return `¥${amount.toLocaleString()}`;
}

function parseItemNumber(itemNoText) {
    const text = String(itemNoText || '').trim();
    if (!text) return [];

    const match = text.match(/(.+?)(?:\s*\(([0-9-]+)\))?$/);
    if (!match) return [text];

    return [match[1], match[2]].filter(Boolean).map(part => part.trim());
}

function isAvailable(stockText) {
    const normalized = String(stockText || '').trim().toLowerCase();
    if (!normalized) return true;

    if (normalized.includes('sold') || normalized.includes('売り切れ') || normalized.includes('品切れ')) {
        return false;
    }

    return normalized.includes('in stock') ||
        normalized.includes('store front item') ||
        normalized.includes('在庫あります') ||
        normalized.includes('在庫確認します');
}

function parseResults(html) {
    const $ = cheerio.load(html);
    const results = [];

    $('.entry .thumlarge .block').each((i, entry) => {
        const $entry = $(entry);
        const isAdult = $entry.find('.r18item').length > 0;
        const title = ($entry.find('.title a').first().text() || $entry.find('.title p').first().text()).trim();
        const stockText = $entry.find('.basic .stock').first().text().trim();

        if (!title || !isAvailable(stockText)) {
            return;
        }

        const rawLink = isAdult
            ? buildAdultLink($entry.find('.adult_link').first().attr('id'))
            : absoluteUrl($entry.find('.pic a').first().attr('href'));

        if (!rawLink) {
            return;
        }

        const rawImage = isAdult
            ? $entry.find('.pic .r18item img').first().attr('src')
            : $entry.find('.pic img').first().attr('src');

        const shopName = $entry.find('.basic .shop').first().text().trim();
        const itemNo = parseItemNumber($entry.find('.basic .itemno').first().text());

        results.push({
            title,
            link: rawLink,
            image: absoluteUrl(rawImage),
            price: parsePrice($entry.find('.price').first().text()),
            source: 'Mandarake',
            shopName,
            itemNo,
            inStorefront: /store front item|在庫確認します/i.test(stockText)
        });
    });

    const seen = new Set();
    return results.filter(item => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
    });
}

function applyFilters(results, query, strict, filters) {
    let filtered = results;

    if (Array.isArray(filters) && filters.length > 0) {
        const filterTerms = filters.map(f => String(f).trim().toLowerCase()).filter(Boolean);
        filtered = filtered.filter(item => {
            const titleLower = String(item.title || '').toLowerCase();
            return !filterTerms.some(term => titleLower.includes(term));
        });
    }

    if (strict) {
        const parsedQuery = queryMatcher.parseQuery(query);
        filtered = filtered.filter(item => queryMatcher.matchesQuery(item.title, parsedQuery, strict));
    }

    return filtered;
}

function parseDetailCategory(html) {
    return parseDetailMetadata(html).categoryPath;
}

function parseDetailMetadata(html) {
    const $ = cheerio.load(html || '');
    const categoryPath = normalizeText($('tr.category_path').first().text())
        .replace(/^カテゴリ\s*/, '');
    let itemInformation = '';

    $('tr').each((index, row) => {
        if (itemInformation) return;
        const heading = normalizeText($(row).find('th').first().text());
        if (/^(商品情報|item information)$/i.test(heading)) {
            itemInformation = normalizeText($(row).find('td').first().text());
        }
    });

    return { categoryPath, itemInformation };
}

function isGarageKitCategory(categoryPath) {
    const normalized = String(categoryPath || '').trim();
    return /ガレージキット|garage\s*kit/i.test(normalized);
}

async function mapWithConcurrency(items, concurrency, mapper, signal = null) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(concurrency, 1), items.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            throwIfAborted(signal);
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }));

    return results;
}

async function fetchSearchHtml(searchUrl, cookies, signal = null) {
    throwIfAborted(signal);
    const cookieHeader = cookiesToHeader(cookies);

    const response = await axios.get(searchUrl, {
        timeout: 30000,
        signal,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
            'Cache-Control': 'no-cache',
            'Cookie': cookieHeader,
            'Referer': `${MANDARAKE_BASE_URL}/order/`
        }
    });

    return response.data;
}

async function fetchDetailHtml(detailUrl, cookies, signal = null) {
    throwIfAborted(signal);
    const cookieHeader = cookiesToHeader(cookies);

    const response = await axios.get(detailUrl, {
        timeout: 30000,
        signal,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            'Cookie': cookieHeader,
            'Referer': `${MANDARAKE_BASE_URL}/order/`
        }
    });

    return response.data;
}

function waitForPromise(promise, signal) {
    if (!signal) return promise;
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            const error = new Error('Search was aborted');
            error.name = 'AbortError';
            error.code = 'ABORT_ERR';
            reject(error);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
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

async function getDetailMetadata(item, cookies, options = {}, signal = null) {
    throwIfAborted(signal);
    loadDetailCache();

    const itemCode = getItemCode(item);
    if (!itemCode) throw new Error('Missing Mandarake item code');

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cached = detailCache.get(itemCode);
    if (cached && now - cached.fetchedAt < DETAIL_CACHE_TTL_MS) {
        if (now - cached.lastSeenAt >= GARAGE_KIT_CATALOG_TTL_MS) {
            cached.lastSeenAt = now;
            detailCacheDirty = true;
        }
        return cached;
    }

    const fetchMetadata = async (fetchSignal) => {
        const detailFetcher = options.fetchDetailHtml
            ? (url) => options.fetchDetailHtml(url, cookies, item, fetchSignal)
            : (url) => fetchDetailHtml(url, cookies, fetchSignal);
        const html = await detailFetcher(buildDetailUrl(itemCode));
        const parsed = parseDetailMetadata(html);
        if (!parsed.categoryPath) {
            throw new Error('Mandarake detail page did not contain a category');
        }
        const metadata = {
            ...parsed,
            fetchedAt: now,
            lastSeenAt: now
        };
        detailCache.set(itemCode, metadata);
        detailCacheDirty = true;
        return metadata;
    };

    let pending = detailFetches.get(itemCode);
    if (!pending) {
        if (signal) {
            pending = fetchMetadata(signal);
        } else {
            pending = fetchMetadata(null).finally(() => {
                detailFetches.delete(itemCode);
            });
            detailFetches.set(itemCode, pending);
        }
    }

    try {
        const metadata = await waitForPromise(pending, signal);
        metadata.lastSeenAt = now;
        return metadata;
    } catch (error) {
        throwIfAborted(signal);
        if (cached) {
            if (now - cached.lastSeenAt >= GARAGE_KIT_CATALOG_TTL_MS) {
                cached.lastSeenAt = now;
                detailCacheDirty = true;
            }
            console.warn(`[Mandarake] Using stale detail metadata for itemCode=${itemCode}: ${error.message}`);
            return cached;
        }
        throw error;
    }
}

async function refreshGarageKitCatalog(cookies, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const searchFetcher = options.fetchSearchHtml
        ? (url) => options.fetchSearchHtml(url, cookies, null)
        : (url) => fetchSearchHtml(url, cookies, null);
    const searchUrl = buildSearchUrl('', { mode: 'garageKit' });
    const html = await searchFetcher(searchUrl);

    if (String(html).includes('body class="login"')) {
        throw new Error('Login Required');
    }

    const listedItems = parseResults(html);
    if (listedItems.length === 0) {
        throw new Error('Mandarake garage-kit catalog returned no items');
    }
    let failed = 0;
    let rejected = 0;
    const verified = await mapWithConcurrency(
        listedItems,
        options.concurrency || DETAIL_CATEGORY_CONCURRENCY,
        async (item) => {
            try {
                const metadata = await getDetailMetadata(item, cookies, {
                    fetchDetailHtml: options.fetchDetailHtml,
                    now
                });
                if (!isGarageKitCategory(metadata.categoryPath)) {
                    rejected++;
                    return null;
                }
                return item;
            } catch (error) {
                failed++;
                if (failed <= 5) {
                    console.warn(`[Mandarake] Failed to cache itemCode=${getItemCode(item)}: ${error.message}`);
                }
                return null;
            }
        }
    );

    garageKitCatalog = verified.filter(Boolean);
    garageKitCatalogFetchedAt = now;
    detailCacheDirty = true;
    if (options.persistCache !== false) {
        persistDetailCache();
    }

    console.log(
        `[Mandarake] Garage-kit catalog cached ${garageKitCatalog.length}/${listedItems.length} item(s); ` +
        `rejected ${rejected}, failed ${failed}.`
    );
    return garageKitCatalog;
}

async function getGarageKitCatalog(cookies, options = {}, signal = null) {
    loadDetailCache();
    const now = Number.isFinite(options.now) ? options.now : Date.now();

    if (!options.forceRefresh && garageKitCatalog.length > 0 &&
        now - garageKitCatalogFetchedAt < GARAGE_KIT_CATALOG_TTL_MS) {
        return garageKitCatalog;
    }

    if (options.refresh === false) {
        return [];
    }

    if (!garageKitCatalogRefresh) {
        garageKitCatalogRefresh = refreshGarageKitCatalog(cookies, options)
            .finally(() => {
                garageKitCatalogRefresh = null;
            });
    }

    try {
        return await waitForPromise(garageKitCatalogRefresh, signal);
    } catch (error) {
        throwIfAborted(signal);
        if (garageKitCatalog.length > 0 && now - garageKitCatalogFetchedAt < GARAGE_KIT_CATALOG_TTL_MS) {
            console.warn(`[Mandarake] Using stale garage-kit catalog after refresh failure: ${error.message}`);
            return garageKitCatalog;
        }
        throw error;
    }
}

function findGarageKitCatalogMatches(catalog, query, filters = [], metadataByItemCode = detailCache) {
    const parsedQuery = queryMatcher.parseQuery(query);
    const matches = (Array.isArray(catalog) ? catalog : []).filter(item => {
        const metadata = metadataByItemCode.get(getItemCode(item));
        if (!metadata) return false;

        const searchableText = [item.title, metadata.itemInformation, metadata.categoryPath]
            .map(normalizeText)
            .filter(Boolean)
            .join(' ');
        return queryMatcher.matchesQuery(searchableText, parsedQuery, true);
    });

    return applyFilters(matches, '', false, filters);
}

function mergeResults(primary, additional) {
    const merged = [];
    const seen = new Set();

    for (const item of [...primary, ...additional]) {
        const key = getItemCode(item) || item.link;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }

    return merged;
}

async function filterGarageKitResults(results, cookies, options = {}, signal = null) {
    throwIfAborted(signal);
    if (!Array.isArray(results) || results.length === 0) return [];

    const concurrency = options.concurrency || DETAIL_CATEGORY_CONCURRENCY;
    let rejected = 0;
    let failed = 0;

    const verified = await mapWithConcurrency(results, concurrency, async (item) => {
        const itemCode = getItemCode(item);
        if (!itemCode) {
            failed++;
            return null;
        }

        try {
            const metadata = await getDetailMetadata(item, cookies, {
                fetchDetailHtml: options.fetchDetailHtml,
                now: options.now
            }, signal);

            if (isGarageKitCategory(metadata.categoryPath)) {
                return item;
            }

            rejected++;
            return null;
        } catch (error) {
            throwIfAborted(signal);
            failed++;
            console.warn(`[Mandarake] Failed to verify detail category for itemCode=${itemCode}: ${error.message}`);
            return null;
        }
    }, signal);

    const filtered = verified.filter(Boolean);
    if (rejected > 0 || failed > 0) {
        console.log(`[Mandarake] Detail category verification kept ${filtered.length}/${results.length} item(s); rejected ${rejected}, failed ${failed}.`);
    }
    if (!options.fetchDetailHtml || options.persistCache === true) {
        persistDetailCache();
    }

    return filtered;
}

async function search(query, strict = true, filters = [], options = {}, signal = null) {
    throwIfAborted(signal);
    const effectiveQuery = getEffectiveQuery(query, options);
    const mode = normalizeMode(options);
    console.log(`[Mandarake] Searching for: ${effectiveQuery || '(all)'} (${mode})`);

    const cookies = loadCookies();
    if (!cookies || !hasValidCookies()) {
        console.log('[Mandarake] Skipping search - no valid cookies available');
        return [{ error: 'Cookie Error', source: 'Mandarake' }];
    }

    try {
        const searchUrl = buildSearchUrl(query, options);
        const html = await fetchSearchHtml(searchUrl, cookies, signal);

        if (String(html).includes('body class="login"')) {
            return [{ error: 'Login Required', source: 'Mandarake' }];
        }

        const parsed = parseResults(html);
        let filtered = applyFilters(parsed, effectiveQuery, false, filters);

        if (mode === 'garageKit') {
            filtered = await filterGarageKitResults(filtered, cookies, {}, signal);

            try {
                const catalog = await getGarageKitCatalog(cookies, { refresh: !signal }, signal);
                const catalogMatches = findGarageKitCatalogMatches(catalog, effectiveQuery, filters);
                filtered = mergeResults(filtered, catalogMatches);
                if (catalogMatches.length > 0) {
                    console.log(`[Mandarake] Added ${catalogMatches.length} cached metadata match(es).`);
                }
            } catch (catalogError) {
                throwIfAborted(signal);
                console.warn('[Mandarake] Garage-kit metadata search unavailable:', catalogError.message);
            }
        }

        console.log(`[Mandarake] Found ${parsed.length} item(s), ${filtered.length} after filtering.`);
        return filtered;
    } catch (error) {
        throwIfAborted(signal);
        console.error('[Mandarake] Search failed:', error.message);
        return [{ error: error.message || 'Search failed', source: 'Mandarake' }];
    }
}

module.exports = {
    search,
    hasValidCookies,
    buildSearchUrl,
    parseResults,
    getEffectiveQuery,
    buildDetailUrl,
    getItemCode,
    parseDetailMetadata,
    parseDetailCategory,
    isGarageKitCategory,
    filterGarageKitResults,
    getGarageKitCatalog,
    findGarageKitCatalogMatches,
    GARAGE_KIT_CATEGORY_CODE,
    EVERYTHING_CATEGORY_CODE,
    _resetCacheForTests: () => {
        detailCacheLoaded = true;
        detailCache = new Map();
        detailFetches = new Map();
        garageKitCatalog = [];
        garageKitCatalogFetchedAt = 0;
        garageKitCatalogRefresh = null;
        detailCacheDirty = false;
    }
};
