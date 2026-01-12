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

/**
 * Sign the MTOP request
 */
function signRequest(token, t, appKey, dataStr) {
    const str = `${token}&${t}&${appKey}&${dataStr}`;
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Helper to parse prices from diverse Goofish formats
 */
function parsePrice(priceRaw) {
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
    return price;
}

async function searchWithAxios(query, cookies, retryCount = 0) {
    console.log(`[Goofish] Fetching with Axios${retryCount > 0 ? ' (Retry)' : ''}...`);

    try {
        // 1. Get Token from cookies
        const tokenCookie = cookies.find(c => c.name === '_m_h5_tk');
        const tokenEncCookie = cookies.find(c => c.name === '_m_h5_tk_enc');

        if (!tokenCookie) {
            console.log('[Goofish] No _m_h5_tk cookie found. Axios scraping might fail (or need empty token logic).');
        }

        const rawToken = tokenCookie ? tokenCookie.value : '';
        const token = rawToken.split('_')[0]; // Extract first part
        const t = Date.now();
        const appKey = '34839810';

        // 2. Prepare Data
        const dataObj = {
            "pageNumber": 1,
            "keyword": query,
            "fromFilter": false,
            "rowsPerPage": 30,
            "sortValue": "",
            "sortField": "",
            "customDistance": "",
            "gps": "",
            "propValueStr": {},
            "customGps": "",
            "searchReqFromPage": "pcSearch",
            "extraFilterValue": "{}",
            "userPositionJson": "{}"
        };
        const dataStr = JSON.stringify(dataObj);

        // 3. Sign
        const sign = signRequest(token, t, appKey, dataStr);

        // 4. Send Request
        const url = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';
        const params = {
            jsv: '2.7.2',
            appKey,
            t,
            sign,
            v: '1.0',
            type: 'originaljson',
            accountSite: 'xianyu',
            dataType: 'json',
            timeout: 20000,
            api: 'mtop.taobao.idlemtopsearch.pc.search',
            sessionOption: 'AutoLoginOnly',
            spm_cnt: 'a21ybx.search.0.0'
        };

        // Convert cookies to header string
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        const response = await axios.post(url, { data: dataStr }, {
            params,
            headers: {
                'accept': 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
                'cookie': cookieHeader,
                'origin': 'https://www.goofish.com',
                'referer': 'https://www.goofish.com/',
                'user-agent': USER_AGENT
            },
            // transformRequest needed because axios sends JSON by default, but this API expects url encoded body 'data=...'
            transformRequest: [function (data) {
                return `data=${encodeURIComponent(data.data)}`;
            }]
        });

        // 5. Parse Response
        const resData = response.data;

        // Handle Token Expiry / Update
        if (resData.ret && resData.ret[0] && resData.ret[0].startsWith('FAIL_SYS_TOKEN_EXOIRED')) {
            console.log('[Goofish] Token expired. Updating cookies from response headers...');

            // Extract new cookies
            // Axios 'set-cookie' header
            const setCookie = response.headers['set-cookie'];
            if (setCookie && retryCount < 2) {
                const newCookies = [...cookies];

                setCookie.forEach(sc => {
                    const parts = sc.split(';')[0].split('=');
                    if (parts.length >= 2) {
                        const name = parts[0].trim();
                        const value = parts[1].trim();

                        const idx = newCookies.findIndex(c => c.name === name);
                        if (idx !== -1) newCookies[idx].value = value;
                        else newCookies.push({ name, value });

                        console.log(`[Goofish] Updated cookie: ${name}`);
                    }
                });

                // Retry with new cookies
                return await searchWithAxios(query, newCookies, retryCount + 1);
            }
        }

        if (resData.ret && resData.ret[0] === 'SUCCESS::调用成功') {
            let items = [];
            if (resData.data && resData.data.items) items = resData.data.items;
            else if (resData.data && resData.data.cardList) items = resData.data.cardList;
            else if (resData.data && resData.data.resultList) items = resData.data.resultList;

            if (items && items.length > 0) {
                console.log(`[Goofish] Axios extracted ${items.length} items.`);

                return items.map(itemWrapper => {
                    let item = itemWrapper.data?.item || itemWrapper.data || itemWrapper;

                    // Handle wrapped content
                    if (item.main && item.main.exContent) {
                        // Some responses wrap item data deeper
                        // Merge strategy similar to puppeteer
                    }

                    let exContent = (item.main && item.main.exContent) ? item.main.exContent : {};
                    let source = Object.keys(exContent).length > 0 ? exContent : item;

                    // Standardize fields
                    let title = source.title || item.title || 'No Title';
                    let price = parsePrice(source.price || item.price || item.priceWithSymbol);

                    // Image
                    let image = '';
                    if (source.picUrl) image = source.picUrl;
                    else if (source.mainPic && source.mainPic.picUrl) image = source.mainPic.picUrl;
                    else if (item.picUrl) image = item.picUrl;

                    if (image && image.startsWith('http:')) image = image.replace(/^http:/, 'https:');
                    if (image && image.startsWith('//')) image = 'https:' + image;

                    // ID
                    let id = source.itemId || item.itemId || source.id || item.id;
                    if (!id && item.targetUrl) {
                        const match = item.targetUrl.match(/id=(\d+)/);
                        if (match) id = match[1];
                    }

                    return {
                        title: title.replace(/<[^>]*>/g, '').trim(),
                        link: `https://www.goofish.com/item?id=${id}`,
                        image,
                        price,
                        source: 'Goofish',
                        shopName: source.userNickName || item.userNickName || 'Goofish Seller'
                    };
                });
            }
        }

        console.log('[Goofish] Axios return code:', resData.ret ? resData.ret[0] : 'Unknown');
        console.log('[Goofish] No items found with Axios.');
        return null; // Null indicates fallback needed

    } catch (err) {
        console.error('[Goofish] Axios error:', err.message);
        return null;
    }
}

async function search(query) {
    console.log(`[Goofish] Searching for: ${query}`);

    // Load cookies
    const cookies = loadCookies();
    let results = null;

    if (cookies) {
        results = await searchWithAxios(query, cookies);
    } else {
        console.log('[Goofish] No cookies available for Axios, skipping.');
    }

    if (results) {
        return results;
    }

    console.log('[Goofish] Falling back to Puppeteer...');
    return await searchWithPuppeteer(query);
}

function hasValidCookies() {
    return loadCookies() !== null;
}

module.exports = { search, hasValidCookies };
