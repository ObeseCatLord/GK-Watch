const axios = require('axios');
const cheerio = require('cheerio');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');

const BASE_URL = 'https://www.dejapan.com/en/shopping/mercari/list/search';

/**
 * Convert DEJapan link to Mercari canonical link
 * DEJapan format: https://www.dejapan.com/.../m123456789
 * or sometimes encrypted ID?
 * Based on investigation: .../m41557630932 ends the URL
 */
function convertToMercariLink(dejapanLink) {
    if (!dejapanLink) return null;

    // Look for m followed by digits at the end of the string
    const match = dejapanLink.match(/(m\d+)$/);
    if (match) {
        return `https://jp.mercari.com/item/${match[1]}`;
    }

    // If we can't extract it, return the proxy link (better than nothing, but might duplicate)
    // Warning: If we return proxy link, we might get duplicates if Neokyo finds the same item.
    // Try to be strict: Only return if we find the ID.
    return null;
}

async function search(query, strictEnabled = true, filters = []) {
    console.log(`[DEJapan] Searching for: ${query}`);

    // Construct URL
    const url = `${BASE_URL}?query=${encodeURIComponent(query)}`;

    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        const results = [];

        // Select item containers - based on investigation script, we look for <a> tags with specific href pattern
        // The page structure seems to be a list of <li> or <div> containing these <a> tags.
        // Let's iterate over <a> tags that look like product links.

        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/shopping/mercari/item/')) {
                const fullLink = href.startsWith('http') ? href : `https://www.dejapan.com${href}`;

                // Extract Title
                // Visual check suggests the text inside <a> is the title + price + junk sometimes?
                // Or maybe title is in a child element?
                // Investigation output: "Text: 【中古】フィギュア ... 22,500 JPY"
                // It seems the <a> text content has the title AND price appended.
                // We need to be careful extracting title.

                let rawText = $(el).text().trim().replace(/\s+/g, ' ');

                // Extract Price
                // Price usually at the end " 22,500 JPY"
                let price = 'N/A';
                const priceMatch = rawText.match(/([\d,]+) JPY$/);
                if (priceMatch) {
                    // Extract price
                    const priceNum = priceMatch[1]; // e.g. "22,500"
                    price = `¥${priceNum}`;

                    // Remove price from title
                    rawText = rawText.replace(priceMatch[0], '').trim();
                }

                // Title is the remaining text
                const title = rawText;

                // Image
                // Look for image inside the <a> tag
                const img = $(el).find('img').attr('src') || '';

                const mercariLink = convertToMercariLink(fullLink);
                if (mercariLink) {
                    results.push({
                        title,
                        link: mercariLink,
                        image: img,
                        price,
                        source: 'Mercari'
                    });
                }
            }
        });

        console.log(`[DEJapan] Found ${results.length} raw items.`);

        // Apply Local Filtering (Strict + Negative)
        // Since we are parsing HTML, we can do full strict filtering here.
        // DEJapan gives FULL titles, so we can use strict=true if requested!

        // However, user setup for Neokyo was "effectiveQuery" (negatives) + strict=false.
        // Ideally we respect standard behavior:
        // If strictEnabled=true, we demand strict match.
        // We also ALWAYS demand negative filtering.

        // Wait, normally `search(..., strictEnabled)` handles strictness.
        // Negative filters are passed in `filters`.

        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        // Pre-filter negatives manually if needed, or rely on matchesQuery
        let finalResults = results;

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

    } catch (error) {
        console.error(`[DEJapan] Error: ${error.message}`);
        // Return null to indicate failure (triggering fallbacks)
        return null;
    }
}

module.exports = { search };
