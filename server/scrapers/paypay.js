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
            timeout: 10000 // Restored to 10s for reliability
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

// Neokyo Scraper Logic
const NEOKYO_SEARCH_URL = 'https://neokyo.com/en/search/yahooFleaMarket';
const DELAY_BETWEEN_PAGES = 300; // ms

function buildNeokyoUrl(query, page = 1) {
    const encodedQuery = encodeURIComponent(query);
    const baseUrl = `${NEOKYO_SEARCH_URL}?provider=yahooFleaMarket&translate=0&order-tag=openTime&order-direction=DESC&keyword=${encodedQuery}`;

    if (page === 1) return baseUrl;
    // Neokyo pagination params
    return `${baseUrl}&page=${page}&google_translate=&category[level_1]=&category[level_2]=&category[level_3]=&category[level_4]=&category[level_5]=&category[level_6]=&category[level_7]=`;
}

async function searchNeokyo(query) {
    console.log(`[PayPay Fallback] Searching Neokyo for ${query}...`);
    const allResults = [];
    let page = 1;
    let hasMore = true;
    // Safety limit, though user said scrape all
    const MAX_PAGES = 50;

    while (hasMore && page <= MAX_PAGES) {
        if (page > 1) await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));

        const url = buildNeokyoUrl(query, page);
        console.log(`[PayPay Fallback] Fetching Neokyo page ${page}`);

        try {
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                timeout: 45000 // Increased to 45s per user request
            });

            const $ = cheerio.load(res.data);
            const pageResults = [];
            const productCards = $('.product-card');

            if (productCards.length === 0) {
                // Check if it's genuinely empty or error
                if ($('body').text().includes('found no results') || $('.no-result-container').length > 0) {
                    console.log('[PayPay Fallback] No results found on Neokyo.');
                }
                hasMore = false;
                break;
            }

            productCards.each((i, card) => {
                const $card = $(card);
                const titleLink = $card.find('a.product-link').first();
                const title = titleLink.text().trim();
                const relativeLink = titleLink.attr('href');

                // Neokyo link: /en/product/yahooFleaMarket/{ID}
                // Actual PayPay link: https://paypayfleamarket.yahoo.co.jp/item/{ID}
                let paypayLink = '';
                if (relativeLink) {
                    const idMatch = relativeLink.match(/\/product\/yahooFleaMarket\/([A-Za-z0-9]+)/);
                    if (idMatch && idMatch[1]) {
                        paypayLink = `https://paypayfleamarket.yahoo.co.jp/item/${idMatch[1]}`;
                    } else {
                        paypayLink = `https://neokyo.com${relativeLink}`;
                    }
                }

                const img = ($card.find('img.card-img-top').attr('src') || '').trim();
                const priceText = $card.find('.price b, .price').first().text().trim();

                let price = 'N/A';
                if (priceText) {
                    const priceMatch = priceText.match(/(\d[\d,]*)/);
                    if (priceMatch) {
                        price = `¥${priceMatch[1].replace(/,/g, '')}`;
                    }
                }

                if (title && paypayLink) {
                    pageResults.push({
                        title,
                        link: paypayLink,
                        neokyoLink: (relativeLink && relativeLink.startsWith('http')) ? relativeLink : `https://neokyo.com${relativeLink || ''}`,
                        image: img || '',
                        price,
                        source: 'PayPay Flea Market' // Matched to source filter
                    });
                }
            });

            if (pageResults.length > 0) {
                allResults.push(...pageResults);
                page++;
            } else {
                hasMore = false;
            }

            console.error(`[PayPay Fallback] Error fetching page ${page}:`, err.message);
            hasMore = false;
            // If the very first page fails, we should consider the whole scrape failed
            if (page === 1) {
                return null;
            }
        }
    }

    console.log(`[PayPay Fallback] Found ${allResults.length} items on Neokyo.`);
    return allResults;
}

/**
 * Fetch the full title from a Neokyo product detail page
 * Used to verify truncated titles before filtering
 */
async function fetchFullTitle(neokyoLink) {
    try {
        const response = await axios.get(neokyoLink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            timeout: 20000
        });

        const $ = cheerio.load(response.data);
        // The full title is in h6 with classes font-gothamRounded translate
        let fullTitle = $('h6.font-gothamRounded.translate').first().text().trim();
        if (!fullTitle) {
            // Fallback selectors
            fullTitle = $('h6.translate').first().text().trim();
        }
        if (!fullTitle) {
            fullTitle = $('title').text().replace(' - Neokyo', '').replace('Item Details', '').trim();
        }
        return fullTitle || null;
    } catch (error) {
        console.log(`[PayPay Fallback] Failed to fetch full title from ${neokyoLink}: ${error.message}`);
        return null;
    }
}

// Main Search Function - Legacy (Direct) -> Neokyo -> Yahoo Integration
async function search(query, strictEnabled = true) {
    let results = [];

    // 1. Try Legacy scraper first (Direct PayPay)
    try {
        results = await searchLegacy(query, strictEnabled);
        if (results && results.length > 0) {
            console.log(`[PayPay] Legacy scraper found ${results.length} items.`);
            return results;
        }
        console.log("[PayPay] Legacy scraper found 0 items.");
    } catch (err) {
        console.warn(`[PayPay] Legacy scraper error: ${err.message}`);
    }

    // 2. Try Neokyo Fallback
    try {
        results = await searchNeokyo(query);

        if (results === null) {
            throw new Error('Neokyo scrape failed');
        }

        if (strictEnabled && results.length > 0) {
            console.log(`[PayPay] Strict filtering enabled. Checking ${results.length} items.`);
            const filteredResults = [];

            for (const item of results) {
                // Check if title matches query strictly
                if (matchTitle(item.title, query)) {
                    filteredResults.push(item);
                    continue;
                }

                // If it doesn't match, try fetching the full title via NeokyoLink
                if (item.neokyoLink) {
                    // Check if title looks truncated (ends with ...) or is just generic mismatch
                    // Actually always check if we have neokyoLink because Neokyo titles are often shortened
                    const fullTitle = await fetchFullTitle(item.neokyoLink);
                    if (fullTitle) {
                        if (matchTitle(fullTitle, query)) {
                            console.log(`[PayPay] Keeping item after full title check: "${fullTitle.substring(0, 50)}..."`);
                            item.title = fullTitle;
                            filteredResults.push(item);
                            continue;
                        }
                    }
                }
            }
            results = filteredResults;
            console.log(`[PayPay] Neokyo found ${results.length} items after strict filtering.`);
        }

        // Return results even if empty, as long as it wasn't a scrape failure (null)
        // This prevents falling back to generic Yahoo search when PayPay genuinely has 0 items
        if (results) {
            // Clean up internal fields
            return results.map(item => {
                const { neokyoLink, ...rest } = item;
                return rest;
            });
        }

    } catch (err) {
        console.warn(`[PayPay] Neokyo fallback error: ${err.message}`);
    }

    // 3. Fallback to Yahoo Integration (REMOVED per user request)
    // console.log("[PayPay] Yahoo fallback disabled.");

    return [];
}

module.exports = { search };
