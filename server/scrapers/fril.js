const axios = require('axios');
const cheerio = require('cheerio');
const dejapan = require('./dejapan');
const doorzo = require('./doorzo');
const jsubculture = require('./jsubculture');
const { parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Search was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
}

async function searchDirect(query, strictEnabled = true, filters = [], signal = null) {
    throwIfAborted(signal);
    console.log(`Searching Fril for ${query}...`);
    const searchUrl = `https://fril.jp/s?query=${encodeURIComponent(query)}`;

    try {
        const res = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'ja-JP'
            },
            timeout: 10000,
            signal
        });

        const $ = cheerio.load(res.data);
        let results = [];
        const itemBoxes = $('.item-box');

        itemBoxes.each((i, el) => {
            try {
                // Skip sold out items
                if ($(el).find('.item-box__soldout_ribbon').length > 0) return;

                // Get title from the name span
                const title = $(el).find('.item-box__item-name span').text().trim();
                if (!title) return;

                // Get link from image wrapper
                const linkEl = $(el).find('.item-box__image-wrapper a[href*="item.fril.jp"]');
                if (!linkEl.length) return;
                const link = linkEl.attr('href');

                // Get image
                const imgEl = $(el).find('.item-box__image-wrapper img');
                const image = imgEl.attr('data-original') || imgEl.attr('src') || '';

                // Get price
                let price = 'N/A';
                const priceEl = $(el).find('.item-box__item-price');
                if (priceEl.length) {
                    const priceSpan = priceEl.find('span[data-content]:not([data-content="JPY"])');
                    if (priceSpan.length) {
                        const priceValue = priceSpan.attr('data-content');
                        price = `¥${Number(priceValue).toLocaleString()}`;
                    } else {
                        // Fallback to text content, try to extract number
                        const priceText = priceEl.text().trim();
                        const priceMatch = priceText.match(/(\d{1,3}(,\d{3})*)/);
                        if (priceMatch) {
                            price = `¥${priceMatch[1]}`;
                        }
                    }
                }

                results.push({
                    title,
                    link,
                    image,
                    price,
                    source: 'Rakuma' // Updated source name to be more recognizable
                });
            } catch (e) {
                // Skip bad items
            }
        });

        // Apply negative filtering (server-side since Rakuma/Fril query params are limited/unreliable)
        if (filters && filters.length > 0) {
            const filterTerms = filters.map(f => f.toLowerCase());
            const preCount = results.length;
            results = results.filter(item => {
                const titleLower = item.title.toLowerCase();
                return !filterTerms.some(term => titleLower.includes(term));
            });
            console.log(`[Fril] Server-side negative filtering removed ${preCount - results.length} items.`);
        }

        // Strict filtering using query matcher (supports | for OR, && for AND, and quoted terms)
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const filteredResults = results.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`Fril: Found ${results.length} items, ${filteredResults.length} after strict filter${hasQuoted ? ' (Quoted Terms Enforced)' : ''}`);
            return filteredResults;
        }

        console.log(`Fril: Found ${results.length} items (Strict filter disabled)`);
        return results;

    } catch (error) {
        throwIfAborted(signal);
        console.error('Fril Scraper Error:', error.message);
        if (error.response && error.response.status === 404) {
            return []; // No results found often returns 404 on some sites, though Fril usually just empty list
        }
        return null;
    }
}

async function searchWithFallback(query, strictEnabled = true, filters = [], signal = null) {
    throwIfAborted(signal);
    const parsedQuery = parseQuery(query);
    const excludedTerms = (filters || []).map(term => term.toLowerCase());
    const filterItems = items => (items || []).filter(item => matchesQuery(item.title, parsedQuery, strictEnabled)
        && !excludedTerms.some(term => item.title.toLowerCase().includes(term)));
    const primary = await jsubculture.search(query, 'rakuma', signal);
    const results = new Map(filterItems(primary.items).map(item => [item.link, item]));
    const merge = items => {
        for (const item of items) {
            const link = item.link.split(/[?#]/, 1)[0].replace(/\/$/, '');
            if (!results.has(link)) results.set(link, item);
        }
        return [...results.values()];
    };

    if (primary.complete && results.size) {
        console.log(`[Fril] J-Subculture found ${results.size} matching listings.`);
        return [...results.values()];
    }

    try {
        const fallback = await doorzo.search(query, 'rakuma', signal);
        throwIfAborted(signal);
        const items = filterItems(fallback);
        if (items.length) return merge(items);
    } catch (error) {
        throwIfAborted(signal);
        console.warn(`[Fril] Doorzo fallback error: ${error.message}`);
    }

    const direct = await searchDirect(query, strictEnabled, filters, signal);
    if (direct?.length) return merge(direct);

    try {
        const fallback = await dejapan.searchRakuma(query, strictEnabled, filters, signal);
        throwIfAborted(signal);
        return merge(fallback || []);
    } catch (error) {
        throwIfAborted(signal);
        console.warn(`[Fril] DEJapan fallback error: ${error.message}`);
        return [...results.values()];
    }
}

module.exports = { search: searchWithFallback };
