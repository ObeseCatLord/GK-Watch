const axios = require('axios');

const ENDPOINT = 'https://sig.doorzo.com/';

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function decodeHexUrl(hex) {
    if (!hex) return null;
    try {
        return Buffer.from(hex, 'hex').toString('utf8');
    } catch { return null; }
}

async function search(query, targetSite = 'paypay') {
    // Doorzo requires specific params to filter
    const website = targetSite === 'surugaya' ? 'surugaya' : 'paypay';

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
            console.log(`[Doorzo] Found ${items.length} items for "${query}" (Site: ${website})`);

            return items.map(item => {
                // Item structure:
                // {
                //   "ImageUrl": "...",
                //   "Url": "z509043052" (PayPay ID) OR Hex String (Suruga-ya),
                //   "Name": "...",
                //   "JPYPrice": 75000,
                // }

                // Format price: 75000 -> "¥75,000"
                const formattedPrice = item.JPYPrice ? `¥${item.JPYPrice.toLocaleString()}` : 'N/A';

                // Determine Link
                let link = '';
                if (website === 'paypay') {
                    link = `https://www.doorzo.com/en/mall/paypay/detail/${item.Url}`;
                } else if (website === 'surugaya') {
                    // Suruga-ya URLs often come as hex encoded strings, or native IDs
                    // But based on benchmark, they use a generic detail structure or we can reconstruct generic
                    const decoded = decodeHexUrl(item.Url);
                    // If it decodes to a URL, use it? Or use doorzo wrapper?
                    // Doorzo wrapper: https://www.doorzo.com/en/mall/surugaya/detail/[ID?]
                    // Actually, based on benchmark output: '68747470... ' -> https://www.suruga-ya.jp/product/detail/602277652
                    // We should return the Doorzo proxy link if possible, or the native link if that's what we have.
                    // IMPORTANT: Ideally we link to the Proxy (Doorzo) so the user can buy.
                    // The item.Url seems to be the NATIVE url hex encoded.
                    // We need to extract the ID from it to build a Doorzo link.
                    // Decoded: https://www.suruga-ya.jp/product/detail/602277652
                    // Doorzo Link: https://www.doorzo.com/en/mall/surugaya/detail/602277652
                    if (decoded) {
                        const match = decoded.match(/detail\/([a-zA-Z0-9]+)/);
                        if (match) {
                            link = `https://www.suruga-ya.jp/product/detail/${match[1]}`;
                        } else {
                            link = decoded; // Fallback to native
                        }
                    } else {
                        // Fallback if decode fails (unlikely if API behaves as expected)
                        link = `https://www.suruga-ya.jp/product/detail/${item.Url}`;
                    }
                }

                return {
                    title: item.Name,
                    price: formattedPrice,
                    link: link,
                    image: item.ImageUrl,
                    source: website === 'paypay' ? 'PayPay Flea Market' : 'Suruga-ya' // Match system source names
                };
            });
        }

        return [];

    } catch (err) {
        console.error(`[Doorzo] Error searching for "${query}" on ${website}:`, err.message);
        return null; // Return null to indicate failure (trigger fallback)
    }
}

module.exports = { search };
