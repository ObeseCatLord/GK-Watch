const axios = require('axios');
const cheerio = require('cheerio');
const { matchTitle } = require('../utils/queryMatcher');
const yahoo = require('./yahoo');

// Legacy scraper (Direct PayPay site scraping) - Unreliable due to bot protection
async function searchLegacy(query, strictEnabled = true) {
    console.log(`[PayPay Legacy] Searching PayPay Flea Market for ${query}...`);
    const searchUrl = `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}`;

    try {
        const res = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'ja-JP'
            },
            timeout: 10000
        });

        const $ = cheerio.load(res.data);
        const results = [];
        const seen = new Set();

        const links = $('a[href^="/item/"]');

        links.each((i, el) => {
            try {
                const href = $(el).attr('href');
                if (!href || seen.has(href)) return;
                seen.add(href);

                const img = $(el).find('img');
                if (!img.length) return;

                const title = img.attr('alt');
                if (!title) return;

                const image = img.attr('src');
                const itemLink = 'https://paypayfleamarket.yahoo.co.jp' + href;

                let price = 'N/A';
                const priceElement = $(el).find('p');
                if (priceElement.length) {
                    const priceText = priceElement.text();
                    const priceMatch = priceText.match(/(\d{1,3}(,\d{3})*)円/);
                    if (priceMatch) {
                        const priceNum = priceMatch[1]; // Just the number part
                        price = `¥${priceNum}`;
                    }
                }

                results.push({
                    title,
                    link: itemLink,
                    image,
                    price,
                    source: 'PayPay Flea Market'
                });
            } catch (e) {
                // Skip bad items
            }
        });

        if (strictEnabled) {
            const filteredResults = results.filter(item => matchTitle(item.title, query));
            console.log(`[PayPay Legacy] Found ${results.length} items, ${filteredResults.length} after strict filter`);
            return filteredResults;
        }

        console.log(`[PayPay Legacy] Found ${results.length} items (Strict filter disabled)`);
        return results;

    } catch (error) {
        if (error.response && (error.response.status === 403 || error.response.status === 500)) {
            console.warn('[PayPay Legacy] Access blocked (Status ' + error.response.status + '). Likely bot detection.');
            return []; // Return empty array to allow other scrapers (or main Yahoo) to succeed
        }
        console.error('[PayPay Legacy] Scraper Error:', error.message);
        return [];
    }
}

// Main Search Function - Uses Legacy First (More Reliable)
async function search(query, strictEnabled = true) {
    try {
        // Try Legacy scraper first (direct PayPay site scraping)
        // This is more reliable for finding items despite bot protection
        const results = await searchLegacy(query, strictEnabled);

        if (results && results.length > 0) {
            console.log(`[PayPay] Legacy scraper found ${results.length} items.`);
            return results;
        }

        console.log("[PayPay] Legacy scraper found 0 items. Falling back to Yahoo integration...");

        // Fallback to Yahoo Integration
        const yahooResults = await yahoo.search(query, strictEnabled, false, 'paypay');
        if (yahooResults && yahooResults.length > 0) {
            return yahooResults.map(i => ({ ...i, source: 'PayPay Flea Market' }));
        }

        return [];

    } catch (err) {
        console.warn(`[PayPay] Error: ${err.message}. Trying fallback...`);

        // If legacy fails, try Yahoo
        try {
            const yahooResults = await yahoo.search(query, strictEnabled, false, 'paypay');
            if (yahooResults && yahooResults.length > 0) {
                return yahooResults.map(i => ({ ...i, source: 'PayPay Flea Market' }));
            }
        } catch (yahooErr) {
            console.warn(`[PayPay] Yahoo fallback also failed: ${yahooErr.message}`);
        }

        return [];
    }
}

module.exports = { search };
