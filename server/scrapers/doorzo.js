const axios = require('axios');

const ENDPOINT = 'https://sig.doorzo.com/';

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function onAbort() {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
    }
    function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
});

function decodeHexUrl(hex) {
    if (!hex) return null;
    try {
        return Buffer.from(hex, 'hex').toString('utf8');
    } catch { return null; }
}

function normalizeWebsite(targetSite = 'paypay') {
    if (targetSite === 'surugaya' || targetSite === 'mercari') {
        return targetSite;
    }
    return 'paypay';
}

function sourceNameForWebsite(website) {
    if (website === 'paypay') return 'PayPay Flea Market';
    if (website === 'mercari') return 'Mercari';
    return 'Suruga-ya';
}

function buildMercariLink(item) {
    const asin = String(item.Asin || '').trim();
    if (asin) {
        if (/^m\d+$/.test(asin)) return `https://jp.mercari.com/item/${asin}`;
        return `https://jp.mercari.com/shops/product/${asin}`;
    }

    const decoded = decodeHexUrl(item.Url);
    if (decoded) {
        const match = decoded.match(/\/(?:jp\/items|items|item)\/([^/?#]+)/);
        if (match && match[1]) {
            return /^m\d+$/.test(match[1])
                ? `https://jp.mercari.com/item/${match[1]}`
                : `https://jp.mercari.com/shops/product/${match[1]}`;
        }
        return decoded;
    }

    return '';
}

function mapDoorzoItem(item, website) {
    const formattedPrice = item.JPYPrice ? `¥${Number(item.JPYPrice).toLocaleString()}` : 'N/A';

    let link = '';
    if (website === 'paypay') {
        link = `https://paypayfleamarket.yahoo.co.jp/item/${item.Url}`;
    } else if (website === 'surugaya') {
        const decoded = decodeHexUrl(item.Url);
        if (decoded) {
            const match = decoded.match(/detail\/([a-zA-Z0-9]+)/);
            if (match) {
                link = `https://www.suruga-ya.jp/product/detail/${match[1]}`;
            } else {
                link = decoded;
            }
        } else {
            link = `https://www.suruga-ya.jp/product/detail/${item.Url}`;
        }
    } else if (website === 'mercari') {
        link = buildMercariLink(item);
    }

    return {
        title: item.Name,
        price: formattedPrice,
        link,
        image: item.ImageUrl,
        source: sourceNameForWebsite(website)
    };
}

async function search(query, targetSite = 'paypay', signal = null, onPage = null) {
    signal?.throwIfAborted();
    // Doorzo requires specific params to filter
    const website = normalizeWebsite(targetSite);

    // Note: Doorzo allows filtering by multiple sites, but our architecture splits them.
    const params = {
        n: 'Sig.Front.SubSite.AppGlobal.MixSearch',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        keyword: query,
        website: website,
        onlyInStock: 1,
        orderBy: 'created_desc',
        deviceId: generateDeviceId()
    };

    let allItems = [];
    let pageCount = 0;
    const MAX_PAGES = 200; // Deep search cap
    let nextToken = null;

    try {
        do {
            const currentParams = { ...params };
            if (nextToken) {
                currentParams.nextPageToken = nextToken;
            }

            const res = await axios.get(ENDPOINT, {
                params: currentParams,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://www.doorzo.com',
                    'Referer': 'https://www.doorzo.com/'
                },
                timeout: 30000,
                signal
            });

            const responseCode = res.data?.code;
            const apiFailed = responseCode !== undefined
                && ![0, 200].includes(Number(responseCode));
            const responseData = res.data?.data;
            const items = responseData?.items === null ? [] : responseData?.items;
            if (!apiFailed && responseData && Array.isArray(items)) {
                allItems = allItems.concat(items);
                console.log(`[Doorzo] Page ${pageCount + 1} found ${items.length} items (Total: ${allItems.length})`);

                if (onPage && items.length > 0) {
                    await onPage(items.map(item => mapDoorzoItem(item, website)));
                }

                nextToken = responseData.nextPageToken;
                pageCount++;

                // Be polite
                if (nextToken) await sleep(500, signal);

            } else {
                const itemShape = responseData?.items === undefined ? 'missing' : typeof responseData.items;
                console.warn(`[Doorzo] Invalid API response while searching "${query}" on ${website} (code=${String(responseCode)}, items=${itemShape}).`);
                return allItems.length > 0
                    ? allItems.map(item => mapDoorzoItem(item, website))
                    : null;
            }

        } while (nextToken && pageCount < MAX_PAGES);

        console.log(`[Doorzo] Finished searching "${query}" on ${website}. Total items: ${allItems.length}`);

        return allItems.map(item => mapDoorzoItem(item, website));

    } catch (err) {
        if (signal?.aborted) throw err;
        console.error(`[Doorzo] Error searching for "${query}" on ${website}:`, err.message);
        // If we found some items before error, return them? Or just return what we have?
        // Better to return what we have if possible, but scraper logic expects null on critical failure.
        // If we have items, return them.
        if (allItems.length > 0) {
            return allItems.map(item => mapDoorzoItem(item, website));
        }
        return null;
    }
}

module.exports = { search, _mapDoorzoItem: mapDoorzoItem };
