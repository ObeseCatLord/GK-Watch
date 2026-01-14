const axios = require('axios');
const cheerio = require('cheerio');
const queryMatcher = require('../utils/queryMatcher');

/**
 * Suruga-ya scraper using Neokyo as a proxy
 * Neokyo provides access to Suruga-ya listings without Cloudflare blocking
 */

const NEOKYO_SEARCH_URL = 'https://neokyo.com/en/search/surugaya';
const MAX_PAGES_LIMIT = 200; // Safety limit to prevent infinite loops
const DELAY_BETWEEN_PAGES = 300; // ms delay between page requests

/**
 * Build the search URL for a given page (sorted by modification date, newest first)
 */
function buildSearchUrl(query, page = 1) {
    const encodedQuery = encodeURIComponent(query);
    if (page === 1) {
        return `${NEOKYO_SEARCH_URL}?provider=surugaya&translate=0&order-tag=modificationTime%3Adescending&order-direction=&keyword=${encodedQuery}`;
    }
    // Pagination URL format with date sorting
    return `${NEOKYO_SEARCH_URL}?page=${page}&keyword=${encodedQuery}&translate=0&order-tag=modificationTime%3Adescending&google_translate=&category[level_1]=&category[level_2]=&category[level_3]=&category[level_4]=&category[level_5]=&category[level_6]=&category[level_7]=`;
}

/**
 * Convert Neokyo product URL to Suruga-ya URL
 * Example: /en/product/surugaya/602299956 -> https://www.suruga-ya.jp/product/detail/602299956
 */
function convertToSurugayaLink(neokyoUrl) {
    // Extract product ID from Neokyo URL (supports alphanumeric IDs like ZSARO128)
    const match = neokyoUrl.match(/\/product\/surugaya\/([A-Za-z0-9]+)/);
    if (match && match[1]) {
        return `https://www.suruga-ya.jp/product/detail/${match[1]}`;
    }
    // Return original if can't convert
    return neokyoUrl;
}

/**
 * Parse results from HTML content
 */
function parseResults($) {
    const results = [];
    const productCards = $('.product-card');

    productCards.each((i, card) => {
        const $card = $(card);

        const titleLink = $card.find('a.product-link').first();
        const title = titleLink.text().trim();
        const link = titleLink.attr('href');

        // Try main price first, then fall back to marketplace price
        let priceText = $card.find('.price b').first().text().trim();
        if (!priceText || priceText === 'N/A') {
            // Check for marketplace-only listings (class mt-1 mb-0 marketplace)
            priceText = $card.find('.mt-1.mb-0.marketplace').text().trim();
            // Also try alternative marketplace selectors
            if (!priceText) {
                priceText = $card.find('.marketplace').first().text().trim();
            }
        }

        const image = $card.find('img.card-img-top').attr('src');

        if (title && link) {
            // Extract price number from text like "Marketplace: from ¥900 ~" or "990 Yen"
            const priceMatch = priceText.match(/(\d[\d,]*)/);
            let price = 'N/A';
            if (priceMatch) {
                // Remove commas first to parse, then re-format with commas
                const priceNum = parseInt(priceMatch[1].replace(/,/g, ''), 10);
                price = `¥${priceNum.toLocaleString()}`;
            }

            // Store both Neokyo link (for detail fetch) and Suruga-ya link (for display)
            const neokyoLink = link.startsWith('http') ? link : `https://neokyo.com${link}`;

            results.push({
                title: title,
                link: convertToSurugayaLink(link),
                neokyoLink: neokyoLink,
                image: image ? image.trim() : 'https://www.suruga-ya.jp/img/logo.png',
                price: price,
                source: 'Suruga-ya'
            });
        }
    });

    return results;
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
            timeout: 10000
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
        console.log(`[Suruga-ya] Failed to fetch full title from ${neokyoLink}: ${error.message}`);
        return null;
    }
}

/**
 * Fetch the full title from a Neokyo product detail page
 * Used to verify truncated titles before filtering
 * Added retry logic for 403/429 errors
 */
async function fetchFullTitle(neokyoLink) {
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                console.log(`[Suruga-ya] Retrying title fetch for ${neokyoLink} (Attempt ${attempt + 1}/${maxRetries + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
            }

            const response = await axios.get(neokyoLink, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                timeout: 10000
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
            const isRateLimit = error.response && (error.response.status === 403 || error.response.status === 429);
            console.log(`[Suruga-ya] Failed to fetch full title from ${neokyoLink}: ${error.message} ${isRateLimit ? '(Rate Limit/Block)' : ''}`);

            if (isRateLimit && attempt < maxRetries) {
                continue; // Retry
            }
            // If failed after retries or non-retryable error
            if (attempt === maxRetries) return null;
        }
    }
    return null;
}

/**
 * Get total pages from pagination element
 * Looks for: class="pagination pagination-sm justify-content-center"
 */
function getTotalPages($) {
    // Find the pagination element
    const pagination = $('.pagination.pagination-sm.justify-content-center');

    if (pagination.length === 0) {
        // Try alternative pagination selectors
        const altPagination = $('.pagination');
        if (altPagination.length === 0) {
            return 1; // No pagination found, assume single page
        }
    }

    // Find the highest page number in pagination links
    let maxPage = 1;

    // Look for page links that contain just numbers
    $('a[href*="page="]').each((i, link) => {
        const href = $(link).attr('href');
        const pageMatch = href.match(/page=(\d+)/);
        if (pageMatch) {
            const pageNum = parseInt(pageMatch[1], 10);
            if (pageNum > maxPage) {
                maxPage = pageNum;
            }
        }
    });

    // Also check link text for page numbers (e.g., the last page link)
    $('.pagination a, .pagination li').each((i, el) => {
        const text = $(el).text().trim();
        const num = parseInt(text, 10);
        if (!isNaN(num) && num > maxPage) {
            maxPage = num;
        }
    });

    return Math.min(maxPage, MAX_PAGES_LIMIT);
}

/**
 * Fetch a single page with Axios
 */
async function fetchPageWithAxios(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const results = parseResults($);
        const totalPages = getTotalPages($);

        return { results, totalPages, $ };
    } catch (error) {
        console.log(`Suruga-ya (Axios) page fetch failed: ${error.message}`);
        return null;
    }
}

/**
 * Try to scrape all pages with Axios
 */
async function searchWithAxios(query) {
    const allResults = [];

    // Fetch first page to get total pages
    const firstPageUrl = buildSearchUrl(query, 1);
    console.log(`Suruga-ya: Fetching page 1...`);

    const firstPageData = await fetchPageWithAxios(firstPageUrl);

    if (!firstPageData || firstPageData.results.length === 0) {
        // Check for specific "no results" message to confirm successful (empty) scrape
        if (firstPageData && firstPageData.$) {
            const $ = firstPageData.$;
            const hasNoResultsMsg = $('.container.no-result-container').length > 0
                || $('body').text().includes('Sorry, we found no results');

            if (hasNoResultsMsg) {
                console.log('Suruga-ya (Neokyo): Confirmed no results found.');
                return [];
            }
        }

        console.log('Suruga-ya (Neokyo): No products found (Axios). Returning empty as fallback removed.');
        return [];
    }

    allResults.push(...firstPageData.results);
    const totalPages = firstPageData.totalPages;

    console.log(`Suruga-ya: Found ${totalPages} total pages`);

    // Fetch remaining pages
    for (let page = 2; page <= totalPages; page++) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES));

        const searchUrl = buildSearchUrl(query, page);

        if (page % 10 === 0 || page === totalPages) {
            console.log(`Suruga-ya: Fetching page ${page}/${totalPages}...`);
        }

        const pageData = await fetchPageWithAxios(searchUrl);

        if (!pageData || pageData.results.length === 0) {
            console.log(`Suruga-ya: Page ${page} empty, stopping pagination`);
            break;
        }

        allResults.push(...pageData.results);
    }

    console.log(`Suruga-ya (Neokyo/Axios): Found ${allResults.length} items across ${totalPages} pages`);
    return allResults;
}



/**
 * Main search function - tries Axios first, falls back to Puppeteer
 */
async function search(query, strict = true, filters = []) {
    // Append negative filters to query for optimized searching
    // e.g. "Gundam -Plastic -Model"
    let effectiveQuery = query;
    if (filters && filters.length > 0) {
        const negativeTerms = filters.map(f => `-${f}`).join(' ');
        effectiveQuery = `${query} ${negativeTerms}`;
        console.log(`[Suruga-ya] Optimized search with negative terms: "${effectiveQuery}"`);
    }

    console.log(`Searching Suruga-ya for ${effectiveQuery}...`);

    // Try Axios (only)
    let results = await searchWithAxios(effectiveQuery);

    // Filter results if strict mode is on
    if (strict && results && results.length > 0) {
        console.log(`[Suruga-ya] Strict filtering enabled. Checking ${results.length} items against query: "${query}"`);
        const initialCount = results.length;
        const filteredResults = [];
        let rateLimitHit = false;

        for (const item of results) {
            // Check if title matches query strictly
            // Use ORIGINAL query (without negative terms) for positive matching
            const matches = queryMatcher.matchTitle(item.title, query);

            // If it matches, keep it
            if (matches) {
                filteredResults.push(item);
                continue;
            }

            // If it doesn't match, try fetching the full title from detail page
            // This handles truncation AND cases where search results show partial info
            if (item.neokyoLink) {
                // If the Title check failed on the truncated title, and we are strict,
                // we assume it MIGHT be a match and verify.
                const fullTitle = await fetchFullTitle(item.neokyoLink);
                if (fullTitle) {
                    const fullMatches = queryMatcher.matchTitle(fullTitle, query);
                    if (fullMatches) {
                        console.log(`[Suruga-ya] Keeping item after full title check: "${fullTitle.substring(0, 60)}..."`);
                        // Update the item's title to the full version for display
                        item.title = fullTitle;
                        filteredResults.push(item);
                        continue;
                    }
                } else {
                    // Fail-safe: Could not fetch title (e.g. 403 again after retry)
                    // Default to KEEPING the item to ensure we don't miss valid items.
                    console.log(`[Suruga-ya] WARN: Could not verify full title for "${item.title}". Defaulting to KEEP.`);
                    filteredResults.push(item);
                    continue;
                }
            } else {
                // No link to verify? Should technically keep if we want to be safe,
                // but without link it's likely a bad scrape. 
                // However, we only get here if title failed match.
                // If default behavior is safe, we should probably keep it?
                // But rare case. Let's stick to fail-safe on fetch failure.
                // If no link, we can't verify, so we rely on initial match (which failed).
                // So discard.
            }

            // Item doesn't match after all checks - filter it out
        }

        results = filteredResults;
        console.log(`[Suruga-ya] Filtered ${initialCount - results.length} items. Remaining: ${results.length}`);
    }

    // Remove neokyoLink from final results (internal use only)
    results = (results || []).map(item => {
        const { neokyoLink, ...rest } = item;
        return rest;
    });

    // Return results (or empty if none)
    return results;
}

module.exports = { search };
