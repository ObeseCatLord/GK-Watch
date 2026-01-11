const axios = require('axios');
const cheerio = require('cheerio');

async function search(query) {
    console.log(`Searching PayPay Flea Market for ${query}...`);
    const searchUrl = `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}`;

    // Parse search terms for strict matching
    const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
    // console.log(`PayPay strict matching: all terms must match:`, searchTerms);

    try {
        const res = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'ja-JP'
            },
            timeout: 10000
        });

        const $ = cheerio.load(res.data);
        const results = [];
        const seen = new Set();

        // Find all anchor tags that link to items
        const links = $('a[href^="/item/"]');

        links.each((i, el) => {
            try {
                const href = $(el).attr('href');
                if (!href || seen.has(href)) return;
                seen.add(href);

                // Find image with alt text (title)
                const img = $(el).find('img');
                if (!img.length) return;

                const title = img.attr('alt');
                if (!title) return;

                const image = img.attr('src');
                const itemLink = 'https://paypayfleamarket.yahoo.co.jp' + href;

                // Find price - look inside the link element for a p tag with price
                let price = 'N/A';
                // The price structure in PayPay can vary, assuming generic p tag match from original logic
                const priceElement = $(el).find('p');
                if (priceElement.length) {
                    const priceText = priceElement.text();
                    const priceMatch = priceText.match(/(\d{1,3}(,\d{3})*)円/);
                    if (priceMatch) {
                        price = priceMatch[0];
                    }
                }

                results.push({
                    title,
                    link: itemLink,
                    image,
                    price,
                    source: 'PayPay Flea Market'
                });
            } catch (e) {
                // Skip bad items
            }
        });

        // Strict filtering: all search terms must be present in the title
        // Strict filtering with GK Synonym Support
        const GK_VARIANTS = ['ガレージキット', 'レジンキット', 'レジンキャスト', 'レジンキャストキット'];

        const filteredResults = results.filter(item => {
            const titleLower = item.title.toLowerCase();
            return searchTerms.every(term => {
                const termLower = term.toLowerCase();
                if (GK_VARIANTS.includes(termLower)) {
                    return GK_VARIANTS.some(variant => titleLower.includes(variant));
                }
                return titleLower.includes(termLower);
            });
        });

        console.log(`PayPay Flea Market: Found ${results.length} items, ${filteredResults.length} after strict filter`);
        return filteredResults;

    } catch (error) {
        if (error.response && (error.response.status === 403 || error.response.status === 500)) {
            console.warn('PayPay Flea Market access blocked (Status ' + error.response.status + '). Likely bot detection.');
            return { error: true, status: error.response.status, items: [] };
        }
        console.error('PayPay Flea Market Scraper Error:', error.message);
        if (error.response && error.response.status === 404) {
            return [];
        }
        return { error: true, status: 0, items: [] };
    }
}

module.exports = { search };
