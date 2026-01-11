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
                        price = priceMatch[0];
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

// Main Search Function - Uses Yahoo Integration Primary
async function search(query, strictEnabled = true) {
    try {
        // Try Yahoo Scraper with targetSource = 'paypay'
        // This is more reliable as Yahoo search engine indexes PayPay items and has better anti-bot handling
        const results = await yahoo.search(query, strictEnabled, false, 'paypay');

        if (results && results.length > 0) {
            console.log(`[PayPay] Yahoo Integration found ${results.length} items.`);
            return results.map(i => ({ ...i, source: 'PayPay Flea Market' }));
        }

        console.log("[PayPay] Yahoo Integration found 0 items. Falling back to legacy scraper...");
        return await searchLegacy(query, strictEnabled);

    } catch (err) {
        console.warn(`[PayPay] Yahoo Integration failed: ${err.message}. Falling back to legacy scraper.`);
        return await searchLegacy(query, strictEnabled);
    }
}

module.exports = { search };
