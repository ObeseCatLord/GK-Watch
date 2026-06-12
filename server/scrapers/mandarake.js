const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const queryMatcher = require('../utils/queryMatcher');

const MANDARAKE_BASE_URL = 'https://order.mandarake.co.jp';
const MANDARAKE_SEARCH_URL = `${MANDARAKE_BASE_URL}/order/listPage/list`;
const COOKIES_FILE = path.join(__dirname, '../data/mandarake_cookies.json');

const EVERYTHING_CATEGORY_CODE = '00';
const GARAGE_KIT_CATEGORY_CODE = '020107';

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

async function fetchSearchHtml(searchUrl, cookies) {
    const cookieHeader = cookiesToHeader(cookies);

    const response = await axios.get(searchUrl, {
        timeout: 30000,
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

async function search(query, strict = true, filters = [], options = {}) {
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
        const html = await fetchSearchHtml(searchUrl, cookies);

        if (String(html).includes('body class="login"')) {
            return [{ error: 'Login Required', source: 'Mandarake' }];
        }

        const parsed = parseResults(html);
        const filtered = applyFilters(parsed, effectiveQuery, false, filters);
        console.log(`[Mandarake] Found ${parsed.length} item(s), ${filtered.length} after filtering.`);
        return filtered;
    } catch (error) {
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
    GARAGE_KIT_CATEGORY_CODE,
    EVERYTHING_CATEGORY_CODE
};
