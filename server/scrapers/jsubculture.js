const { setTimeout: delay } = require('node:timers/promises');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.j-subculture.com/en/searches/';
const MARKETPLACES = {
    paypay: { route: 'fleamarket-lists', origin: 'https://paypayfleamarket.yahoo.co.jp', path: /^\/item\/z\d+\/?$/ },
    mercari: { route: 'mercari-lists', origin: 'https://jp.mercari.com', path: /^\/(?:item\/m\d+|shops\/product\/[a-z\d]+)\/?$/i },
    rakuma: { route: 'rakuma-lists', origin: 'https://item.fril.jp', path: /^\/[a-f\d]{32}\/?$/i }
};
const MAX_PAGES = 200;
const DEFAULT_BACKOFF_MS = 60 * 1000;
let retryAfter = 0;

function parsePage(html, url, page, marketplace) {
    const $ = cheerio.load(html);
    const totalText = $('.showing').first().text().match(/We could find\s+([\d,]+)\s+results?\b/i);
    if (!totalText) throw new Error('Unexpected search page');

    const total = Number(totalText[1].replaceAll(',', ''));
    const items = new Map();
    const titles = $('.product-title a[href]');

    for (const anchor of titles) {
        const originalUrl = new URL($(anchor).attr('href'), url).searchParams.get('shopping_url');
        if (!originalUrl?.startsWith(`${marketplace.origin}/`)) continue;
        const itemUrl = new URL(originalUrl);
        if (!marketplace.path.test(itemUrl.pathname)) continue;

        const link = itemUrl.origin + itemUrl.pathname.replace(/\/$/, '');
        const title = $(anchor).text().trim();
        if (!title || items.has(link)) continue;

        const card = $(anchor).closest('.product-item');
        const yen = card.find('.cur-price-main .num').first().text().trim();
        const thumbnail = card.find('img[src]').first().attr('src');

        items.set(link, {
            title,
            link,
            image: thumbnail ? new URL(thumbnail, url).href : '',
            price: /^\d[\d,]*$/.test(yen) ? `¥${yen}` : 'N/A'
        });
    }

    const pagination = $('.shop-pagination');
    const next = pagination.find('a[href]').toArray().map(anchor => new URL($(anchor).attr('href'), url)).find(link => {
        return link.origin === url.origin && link.pathname === url.pathname
            && link.searchParams.get('keyword') === url.searchParams.get('keyword')
            && Number(link.searchParams.get('page')) === page + 1;
    });
    return { items, total, next, hasPagination: pagination.length > 0 };
}

async function search(query, site, signal) {
    signal?.throwIfAborted();
    const marketplace = MARKETPLACES[site];
    const items = new Map();
    let url = new URL(marketplace.route, BASE_URL);
    url.searchParams.set('keyword', query);

    for (let page = 1; page <= MAX_PAGES && Date.now() >= retryAfter; page++) {
        try {
            const { data } = await axios.get(url.href, { timeout: 10000, signal });
            signal?.throwIfAborted();
            const result = parsePage(data, url, page, marketplace);
            if (page === 1 && result.total === 0 && result.items.size === 0 && !result.next) {
                return { items: [...items.values()], complete: true };
            }

            const previousSize = items.size;
            for (const [link, item] of result.items) {
                if (!items.has(link)) items.set(link, item);
            }
            if (items.size === previousSize) throw new Error('Search page contained no new marketplace listings');
            if (!result.next) {
                // The reported total can include listings omitted from the rendered cards.
                const complete = result.hasPagination || items.size >= result.total;
                if (!complete) console.warn(`[J-Subculture ${site}] Search ended early at ${items.size} of ${result.total} listings.`);
                return { items: [...items.values()], complete };
            }

            url = result.next;
            if (page === MAX_PAGES) break;
            await delay(300, undefined, { signal: signal ?? undefined });
        } catch (error) {
            signal?.throwIfAborted();
            const status = error.response?.status;
            if ([403, 429, 503].includes(status)) {
                const header = error.response.headers?.['retry-after'];
                const wait = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
                retryAfter = Math.max(retryAfter, Date.now() + Math.max(DEFAULT_BACKOFF_MS, wait || 0));
            }
            console.warn(`[J-Subculture ${site}] Search failed on page ${page}: ${error.message}`);
            break;
        }
    }
    return { items: [...items.values()], complete: false };
}

module.exports = { search };
