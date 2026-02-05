const axios = require('axios');

const ENDPOINT = 'https://sig.doorzo.com/';

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function search(query) {
    // Doorzo requires specific params to filter by PayPay
    const params = {
        n: 'Sig.Front.SubSite.AppGlobal.MixSearch',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        keyword: query,
        website: 'paypay',
        onlyInStock: 1,
        orderBy: 'created_desc',
        deviceId: generateDeviceId()
    };

    try {
        const res = await axios.get(ENDPOINT, {
            params,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://www.doorzo.com',
                'Referer': 'https://www.doorzo.com/'
            },
            timeout: 10000
        });

        if (res.data && res.data.data && Array.isArray(res.data.data.items)) {
            const items = res.data.data.items;
            console.log(`[Doorzo] Found ${items.length} items for "${query}"`);

            return items.map(item => {
                // Item structure:
                // {
                //   "ImageUrl": "...",
                //   "Url": "z509043052", (ID)
                //   "Name": "...",
                //   "JPYPrice": 75000,
                //   ...
                // }

                // Format price: 75000 -> "¥75,000"
                const formattedPrice = item.JPYPrice ? `¥${item.JPYPrice.toLocaleString()}` : 'N/A';

                return {
                    title: item.Name,
                    price: formattedPrice,
                    // Original PayPay Link reconstruction
                    // Doorzo Link: https://www.doorzo.com/en/mall/paypay/detail/${item.Url}
                    // Native PayPay Link: https://paypayfleamarket.yahoo.co.jp/item/${item.Url}
                    // We return Native link for consistency with system, but maybe fallback scraper should return proxy link?
                    // Neokyo scraper returns Neokyo link.
                    // Let's return Doorzo link or Native?
                    // User Request: "I want to develop another axio fallback for PayPay Flea Market using Doorzo"
                    // Usually fallback scrapers (Neokyo) provide the PROXY link so users can buy.
                    link: `https://www.doorzo.com/en/mall/paypay/detail/${item.Url}`,
                    image: item.ImageUrl,
                    source: 'PayPay Flea Market' // Or 'Doorzo (PayPay)'? System uses 'PayPay Flea Market' for deduplication.
                };
            });
        }

        return [];

    } catch (err) {
        console.error(`[Doorzo] Error searching for "${query}":`, err.message);
        return null; // Return null to indicate failure (trigger fallback)
    }
}

module.exports = { search };
