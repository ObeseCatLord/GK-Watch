const axios = require('axios');
const cheerio = require('cheerio');
const dejapan = require('./dejapan');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');

async function searchDirect(query, strictEnabled = true, filters = []) {
    console.log(`Searching Fril for ${query}...`);
    const searchUrl = `https://fril.jp/s?query=${encodeURIComponent(query)}`;

    try {
        const res = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'ja-JP'
            },
            timeout: 10000
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
        console.error('Fril Scraper Error:', error.message);
        if (error.response && error.response.status === 404) {
            return []; // No results found often returns 404 on some sites, though Fril usually just empty list
        }
        return null;
    }
}

// Wrapper for main search to handle fallback
async function searchWithFallback(query, strictEnabled = true, filters = []) {
    let results = null;
    try {
        results = await searchDirect(query, strictEnabled, filters);
    } catch (err) {
        console.warn(`[Fril] Direct search critical error: ${err.message}`);
        results = null;
    }

    if (results !== null) {
        return results;
    }

    console.log('[Fril] Direct search failed (returned null). Attempting Fallback: DEJapan...');
    try {
        const dejapanResults = await dejapan.searchRakuma(query, strictEnabled, filters);
        if (dejapanResults !== null) {
            console.log(`[Fril] DEJapan search successful (${dejapanResults.length} items).`);
            return dejapanResults;
        }
    } catch (err) {
        console.warn(`[Fril] DEJapan fallback error: ${err.message}`);
    }

    return [];
}

module.exports = { search: searchWithFallback };
