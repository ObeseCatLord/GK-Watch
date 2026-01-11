const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/**
 * Suruga-ya scraper using Neokyo as a proxy
 * Neokyo provides access to Suruga-ya listings without Cloudflare blocking
 */

const NEOKYO_SEARCH_URL = 'https://neokyo.com/en/search/surugaya';
const MAX_PAGES = 3; // Number of pages to scrape (24 items per page)

/**
 * Build the search URL for a given page
 */
function buildSearchUrl(query, page = 1) {
    const encodedQuery = encodeURIComponent(query);
    if (page === 1) {
        return `${NEOKYO_SEARCH_URL}?keyword=${encodedQuery}&provider=surugaya&spid=`;
    }
    // Pagination URL format with empty category parameters
    return `${NEOKYO_SEARCH_URL}?page=${page}&keyword=${encodedQuery}&translate=&google_translate=&category[level_1]=&category[level_2]=&category[level_3]=&category[level_4]=&category[level_5]=&category[level_6]=&category[level_7]=`;
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
        const priceText = $card.find('.price b').first().text().trim();
        const image = $card.find('img.card-img-top').attr('src');

        if (title && link) {
            // Extract price number
            const priceMatch = priceText.match(/(\d+)/);
            const price = priceMatch ? `¥${priceMatch[1]}` : priceText || 'N/A';

            results.push({
                title: title,
                link: convertToSurugayaLink(link),
                image: image ? image.trim() : 'https://www.suruga-ya.jp/img/logo.png',
                price: price,
                source: 'Suruga-ya'
            });
        }
    });

    return results;
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

        return results.length > 0 ? results : null;
    } catch (error) {
        console.log(`Suruga-ya (Axios) page fetch failed: ${error.message}`);
        return null;
    }
}

/**
 * Try to scrape multiple pages with Axios
 */
async function searchWithAxios(query) {
    const allResults = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        const searchUrl = buildSearchUrl(query, page);
        console.log(`Suruga-ya: Fetching page ${page}...`);

        const results = await fetchPageWithAxios(searchUrl);

        if (results === null) {
            if (page === 1) {
                // First page failed, need to fall back to Puppeteer
                console.log('Suruga-ya (Neokyo): No products found with Axios, page may need JS rendering');
                return null;
            } else {
                // Subsequent page failed, just stop pagination
                console.log(`Suruga-ya: Page ${page} empty, stopping pagination`);
                break;
            }
        }

        allResults.push(...results);

        // Small delay between pages to be respectful
        if (page < MAX_PAGES) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    if (allResults.length > 0) {
        console.log(`Suruga-ya (Neokyo/Axios): Found ${allResults.length} items across ${MAX_PAGES} pages`);
        return allResults;
    }

    return null;
}

/**
 * Fallback to Puppeteer for JS-rendered pages (single page only)
 */
async function searchWithPuppeteer(query) {
    const searchUrl = buildSearchUrl(query, 1);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for product cards to load
        await page.waitForSelector('.product-card', { timeout: 15000 });

        // Extract data
        const results = await page.evaluate(() => {
            const cards = document.querySelectorAll('.product-card');
            const items = [];

            cards.forEach(card => {
                const titleLink = card.querySelector('a.product-link');
                const priceEl = card.querySelector('.price b');
                const imgEl = card.querySelector('img.card-img-top');

                if (titleLink) {
                    const title = titleLink.textContent.trim();
                    const link = titleLink.href;
                    const priceText = priceEl ? priceEl.textContent.trim() : 'N/A';
                    const image = imgEl ? imgEl.src : '';

                    // Extract price number
                    const priceMatch = priceText.match(/(\d+)/);
                    const price = priceMatch ? `¥${priceMatch[1]}` : priceText;

                    items.push({
                        title,
                        link,
                        image: image || 'https://www.suruga-ya.jp/img/logo.png',
                        price,
                        source: 'Suruga-ya'
                    });
                }
            });

            return items;
        });

        // Convert Neokyo links to Suruga-ya links
        const convertedResults = results.map(item => ({
            ...item,
            link: convertToSurugayaLink(item.link)
        }));

        console.log(`Suruga-ya (Neokyo/Puppeteer): Found ${convertedResults.length} items`);
        return convertedResults;

    } catch (error) {
        console.error(`Suruga-ya (Puppeteer) failed: ${error.message}`);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Main search function - tries Axios first, falls back to Puppeteer
 */
async function search(query) {
    console.log(`Searching Suruga-ya for ${query}...`);

    // Try Axios first (faster)
    let results = await searchWithAxios(query);

    // Fall back to Puppeteer if Axios didn't work
    if (results === null) {
        console.log('Suruga-ya: Falling back to Puppeteer...');
        results = await searchWithPuppeteer(query);
    }

    // If we got results, return them
    if (results && results.length > 0) {
        return results;
    }

    // Fallback: return direct link if scraping fails
    console.log('Suruga-ya: Scraping failed, returning direct link');
    const directUrl = `https://www.suruga-ya.jp/search?category=&search_word=${encodeURIComponent(query)}`;
    return [{
        title: `Search Suruga-ya for "${query}" (Click to view)`,
        link: directUrl,
        image: 'https://www.suruga-ya.jp/img/logo.png',
        price: 'N/A',
        source: 'Suruga-ya'
    }];
}

module.exports = { search };
