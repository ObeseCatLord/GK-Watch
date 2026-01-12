const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const GOOFISH_SEARCH_URL = 'https://www.goofish.com/search';
const COOKIES_FILE = path.join(__dirname, '../data/goofish_cookies.json');
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

function loadCookies() {
    try {
        if (!fs.existsSync(COOKIES_FILE)) {
            console.log('[Goofish] Note: Cookie file not found at', COOKIES_FILE);
            return null;
        }

        const cookieData = fs.readFileSync(COOKIES_FILE, 'utf8');
        const cookies = JSON.parse(cookieData);

        if (!Array.isArray(cookies) || cookies.length === 0) {
            console.log('[Goofish] Warning: Invalid or empty cookie file');
            return null;
        }

        return cookies;
    } catch (error) {
        console.error('[Goofish] Error loading cookies:', error.message);
        return null;
    }
}

function buildSearchUrl(query) {
    const encodedQuery = encodeURIComponent(query);
    return `${GOOFISH_SEARCH_URL}?q=${encodedQuery}`;
}

async function searchWithPuppeteer(query) {
    let browser = null;
    try {
        const searchUrl = buildSearchUrl(query);
        console.log(`[Goofish] Fetching with Puppeteer: ${searchUrl}`);

        const isARM = process.arch === 'arm' || process.arch === 'arm64';
        const executablePath = (process.platform === 'linux' && isARM)
            ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser')
            : undefined;

        browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();

        // 1. Try to load cookies first
        let cookies = loadCookies();
        if (!cookies) {
            console.log('[Goofish] No cookies found. Returning error.');
            if (browser) await browser.close();
            return [{ error: 'Cookie Error', source: 'Goofish' }];
        }

        console.log(`[Goofish] Loaded ${cookies.length} cookies from file.`);

        // Sanitize cookies for Puppeteer
        cookies = cookies.map(cookie => {
            const newCookie = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                secure: !!cookie.secure,
                httpOnly: !!cookie.httpOnly,
            };

            if (cookie.expires) {
                newCookie.expires = cookie.expires;
            }

            if (cookie.sameSite) {
                const lower = String(cookie.sameSite).toLowerCase();
                if (lower === 'strict') newCookie.sameSite = 'Strict';
                else if (lower === 'lax') newCookie.sameSite = 'Lax';
                else if (lower === 'none') {
                    newCookie.sameSite = 'None';
                    newCookie.secure = true;
                }
            }

            return newCookie;
        });

        await page.setCookie(...cookies);
        await page.setUserAgent(USER_AGENT);

        let apiResults = null;

        // Listen for API responses to find hidden data
        page.on('response', async response => {
            const url = response.url();
            if (url.includes('mtop.taobao.idlemtopsearch.pc.search') && url.indexOf('.shade') === -1 && url.indexOf('.activate') === -1) {
                let text = '';
                try {
                    text = await response.text();
                    const json = JSON.parse(text);
                    let items = [];
                    if (json.data && json.data.items) items = json.data.items;
                    else if (json.data && json.data.cardList) items = json.data.cardList;
                    else if (json.data && json.data.resultList) items = json.data.resultList;

                    if (items && items.length > 0) {
                        console.log(`[Goofish] Intercepted ${items.length} items from API.`);
                        apiResults = items.map((itemWrapper) => {
                            let item = itemWrapper;
                            if (itemWrapper.data && itemWrapper.data.item) {
                                item = itemWrapper.data.item;
                            } else if (itemWrapper.data) {
                                item = itemWrapper.data;
                            }

                            let exContent = {};
                            if (item.main) {
                                if (item.main.exContent) {
                                    exContent = item.main.exContent;
                                }
                                item = item.main;
                            }

                            const source = Object.keys(exContent).length > 0 ? exContent : item;

                            const title = source.title || item.title || 'No Title';

                            // Process Price
                            let priceRaw = source.price || item.price || item.priceWithSymbol || 'N/A';
                            let price = 'N/A';

                            // Handle Array (common in mtop)
                            if (Array.isArray(priceRaw)) {
                                try {
                                    let priceStr = priceRaw.map(p => p.text).join('');
                                    const match = priceStr.match(/(\d+(\.\d+)?)/);
                                    if (match) price = `${match[0]} RMB`;
                                } catch (e) { }
                            }
                            // Handle JSON string array
                            else if (typeof priceRaw === 'string' && priceRaw.startsWith('[')) {
                                try {
                                    const parsedObj = JSON.parse(priceRaw);
                                    if (Array.isArray(parsedObj)) {
                                        let priceStr = parsedObj.map(p => p.text).join('');
                                        const match = priceStr.match(/(\d+(\.\d+)?)/);
                                        if (match) price = `${match[0]} RMB`;
                                    }
                                } catch (e) { }
                            }
                            // Handle Object
                            else if (typeof priceRaw === 'object') {
                                let priceVal = priceRaw.price || priceRaw.value || priceRaw.amount;
                                if (priceVal) price = `${priceVal} RMB`;
                            }
                            // Handle simple string/number
                            else if (priceRaw !== 'N/A') {
                                const cleanPrice = String(priceRaw).replace(/[^0-9.]/g, '');
                                if (cleanPrice) price = `${cleanPrice} RMB`;
                            }

                            // Process Image
                            let image = '';
                            if (source.picUrl) image = source.picUrl;
                            else if (source.mainPic && source.mainPic.picUrl) image = source.mainPic.picUrl;
                            else if (item.picUrl) image = item.picUrl;
                            else if (item.mainPic && item.mainPic.picUrl) image = item.mainPic.picUrl;

                            if (image && image.startsWith('http:')) image = image.replace(/^http:/, 'https:');
                            if (image && image.startsWith('//')) image = 'https:' + image;

                            // Process Link
                            let id = source.itemId || item.itemId || source.id || item.id;
                            if (!id && item.targetUrl) {
                                const match = item.targetUrl.match(/id=(\d+)/);
                                if (match) id = match[1];
                            }
                            // Construct standard link
                            const link = `https://www.goofish.com/item?id=${id}`;

                            return {
                                title: title.replace(/<[^>]*>/g, '').trim(),
                                link,
                                image,
                                price,
                                source: 'Goofish',
                                shopName: source.userNickName || item.userNickName || 'Goofish Seller'
                            };
                        });
                    } else {
                        // Log empty items logic if JSON parsed but no items
                        // console.log('JSON structure does not contain items:', JSON.stringify(json).substring(0, 200));
                    }
                } catch (e) {
                    console.log(`[Goofish] Error parsing API response for URL: ${url}`);
                    console.log(`[Goofish] Response preview: ${text ? text.substring(0, 500) : 'No text captured'}`);
                    console.log(`[Goofish] Error details: ${e.message}`);
                }
            }
        });

        // Block images/fonts to speed up
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        console.log('[Goofish] Waiting for API capture...');
        let retries = 0;
        const scrollInterval = setInterval(() => {
            page.evaluate(() => window.scrollBy(0, 500)).catch(() => { });
        }, 1000);

        while (!apiResults && retries < 30) {
            await new Promise(r => setTimeout(r, 500));
            retries++;
        }
        clearInterval(scrollInterval);

        if (apiResults) {
            console.log(`[Goofish] Successfully extracted ${apiResults.length} items from API.`);
            return apiResults;
        }

        console.log('[Goofish] API capture failed or timed out. Returning empty results.');
        return [];

    } catch (error) {
        console.error('[Goofish] Scrape error:', error.message);
        return [];
    } finally {
        if (browser) await browser.close();
    }
}

async function search(query) {
    console.log(`[Goofish] Searching for: ${query}`);
    return await searchWithPuppeteer(query);
}

function hasValidCookies() {
    return loadCookies() !== null;
}

module.exports = { search, hasValidCookies };
