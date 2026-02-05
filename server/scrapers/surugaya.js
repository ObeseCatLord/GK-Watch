const axios = require('axios');
const cheerio = require('cheerio');
const queryMatcher = require('../utils/queryMatcher');
const dejapan = require('./dejapan');
const doorzo = require('./doorzo');

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

        // Check if item is marketplace-only (invalidates the main .price block)
        const isMarketplaceOnly = $card.find('.buy .interval').text().includes('Only Available in the Marketplace');

        // Try main price first, UNLESS it's marketplace-only
        let priceText = null;
        if (!isMarketplaceOnly) {
            priceText = $card.find('.price b').first().text().trim();
        }

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
        const isRateLimit = error.response && (error.response.status === 403 || error.response.status === 429);
        console.log(`[Suruga-ya] Failed to fetch full title from ${neokyoLink}: ${error.message} ${isRateLimit ? '(Rate Limit/Block)' : ''}`);

        if (isRateLimit) {
            return 'RATE_LIMIT';
        }
        return null;
    }
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
        return { error: true, status: error.response?.status, message: error.message };
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

    if (!firstPageData || firstPageData.error) {
        // Check for specific "no results" message to confirm successful (empty) scrape
        if (firstPageData && firstPageData.$) {
            const $ = firstPageData.$;
            const hasNoResultsMsg = $('.container.no-result-container').length > 0
                || $('body').text().includes('Sorry, we found no results');

            if (hasNoResultsMsg) {
                console.log('Suruga-ya (Neokyo): Confirmed no results found.');
                // Return empty array only if we are SURE it's empty
                return [];
            }
        }

        // Check explicit error status
        if (firstPageData && firstPageData.error) {
            console.log(`Suruga-ya (Neokyo): Page 1 failed with status ${firstPageData.status}. Triggering fallback.`);
            return null;
        }

        // If we get here, it means we either failed to fetch (null) or couldn't find explicit "no results" message
        // This likely means we were blocked or something broke.
        console.log('Suruga-ya (Neokyo): No products found (Axios) and clean failure not confirmed. Returning null to trigger fallback.');
        return null;
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

        if (!pageData || pageData.error) {
            if (pageData && (pageData.status === 429 || pageData.status === 403)) {
                console.log(`Suruga-ya (Neokyo): Blocked on page ${page} (Status ${pageData.status}). Aborting Neokyo and triggering fallback.`);
                return null; // DISCARD partial results and fallback to DEJapan to get full list
            }
            console.log(`Suruga-ya: Page ${page} failed or empty, stopping pagination (kept ${allResults.length} items)`);
            break;
        }

        if (pageData.results.length === 0) {
            console.log(`Suruga-ya: Page ${page} empty, stopping pagination`);
            break;
        }

        allResults.push(...pageData.results);
    }

    console.log(`Suruga-ya (Neokyo/Axios): Found ${allResults.length} items across ${totalPages} pages`);
    return allResults;
}



/**
 * Main search function - tries Doorzo (API) -> Neokyo (Axios) -> Puppeteer/Dejapan
 */
async function search(query, strict = true, filters = []) {
    // Priority 0: Doorzo (API) - Fastest & Most Results
    // Note: Doorzo is loose/fuzzy, so we MUST apply client-side filtering.
    try {
        console.log(`[Suruga-ya] Searching Doorzo (API) for ${query}...`);

        // Use raw query for Doorzo, filtering later
        let results = await doorzo.search(query, 'surugaya');

        if (results !== null) {
            console.log(`[Suruga-ya] Doorzo scraper successful. Found ${results.length} items.`);

            const parsedQuery = queryMatcher.parseQuery(query);
            const hasQuoted = queryMatcher.hasQuotedTerms(parsedQuery);

            // Apply negative filters (always)
            // Doorzo handles some minus logic, but client-side is safer for robustness
            if (filters && filters.length > 0) {
                const preFilterCount = results.length;
                const filterTerms = filters.map(f => f.toLowerCase());
                results = results.filter(item => {
                    const titleLower = item.title.toLowerCase();
                    return !filterTerms.some(term => titleLower.includes(term));
                });
                if (results.length < preFilterCount) {
                    console.log(`[Suruga-ya] Negative filtering (Doorzo) removed ${preFilterCount - results.length} items.`);
                }
            }

            // Apply Strict Filtering (if enabled OR quotes present)
            // User explicit request: "Please keep clientside filtering... because Doorzo does not concatenate titles"
            if ((strict || hasQuoted) && results.length > 0) {
                const preStrictCount = results.length;
                results = results.filter(item => queryMatcher.matchesQuery(item.title, parsedQuery, strict));
                console.log(`[Suruga-ya] Strict filtering (Doorzo) removed ${preStrictCount - results.length} items.`);
            }

            return results;
        } else {
            console.log('[Suruga-ya] Doorzo failed (returned null). Falling back to Neokyo...');
        }
    } catch (err) {
        console.warn(`[Suruga-ya] Doorzo scraper error: ${err.message}`);
        // Fall through
    }

    // Priority 1: Neokyo (Axios)
    try {
        // User requested: "Suruga-ya Neokyo shouldn't be strict"
        // We will override strict to false for this path.
        const fallbackStrict = false;

        // Append negative filters to query for optimized searching
        let effectiveQuery = query;
        if (filters && filters.length > 0) {
            const negativeTerms = filters.map(f => `-${f}`).join(' ');
            effectiveQuery = `${query} ${negativeTerms}`;
            console.log(`[Suruga-ya] Optimized search with negative terms: "${effectiveQuery}"`);
        }

        console.log(`Searching Suruga-ya (Neokyo) for ${effectiveQuery}...`);

        let results = await searchWithAxios(effectiveQuery);

        // Filter results if strict mode is on or if query contains quoted terms
        const parsedQuery = queryMatcher.parseQuery(query);
        const hasQuoted = queryMatcher.hasQuotedTerms(parsedQuery);

        // Strict filtering applies if strict mode is ON, OR if we have quoted terms that must be enforced
        // We use fallbackStrict (false) here unless hasQuoted forces it.
        if ((fallbackStrict || hasQuoted) && results && results.length > 0) {
            console.log(`[Suruga-ya] Strict filtering enabled${hasQuoted ? ' (Quoted Terms Found)' : ''}. Checking ${results.length} items against query: "${query}"`);
            const initialCount = results.length;
            const filteredResults = [];
            let rateLimitHit = false;

            for (const item of results) {
                // Check if title matches query strictly
                const matches = queryMatcher.matchesQuery(item.title, parsedQuery, fallbackStrict);

                if (matches) {
                    filteredResults.push(item);
                    continue;
                }

                if (item.neokyoLink) {
                    if (rateLimitHit) {
                        filteredResults.push(item);
                        continue;
                    }

                    const fullTitle = await fetchFullTitle(item.neokyoLink);

                    if (fullTitle === 'RATE_LIMIT') {
                        rateLimitHit = true;
                        filteredResults.push(item);
                        continue;
                    }

                    if (fullTitle) {
                        const fullMatches = queryMatcher.matchesQuery(fullTitle, parsedQuery, strict);
                        if (fullMatches) {
                            item.title = fullTitle;
                            filteredResults.push(item);
                            continue;
                        }
                    } else {
                        filteredResults.push(item);
                        continue;
                    }
                }
            }
            results = filteredResults;
            console.log(`[Suruga-ya] Filtered ${initialCount - results.length} items. Remaining: ${results.length}`);
        }

        // Remove neokyoLink from final results (internal use only)
        if (results !== null) {
            results = (results || []).map(item => {
                const { neokyoLink, ...rest } = item;
                return rest;
            });
            console.log(`[Suruga-ya] Neokyo search successful (${results.length} items).`);
            return results;
        }
        console.log('[Suruga-ya] Neokyo failed (returned null), falling back to DEJapan...');
    } catch (err) {
        console.warn(`[Suruga-ya] Neokyo error: ${err.message}. Falling back to DEJapan...`);
    }

    // Priority 2: DEJapan (Surugaya via DEJapan)
    try {
        console.log('[Suruga-ya] Attempting Fallback: DEJapan...');
        const dejapanResults = await dejapan.searchSurugaya(query, strict, filters);
        if (dejapanResults !== null) {
            console.log(`[Suruga-ya] DEJapan search successful (${dejapanResults.length} items).`);
            return dejapanResults;
        }
    } catch (err) {
        console.warn(`[Suruga-ya] DEJapan error: ${err.message}. All methods failed.`);
    }

    return [];

    return [];
}

module.exports = { search };
