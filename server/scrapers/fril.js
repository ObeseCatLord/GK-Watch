const axios = require('axios');
const cheerio = require('cheerio');

async function search(query) {
    console.log(`Searching Fril for ${query}...`);
    const searchUrl = `https://fril.jp/s?query=${encodeURIComponent(query)}`;

    // Parse search terms for strict matching
    const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
    // console.log(`Fril strict matching: all terms must match:`, searchTerms);

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
        const itemBoxes = $('.item-box');

        itemBoxes.each((i, el) => {
            try {
                // Skip sold out items
                if ($(el).find('.item-box__soldout_ribbon').length > 0) return;

                // Get title from the name span
                const title = $(el).find('.item-box__item-name span').text().trim();
                if (!title) return;

                // Get link from image wrapper
                const linkEl = $(el).find('.item-box__image-wrapper a[href*="item.fril.jp"]');
                if (!linkEl.length) return;
                const link = linkEl.attr('href');

                // Get image
                const imgEl = $(el).find('.item-box__image-wrapper img');
                const image = imgEl.attr('data-original') || imgEl.attr('src') || '';

                // Get price
                let price = 'N/A';
                const priceEl = $(el).find('.item-box__item-price');
                if (priceEl.length) {
                    const priceSpan = priceEl.find('span[data-content]:not([data-content="JPY"])');
                    if (priceSpan.length) {
                        const priceValue = priceSpan.attr('data-content');
                        price = '¥' + Number(priceValue).toLocaleString();
                    } else {
                        // Fallback to text content
                        price = priceEl.text().trim();
                    }
                }

                results.push({
                    title,
                    link,
                    image,
                    price,
                    source: 'Rakuma' // Updated source name to be more recognizable
                });
            } catch (e) {
                // Skip bad items
            }
        });

        // Strict filtering: all search terms must be present in the title
        const filteredResults = results.filter(item => {
            const titleLower = item.title.toLowerCase();
            return searchTerms.every(term => titleLower.includes(term.toLowerCase()));
        });

        console.log(`Fril: Found ${results.length} items, ${filteredResults.length} after strict filter`);
        return filteredResults;

    } catch (error) {
        console.error('Fril Scraper Error:', error.message);
        if (error.response && error.response.status === 404) {
            return []; // No results found often returns 404 on some sites, though Fril usually just empty list
        }
        return [];
    }
}

module.exports = { search };
