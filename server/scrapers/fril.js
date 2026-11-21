const { setTimeout: delay } = require('node:timers/promises');
const axios = require('axios');
const cheerio = require('cheerio');
const doorzo = require('./doorzo');
const jsubculture = require('./jsubculture');
const { parseQuery, matchesQuery } = require('../utils/queryMatcher');

const SEARCH_URL = 'https://fril.jp/s';
const ITEM_URL = 'https://item.fril.jp/';
const MAX_NATIVE_PAGES = 5;

function listingLink(href) {
    const match = /^https:\/\/item\.fril\.jp\/([a-f\d]{32})(?=[/?#]|$)/i.exec(href || '');
    return match ? ITEM_URL + match[1].toLowerCase() : null;
}

async function searchDirect(query, signal) {
    const url = new URL(SEARCH_URL);
    url.search = new URLSearchParams({ query, transaction: 'selling', sort: 'relevance', order: 'desc' });
    const items = new Map();
    try {
        for (let page = 1; page <= MAX_NATIVE_PAGES; page++) {
            if (page > 1) {
                await delay(300, undefined, { signal: signal ?? undefined });
                url.searchParams.set('page', page);
            }

            const { data } = await axios.get(url.href, { timeout: 10000, signal });
            signal?.throwIfAborted();
            const $ = cheerio.load(data);
            const searchResults = $('.search_tab');
            if (!searchResults.length) throw new Error('Unexpected Rakuma search page');
            const cards = searchResults.find('.item-box').toArray();
            if (!cards.length) return { items: [...items.values()], complete: page === 1 };

            const previousSize = items.size;
            for (const card of cards) {
                const box = $(card);
                if (box.find('.item-box__soldout_ribbon').length) continue;
                const link = listingLink(box.find('.item-box__image-wrapper a').first().attr('href'));
                const title = box.find('.item-box__item-name span').text().trim();
                if (!link || !title || items.has(link)) continue;

                const img = box.find('.item-box__image-wrapper img').first();
                const priceEl = box.find('.item-box__item-price');
                const digits = priceEl.find('span[data-content]:not([data-content="JPY"])').first().attr('data-content')
                    || priceEl.text().match(/\d[\d,]*/)?.[0];
                const yen = Number(digits?.replaceAll(',', ''));
                items.set(link, {
                    title,
                    link,
                    image: img.attr('data-original') || img.attr('src') || '',
                    price: yen > 0 ? `¥${yen.toLocaleString('ja-JP')}` : 'N/A',
                    source: 'Rakuma'
                });
            }
            if (items.size === previousSize) throw new Error('Rakuma page contained no new active listings');
            const next = searchResults.find('nav.pagination a[href]').toArray().some(anchor => {
                const link = new URL($(anchor).attr('href'), url);
                return link.origin === url.origin && link.pathname === url.pathname
                    && link.searchParams.get('query') === query
                    && Number(link.searchParams.get('page')) === page + 1;
            });
            if (!next) return { items: [...items.values()], complete: true };
        }
        console.warn(`[Fril] Native search reached the ${MAX_NATIVE_PAGES}-page limit.`);
    } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[Fril] Native search failed: ${error.message}`);
    }
    return { items: [...items.values()], complete: false };
}

async function search(query, strictEnabled = true, filters = [], signal = null) {
    signal?.throwIfAborted();
    const parsedQuery = parseQuery(query);
    const excludedTerms = (filters || []).map(term => term.toLowerCase());
    const results = new Map();
    const addMatches = items => {
        for (const item of items) {
            const link = listingLink(item.link);
            if (!link || results.has(link) || !matchesQuery(item.title, parsedQuery, strictEnabled)) continue;
            if (excludedTerms.some(term => item.title.toLowerCase().includes(term))) continue;
            results.set(link, { ...item, link });
        }
    };

    const primary = await jsubculture.search(query, 'rakuma', signal);
    addMatches(primary.items);
    if (primary.complete) {
        console.log(`[Fril] J-Subculture found ${results.size} matching listings.`);
        return [...results.values()];
    }

    try {
        const fallback = await doorzo.search(query, 'rakuma', signal);
        signal?.throwIfAborted();
        const primaryCount = results.size;
        addMatches(fallback || []);
        if (results.size > primaryCount) return [...results.values()];
    } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[Fril] Doorzo fallback failed: ${error.message}`);
    }

    const direct = await searchDirect(query, signal);
    addMatches(direct.items);
    return results.size || direct.complete ? [...results.values()] : null;
}

module.exports = { search };
