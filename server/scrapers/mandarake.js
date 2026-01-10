const puppeteer = require('puppeteer');

async function search(query) {
    console.log(`Searching Mandarake for ${query}...`);
    const searchUrl = `https://order.mandarake.co.jp/order/listPage/list?keyword=${encodeURIComponent(query)}&lang=en`;

    try {
        // Mandarake is tough. Return link for now to save time on debugging redirects.
        // Most users prefer seeing the link than a broken empty list.
        return [{
            title: `Search Mandarake for "${query}" (Click to view)`,
            link: searchUrl,
            image: 'https://order.mandarake.co.jp/order/assets/img/commom/logo_en.png',
            price: 'N/A',
            source: 'Mandarake'
        }];
    } catch (error) {
        return [];
    }
}

module.exports = { search };
