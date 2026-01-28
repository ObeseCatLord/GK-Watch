const axios = require('axios');
const cheerio = require('cheerio');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');

const BASE_URL = 'https://www.dejapan.com/en/shopping/mercari/list/search';
const MAX_PAGES = 10;
const DELAY_BETWEEN_PAGES = 500;

/**
 * Convert DEJapan link to Mercari canonical link
 * DEJapan format: https://www.dejapan.com/.../m123456789 (Canonical)
 * OR: .../encryptedID (Non-canonical)
 */
function convertToMercariLink(dejapanLink) {
    if (!dejapanLink) return null;
    // Canonical Check: m followed by digits (allow trailing slash or query)
    const match = dejapanLink.match(/(m\d+)(\/|\?|$)/);
    if (match) {
        return `https://jp.mercari.com/item/${match[1]}`;
    }
    // Fallback: If it looks like a DEJapan item link but we can't extract ID,
    // return the DEJapan link itself so the item isn't lost.
    if (dejapanLink.includes('/shopping/mercari/item/')) {
        return dejapanLink;
    }
    return null;
}

/**
 * Convert DEJapan link to Suruga-ya canonical link
 * DEJapan: .../shopping/surugaya/item/TITLE/ID
 * Suruga-ya: https://www.suruga-ya.jp/product/detail/ID
 */
function convertToSurugayaLink(dejapanLink) {
    if (!dejapanLink) return null;
    // Extract ID (last segment after slash, ignoring query)
    // Clean query first
    const cleanLink = dejapanLink.split('?')[0].replace(/\/$/, '');
    const match = cleanLink.match(/\/([^\/]+)$/);
    if (match) {
        // If ID seems valid (digits only usually, but sometimes alphanum for suruga?)
        // Suruga-ya IDs are usually digits, e.g. 602299956
        // But let's assume if it extracts, we try providing the canonical link
        return `https://www.suruga-ya.jp/product/detail/${match[1]}`;
    }
    // Fallback
    if (dejapanLink.includes('/shopping/surugaya/item/')) {
        return dejapanLink;
    }
    return null;
}

/**
 * Common DEJapan parsing logic for list items
 */
function parseDejapanItems($, selectorStr, linkFilter, source) {
    const results = [];
    $(selectorStr).each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes(linkFilter)) {
            const fullLink = href.startsWith('http') ? href : `https://www.dejapan.com${href}`;
            let rawText = $(el).text().trim().replace(/\s+/g, ' ');

            // Extract Price
            let price = 'N/A';
            const priceMatch = rawText.match(/([\d,]+) JPY$/);
            if (priceMatch) {
                // Extract price
                const priceNum = priceMatch[1];
                price = `¥${priceNum}`;
                // Remove price from title
                rawText = rawText.replace(priceMatch[0], '').trim();
            }

            // Clean common garbage suffixes
            let title = rawText;
            title = title.replace(/Mercari\s+\w+$/, '')
                .replace(/Suruga-ya$/, '')
                .replace(/Free Domestic Shipping.*$/, '') // Clean DEJapan shipping text
                .trim();

            const img = $(el).find('img').attr('src') || '';

            let finalLink = null;
            if (source === 'Mercari') finalLink = convertToMercariLink(fullLink);
            if (source === 'Suruga-ya') finalLink = convertToSurugayaLink(fullLink);

            if (finalLink && title) {
                results.push({
                    title,
                    link: finalLink,
                    image: img,
                    price,
                    source
                });
            }
        }
    });
    return results;
}

async function searchGeneric(query, strictEnabled, filters, source, baseUrl, linkFilter) {
    let allResults = [];
    const parsedQuery = parseQuery(query);
    const hasQuoted = hasQuotedTerms(parsedQuery);

    for (let page = 1; page <= MAX_PAGES; page++) {
        // Construct URL
        const url = `${baseUrl}?query=${encodeURIComponent(query)}&page=${page}`;
        if (page > 1) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));
        }

        try {
            console.log(`[DEJapan] Fetching ${source} Page ${page}: ${url}`);
            const { data } = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                },
                timeout: 15000
            });

            const $ = cheerio.load(data);

            const pageResults = parseDejapanItems($, 'a', linkFilter, source);

            if (pageResults.length === 0) {
                console.log(`[DEJapan] No items found on page ${page}. Stopping.`);

                // Softblock Check
                // If page 1 and 0 items, check for block indicators
                if (page === 1) {
                    const title = $('title').text().trim().toLowerCase();
                    const body = $('body').text().toLowerCase();

                    // Indicators of blocking/errors
                    const blockKeywords = ['access denied', '403 forbidden', 'captcha', 'security check', 'too many requests', 'maintenance'];
                    const isBlocked = blockKeywords.some(kw => title.includes(kw) || body.includes(kw));

                    if (isBlocked) {
                        console.warn(`[DEJapan] Softblock detected (Keywords found). Returning null to trigger fallback.`);
                        return null;
                    }
                    // If no block keywords, we assume it's a valid 0-result page.
                    // IMPORTANT: Since we improved parsing, 0 items likely means truly 0 items.
                }
                break;
            }

            console.log(`[DEJapan] Page ${page} found ${pageResults.length} items.`);
            allResults.push(...pageResults);

        } catch (error) {
            console.error(`[DEJapan] Error on page ${page}: ${error.message}`);
            // If error is 403 or similar, it's a hard block
            if (error.response && [403, 429, 503].includes(error.response.status)) {
                return null; // Trigger fallback
            }
            break;
        }
    }

    console.log(`[DEJapan] Total ${source} items found: ${allResults.length}`);

    let finalResults = allResults;

    if (filters && filters.length > 0) {
        const filterTerms = filters.map(f => f.toLowerCase());
        const preCount = finalResults.length;
        finalResults = finalResults.filter(item => {
            const titleLower = item.title.toLowerCase();
            return !filterTerms.some(term => titleLower.includes(term));
        });
        console.log(`[DEJapan] Negative filters removed ${preCount - finalResults.length} items.`);
    }

    if (strictEnabled || hasQuoted) {
        const strictFiltered = finalResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
        console.log(`[DEJapan] Strict filtering applied. ${finalResults.length} -> ${strictFiltered.length} items.`);
        return strictFiltered;
    }

    return finalResults;
}

async function search(query, strictEnabled = true, filters = []) {
    console.log(`[DEJapan] Searching Mercari for: ${query}`);
    return await searchGeneric(query, strictEnabled, filters, 'Mercari', BASE_URL, '/shopping/mercari/item/');
}

async function searchSurugaya(query, strictEnabled = false, filters = []) {
    console.log(`[DEJapan] Searching Suruga-ya for: ${query}`);
    const SURUGA_URL = 'https://www.dejapan.com/en/shopping/surugaya/list/search';
    return await searchGeneric(query, strictEnabled, filters, 'Suruga-ya', SURUGA_URL, '/shopping/surugaya/item/');
}

module.exports = { search, searchSurugaya };
