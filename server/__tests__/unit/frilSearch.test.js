const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');
const fril = require('../../scrapers/fril');
const dejapan = require('../../scrapers/dejapan');

const primaryUrl = /^https:\/\/www\.j-subculture\.com\/en\/searches\/rakuma-lists/;
const nativeUrl = /^https:\/\/fril\.jp\/s\?/;
const doorzoUrl = 'https://sig.doorzo.com/';
const itemId = 'edd0871f2af74b9d826e09a584994285';
const itemUrl = `https://item.fril.jp/${itemId}`;

describe('Rakuma provider order', () => {
    let mock;

    beforeEach(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        mock.restore();
    });

    test('returns canonical J-Subculture results when the final page has fewer cards than the reported total', async () => {
        mock.onGet(primaryUrl).reply(200, `
            <div class="showing">We could find 2 results for garage kit</div>
            <div class="product-item">
                <h6 class="product-title">
                    <a href="?shopping_url=${encodeURIComponent(itemUrl + '?ref=search')}">Asuka garage kit</a>
                </h6>
                <span class="cur-price-main"><span class="num">9,500</span> JPY</span>
            </div>
            <ul class="shop-pagination"><li><a class="disabled" href="#">1</a></li></ul>`);

        await expect(fril.search('garage kit')).resolves.toEqual([
            expect.objectContaining({ title: 'Asuka garage kit', link: itemUrl, price: '¥9,500' })
        ]);
        expect(mock.history.get).toHaveLength(1);
    });

    test('falls back to Doorzo with the Rakuma selector and skips IDs from other sites', async () => {
        mock.onGet(primaryUrl).reply(200, '<div class="showing">We could find 0 results for garage kit</div>');
        mock.onGet(doorzoUrl).reply(200, {
            code: 0,
            data: { items: [
                { Asin: itemId, Name: 'Asuka garage kit', JPYPrice: 9500 },
                { Url: 'z123', Name: 'Another garage kit', JPYPrice: 8000 }
            ] }
        });

        await expect(fril.search('garage kit')).resolves.toEqual([
            expect.objectContaining({ link: itemUrl })
        ]);
        expect(mock.history.get.map(request => request.url)).toEqual([expect.stringMatching(primaryUrl), doorzoUrl]);
        expect(mock.history.get[1].params.website).toBe('rakuma');
    });

    test('tries native Fril and DEJapan after the first two providers fail', async () => {
        mock.onGet(primaryUrl).reply(502);
        mock.onGet(doorzoUrl).reply(502);
        mock.onGet(nativeUrl).reply(404);
        const fallback = jest.spyOn(dejapan, 'searchRakuma').mockResolvedValueOnce([
            { title: 'Asuka garage kit', link: itemUrl }
        ]);

        await expect(fril.search('garage kit')).resolves.toEqual([
            expect.objectContaining({ link: itemUrl })
        ]);
        expect(mock.history.get.map(request => request.url)).toEqual([
            expect.stringMatching(primaryUrl), doorzoUrl, expect.stringMatching(nativeUrl)
        ]);
        expect(fallback).toHaveBeenCalledWith('garage kit', true, [], null);
    });
});
