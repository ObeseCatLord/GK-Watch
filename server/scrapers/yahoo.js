const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { matchTitle } = require('../utils/queryMatcher');

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
                        price,
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
            headless: "new",
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
                    price: price !== 'N/A' ? `¥${price}` : price,
                    source: 'Yahoo (Neokyo)'
                });
            }
        });

        const uniqueResults = results.filter((v, i, a) => a.findIndex(t => (t.link === v.link)) === i);

        console.log(`[Yahoo Fallback] Found ${uniqueResults.length} items on Neokyo.`);
        return uniqueResults;

    } catch (err) {
        console.error('Neokyo Fallback Error:', err.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

// Puppeteer-based Yahoo Auctions scraper (fallback for when Axios fails)
async function searchYahooPuppeteer(query, strictEnabled = true) {
    console.log(`[Yahoo Fallback] Searching Yahoo Auctions via Puppeteer for ${query}...`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();

        // Block images/fonts for speed
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const url = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(query)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Wait a bit for any JS rendering
        await new Promise(r => setTimeout(r, 2000));

        const content = await page.content();
        const $ = cheerio.load(content);
        const results = [];

        $('.Products__items li.Product').each((i, element) => {
            try {
                const titleEl = $(element).find('.Product__titleLink');
                const title = titleEl.text().trim();
                const link = titleEl.attr('href');
                const imageEl = $(element).find('.Product__imageData');
                const image = imageEl.attr('src');
                const priceEl = $(element).find('.Product__priceValue');
                const price = priceEl.text().trim();

                if (title && link) {
                    results.push({
                        title,
                        link,
                        image: image || '',
                        price: price || 'N/A',
                        source: 'Yahoo (Puppeteer)'
                    });
                }
            } catch (err) {
                // ignore individual errors
            }
        });

        // Strict filtering using query matcher (supports | for OR, && for AND)
        if (strictEnabled) {
            const strictResults = results.filter(item => matchTitle(item.title, query));
            console.log(`[Yahoo Fallback] Found ${results.length} items via Puppeteer, ${strictResults.length} after strict filtering.`);
            return strictResults;
        }

        console.log(`[Yahoo Fallback] Found ${results.length} items via Puppeteer (Strict filtering disabled).`);
        return results;

    } catch (err) {
        console.error('Yahoo Puppeteer Fallback Error:', err.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

async function search(query, strictEnabled = true) {
    console.log(`Searching Yahoo Auctions for ${query}...`);
    try {
        const url = `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            validateStatus: function (status) {
                return status < 500;
            }
        });

        // Check specifically for Yahoo's 404 page - be more precise to avoid false positives
        if (data.includes('お探しのページは見つかりませんでした') || data.includes('ご指定のページが見つかりません')) {
            throw new Error('Yahoo Search Page invalid/404');
        }

        const $ = cheerio.load(data);
        const results = [];

        $('.Products__items li.Product').each((i, element) => {
            try {
                const titleEl = $(element).find('.Product__titleLink');
                const title = titleEl.text().trim();
                const link = titleEl.attr('href');
                const imageEl = $(element).find('.Product__imageData');
                const image = imageEl.attr('src');

                // Yahoo has multiple price elements - bid price and buy-it-now
                const priceElements = $(element).find('.Product__priceValue');
                let bidPrice = '';
                let binPrice = '';

                // First price is typically bid/current price
                if (priceElements.length >= 1) {
                    bidPrice = $(priceElements[0]).text().trim();
                }
                // Second price element if exists is typically buy-it-now
                if (priceElements.length >= 2) {
                    binPrice = $(priceElements[1]).text().trim();
                }

                // Combine for display: primary is bid, secondary is bin
                const price = bidPrice || 'N/A';

                if (title && link) {
                    results.push({
                        title,
                        link,
                        image: image || '',
                        price,
                        bidPrice: bidPrice || null,
                        binPrice: binPrice || null,
                        source: 'Yahoo'
                    });
                }
            } catch (err) {
                console.error('Error parsing yahoo item:', err);
            }
        });

        // Strict filtering using query matcher (supports | for OR, && for AND)
        if (strictEnabled) {
            const strictResults = results.filter(item => matchTitle(item.title, query));
            // Return results even if empty after strict filtering - 0 is OK if no error
            console.log(`Yahoo (Axios) found ${results.length} items, ${strictResults.length} after strict filtering.`);
            return strictResults;
        }

        console.log(`Yahoo (Axios) found ${results.length} items (Strict filtering disabled).`);
        return results;
    } catch (error) {
        console.warn(`Yahoo Axios Scraper failed (${error.message}), attempting Puppeteer fallback...`);

        // Chain 1: Yahoo via Puppeteer (direct scraping with headless browser)
        try {
            const yahooPuppeteerResults = await searchYahooPuppeteer(query, strictEnabled);
            // Return even if empty - 0 results is OK if no error
            return yahooPuppeteerResults;
        } catch (puppeteerError) {
            console.warn(`Yahoo Puppeteer failed (${puppeteerError.message}), attempting Neokyo fallback...`);
        }

        // Chain 2: Neokyo (only if Puppeteer threw an error)
        try {
            const neokyoResults = await searchNeokyo(query);
            if (strictEnabled) {
                return neokyoResults.filter(item => matchTitle(item.title, query));
            }
            return neokyoResults;
        } catch (neokyoError) {
            console.warn(`Neokyo failed (${neokyoError.message}), attempting Jauce fallback...`);
        }

        // Chain 3: Jauce (only if both Puppeteer and Neokyo threw errors)
        const jauceResults = await searchJauce(query);
        if (strictEnabled) {
            return jauceResults.filter(item => matchTitle(item.title, query));
        }
        return jauceResults;
    }
}

module.exports = { search };
