const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');
const cheerio = require('cheerio');
const surugaya = require('../../scrapers/surugaya');

function neokyoMarketplaceHtml(productId = '602112502') {
    return `
        <div class="product-card">
            <a class="product-link" href="https://neokyo.com/en/product/surugaya/${productId}?tenpo_cd=400546">
                東方うたうチルノちゃん 「東方Project」 1/8 ガレージキット
            </a>
            <img class="card-img-top" src="https://files.neokyo.com/surugaya/database/pics_light/game/${productId}.jpg">
            <div class="buy">
                <span class="interval">Only Available in the Marketplace</span>
            </div>
            <h6 class="mt-1 mb-0 marketplace"><span>Marketplace</span>: from ¥7200 &#126;</h6>
            <div class="list-auction price"><b>N/A</b></div>
        </div>
    `;
}

describe('Suruga-ya scraper', () => {
    let mock;

    beforeEach(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        mock.restore();
    });

    test('extracts prices from Japanese other-shop labels without using the offer count', () => {
        expect(surugaya._extractSurugayaPrice('他のショップ (1) 7,200円 ～')).toBe('¥7,200');
    });

    test('parses Neokyo marketplace-only Suruga prices', () => {
        const $ = cheerio.load(neokyoMarketplaceHtml());
        const results = surugaya._parseResults($);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(expect.objectContaining({
            link: 'https://www.suruga-ya.jp/product/detail/602112502',
            price: '¥7,200',
            source: 'Suruga-ya'
        }));
    });

    test('hydrates Doorzo N/A Suruga prices from Neokyo marketplace search data', async () => {
        mock.onGet(/https:\/\/neokyo\.com\/en\/search\/surugaya.*/).reply(200, neokyoMarketplaceHtml());

        const results = await surugaya._hydrateMissingSurugayaPrices([
            {
                title: '東方うたうチルノちゃん 「東方Project」 1/8 ガレージキット',
                link: 'https://www.suruga-ya.jp/product/detail/602112502',
                image: 'https://cdn.suruga-ya.jp/pics_webp/boxart_m/602112502m.jpg.webp',
                price: 'N/A',
                source: 'Suruga-ya'
            }
        ]);

        expect(results[0].price).toBe('¥7,200');
        expect(mock.history.get).toHaveLength(1);
    });
});
