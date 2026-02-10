const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { matchTitle, parseQuery, hasQuotedTerms, matchesQuery } = require('../utils/queryMatcher');

// Helper to format price with ¥ prefix
function formatYahooPrice(priceText) {
    if (!priceText || priceText === 'N/A') return 'N/A';
    // Remove existing ¥, 円, commas, spaces and extract number
    const cleaned = priceText.replace(/[¥円,\s]/g, '').trim();
    const match = cleaned.match(/\d+/);
    if (match) {
        return `¥${Number(match[0]).toLocaleString()}`;
    }
    return 'N/A';
}

// Helper to calculate estimated end time from Yahoo's relative time string (supports JP and EN)
function calculateEndTime(timeStr) {
    if (!timeStr) return null;

    const now = Date.now();
    let durationMs = 0;

    // Yahoo formats: "3日", "16時間", "10分", "10秒"
    // Doorzo formats: "6 Days", "10 Hours", etc.

    const cleanStr = timeStr.toLowerCase().replace(/,/g, '');

    if (cleanStr.includes('日') || cleanStr.includes('day')) {
        const days = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = days * 24 * 60 * 60 * 1000;
    } else if (cleanStr.includes('時間') || cleanStr.includes('hour')) {
        const hours = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = hours * 60 * 60 * 1000;
    } else if (cleanStr.includes('分') || cleanStr.includes('min')) {
        const minutes = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = minutes * 60 * 1000;
    } else if (cleanStr.includes('秒') || cleanStr.includes('sec')) {
        const seconds = parseInt(cleanStr.replace(/[^0-9]/g, ''), 10);
        durationMs = seconds * 1000;
    }

    if (durationMs > 0) {
        return new Date(now + durationMs).toISOString(); // Return ISO timestamp
    }

    return null;
}

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Doorzo-based Yahoo Scraper (Fallback for Axios)
async function searchDoorzo(query, strictEnabled = true, allowInternationalShipping = false, targetSource = 'all', filters = []) {
    console.log(`[Yahoo Fallback] Searching Yahoo via Doorzo for ${query}...`);
    const ENDPOINT = 'https://sig.doorzo.com/';

    // URL Params for the signature endpoint
    const urlParams = {
        n: 'Sig.Front.SubSite.AppYahoo.Search',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        deviceId: generateDeviceId()
    };

    // Body Params for the search Query
    const bodyBase = {
        keyword: query,
        keywords: query,
        fixed: '1',
        goodsStatus: '',
        sellerType: '',
        pType: 'currentprice',
        shipmentType: '',
        is_appraisal: ''
    };

    let allItems = [];
    let page = 1;
    const MAX_PAGES = 200; // Deep search cap

    try {
        // Construct basic query string for the URL
        const queryString = Object.keys(urlParams)
            .map(key => `${key}=${encodeURIComponent(urlParams[key])}`)
            .join('&');
        const fullUrl = `${ENDPOINT}?${queryString}`;

        do {
            const currentBody = { ...bodyBase, page: page };

            const res = await axios.post(fullUrl, currentBody, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://www.doorzo.com',
                    'Referer': 'https://www.doorzo.com/'
                },
                timeout: 30000
            });

            if (res.data && res.data.data && Array.isArray(res.data.data.list)) {
                const items = res.data.data.list;
                if (items.length === 0) break; // formatting error or end of results

                allItems = allItems.concat(items);
                console.log(`[Yahoo Fallback] Doorzo page ${page} found ${items.length} items.`);

                page++;

                // Be nice to the API
                if (page <= MAX_PAGES) await sleep(500);

            } else {
                // End of results or invalid response
                break;
            }
        } while (page <= MAX_PAGES);

        let results = [];
        if (allItems.length > 0) {

            results = allItems.map(item => {
                // Use Asin for ID if available, otherwise try to extract from Url
                let link = '';
                if (item.Asin) {
                    link = `https://page.auctions.yahoo.co.jp/jp/auction/${item.Asin}`;
                } else if (item.Url) {
                    // Try to decode hex if Asin is missing (unlikely for Yahoo on Doorzo)
                    try {
                        const decoded = Buffer.from(item.Url, 'hex').toString('utf8');
                        link = decoded;
                    } catch {
                        link = `https://page.auctions.yahoo.co.jp/jp/auction/${item.Url}`;
                    }
                }

                // Check for PayPay Flea Market indicator
                // Doorzo might mix them? If website='yahoo', likely pure yahoo.
                const isPayPay = false; // Doorzo 'yahoo' endpoint usually filters to yahoo auctions

                const itemSource = 'Yahoo';

                // Format price: 15000 -> "¥15,000"
                const bidPrice = item.BidJPYPrice ? `¥${Number(item.BidJPYPrice).toLocaleString()}` : 'N/A';
                const binPrice = item.BuyNowPrice ? `¥${Number(item.BuyNowPrice).toLocaleString()}` : 'N/A';
                const price = bidPrice !== 'N/A' ? bidPrice : binPrice;

                return {
                    title: item.Name,
                    link,
                    image: item.ImageUrl,
                    price,
                    bidPrice,
                    binPrice,
                    endTime: calculateEndTime(item.RemainingTime),
                    source: itemSource
                };
            });

            console.log(`[Yahoo Fallback] Doorzo found ${results.length} total items.`);
        }

        // Apply Strict Filtering if enabled
        // Parsing is same as before
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const strictResults = results.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`[Yahoo Fallback] Doorzo found ${results.length} items, ${strictResults.length} after strict filtering.`);
            return strictResults;
        }

        return results;

    } catch (err) {
        console.error('Doorzo Yahoo Fallback Error:', err.message);
        return null; // Return null to trigger next fallback
    }
}

async function searchJauce(query) {
    console.log(`[Yahoo Fallback] Searching Jauce for ${query}...`);
    try {
        const url = `https://www.jauce.com/search/${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        const results = [];

        $('.article').each((i, element) => {
            try {
                let linkEl = $(element).closest('a');
                let link = linkEl.attr('href');

                if (!link) {
                    link = $(element).find('a').attr('href');
                }

                if (link) {
                    if (!link.startsWith('http')) {
                        link = `https://www.jauce.com${link}`;
                    }
                    link = link.replace('/auction/../auction/', '/auction/');
                }

                const imgEl = $(element).find('.spot img');
                const image = imgEl.attr('src');
                let title = imgEl.attr('alt') || $(element).text().trim();

                if (title && title.includes('</a>')) {
                    title = title.split('</a>')[0].replace(/<[^>]*>/g, '');
                }

                const infoText = $(element).find('.information').text();
                const priceMatch = infoText.match(/Bid:\s*([0-9,]+)/);
                const price = priceMatch ? `¥${priceMatch[1]}` : 'N/A';

                if (title && link) {
                    results.push({
                        title: title.trim(),
                        link,
                        image: image || '',
                        price: formatYahooPrice(price),
                        source: 'Yahoo (Jauce)'
                    });
                }
            } catch (err) {
                // ignore individual item parse errors
            }
        });

        console.log(`[Yahoo Fallback] Found ${results.length} items on Jauce.`);
        return results;

    } catch (err) {
        console.error('Jauce Fallback Error:', err.message);
        return [];
    }
}

async function searchNeokyo(query) {
    console.log(`[Yahoo Fallback] Searching Neokyo (Puppeteer) for ${query}...`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Step 1: Go to homepage (10s timeout for faster fallback)
        await page.goto('https://neokyo.com/en', { waitUntil: 'domcontentloaded', timeout: 10000 });

        // Step 2: Input Query
        await page.waitForSelector('.main-search-input', { timeout: 3000 });
        await page.type('.main-search-input', query);

        // Step 3: Submit (Use evaluate to avoid click errors)
        const submitted = await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn) {
                btn.click();
                return true;
            }
            const input = document.querySelector('.main-search-input');
            const form = input ? input.closest('form') : null;
            if (form) {
                form.submit();
                return true;
            }
            return false;
        });

        if (submitted) {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { });
        } else {
            console.log("Submit button/form not found, trying Enter key...");
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { });
        }

        // Step 4: Parse Results
        const content = await page.content();
        const $ = cheerio.load(content);
        const results = [];

        $('a').each((i, element) => {
            const link = $(element).attr('href');
            if (link && (link.includes('yahoo-auction/item/') || link.includes('yahoo/auction'))) {
                const title = $(element).text().trim();
                const img = $(element).find('img').attr('src') || '';
                const priceText = $(element).text().match(/[0-9,]+ yen/);
                const price = priceText ? priceText[0].replace(' yen', '') : 'N/A';

                const fullLink = link.startsWith('http') ? link : `https://neokyo.com${link}`;

                results.push({
                    title,
                    link: fullLink,
                    image: img,
                    price: formatYahooPrice(price),
                    source: 'Yahoo (Neokyo)'
                });
            }
        });

        const uniqueResults = results.filter((v, i, a) => a.findIndex(t => (t.link === v.link)) === i);

        console.log(`[Yahoo Fallback] Found ${uniqueResults.length} items on Neokyo.`);
        return uniqueResults;

    } catch (err) {
        console.error('Neokyo Fallback Error:', err.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

async function search(query, strictEnabled = true, allowInternationalShipping = false, targetSource = 'all', filters = []) {
    console.log(`Searching Yahoo Auctions for ${query} (Target: ${targetSource})...`);

    // Chain 1: Doorzo (API-based, primary — Yahoo has rate-limited/blocked direct Axios from this IP)
    try {
        const doorzoResults = await searchDoorzo(query, strictEnabled, allowInternationalShipping, targetSource, filters);
        if (doorzoResults !== null) {
            return doorzoResults;
        }
        console.warn(`[Yahoo] Doorzo returned null, falling back to native Axios...`);
    } catch (doorzoError) {
        console.warn(`[Yahoo] Doorzo failed (${doorzoError.message}), falling back to native Axios...`);
    }

    // Chain 2: Native Axios (fallback — may fail if Yahoo IP is blocked)
    try {
        let results = [];
        let page = 0;
        const MAX_PAGES = 200;
        const seenLinks = new Set();

        while (page < MAX_PAGES) {
            try {
                const b = page * 50 + 1;
                const url = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(query)}&b=${b}`;

                if (page > 0) await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));

                const { data } = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    timeout: 30000,
                    validateStatus: function (status) {
                        return status < 500;
                    }
                });

                if (data.includes('お探しのページは見つかりませんでした') || data.includes('ご指定のページが見つかりません')) {
                    if (page === 0) throw new Error('Yahoo Search Page invalid/404');
                    break;
                }

                const $ = cheerio.load(data);
                let pageResults = [];

                $('.Products__items li.Product').each((i, element) => {
                    try {
                        if (!allowInternationalShipping) {
                            const fullText = $(element).text();
                            if (fullText.includes('海外から発送')) return;
                        }

                        const titleEl = $(element).find('.Product__titleLink');
                        const title = titleEl.text().trim();
                        const link = titleEl.attr('href');
                        const imageEl = $(element).find('.Product__imageData');
                        const image = imageEl.attr('src');

                        const timeEl = $(element).find('.Product__time');
                        const timeStr = timeEl.text().trim();
                        const endTime = calculateEndTime(timeStr);

                        const isPayPay = $(element).find('.Product__icon').text().includes('Yahoo!フリマ') || (link && link.includes('paypayfleamarket'));

                        if (targetSource === 'yahoo' && isPayPay) return;
                        if (targetSource === 'paypay' && !isPayPay) return;

                        const itemSource = isPayPay ? 'PayPay Flea Market' : 'Yahoo';

                        const priceElements = $(element).find('.Product__priceValue');
                        let bidPrice = '';
                        let binPrice = '';

                        if (priceElements.length >= 1) bidPrice = $(priceElements[0]).text().trim();
                        if (priceElements.length >= 2) binPrice = $(priceElements[1]).text().trim();

                        const price = bidPrice || 'N/A';

                        if (title && link) {
                            pageResults.push({
                                title, link, image: image || '',
                                price: formatYahooPrice(price),
                                bidPrice: formatYahooPrice(bidPrice),
                                binPrice: formatYahooPrice(binPrice),
                                endTime, source: itemSource
                            });
                        }
                    } catch (err) {
                        console.error('Error parsing yahoo item:', err);
                    }
                });

                if (pageResults.length === 0) break;

                const newResults = pageResults.filter(item => !seenLinks.has(item.link));
                newResults.forEach(item => seenLinks.add(item.link));

                if (newResults.length === 0) {
                    console.log(`[Yahoo Native] Page ${page + 1}: all ${pageResults.length} items are duplicates. Stopping pagination.`);
                    break;
                }

                console.log(`[Yahoo Native] Page ${page + 1} found ${newResults.length} new items (${pageResults.length - newResults.length} duplicates skipped).`);
                results = results.concat(newResults);

                // If page had fewer than 50 items, it's the last page — no need to request more
                if (pageResults.length < 50) {
                    console.log(`[Yahoo Native] Page ${page + 1} had ${pageResults.length} items (< 50). Last page reached.`);
                    break;
                }

                page++;

            } catch (err) {
                if (page === 0) throw err;
                console.warn(`[Yahoo Native] Error on page ${page + 1} (${err.message}). Returning ${results.length} items found so far.`);
                break;
            }
        }

        if (filters && filters.length > 0) {
            const filterTerms = filters.map(f => f.toLowerCase());
            const preCount = results.length;
            results = results.filter(item => {
                const titleLower = item.title.toLowerCase();
                return !filterTerms.some(term => titleLower.includes(term));
            });
            console.log(`[Yahoo] Server-side negative filtering removed ${preCount - results.length} items. Remaining: ${results.length}`);
        }

        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            const strictResults = results.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
            console.log(`Yahoo (Axios) found ${results.length} items, ${strictResults.length} after strict filtering${hasQuoted ? ' (Quoted Terms Enforced)' : ''}.`);
            return strictResults;
        }

        console.log(`Yahoo (Axios) found ${results.length} items (Strict filtering disabled).`);
        return results;
    } catch (axiosError) {
        console.warn(`[Yahoo] Native Axios also failed (${axiosError.message}), trying Neokyo...`);
    }

    // Chain 3: Neokyo (Puppeteer)
    try {
        const neokyoResults = await searchNeokyo(query);
        const parsedQuery = parseQuery(query);
        const hasQuoted = hasQuotedTerms(parsedQuery);

        if (strictEnabled || hasQuoted) {
            return neokyoResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
        }
        return neokyoResults;
    } catch (neokyoError) {
        console.warn(`[Yahoo] Neokyo failed (${neokyoError.message}), trying Jauce...`);
    }

    // Chain 4: Jauce (last resort)
    const jauceResults = await searchJauce(query);
    const parsedQuery = parseQuery(query);
    const hasQuoted = hasQuotedTerms(parsedQuery);

    if (strictEnabled || hasQuoted) {
        return jauceResults.filter(item => matchesQuery(item.title, parsedQuery, strictEnabled));
    }
    return jauceResults;
}

module.exports = { search };
