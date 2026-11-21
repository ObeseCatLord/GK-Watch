const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');
const fril = require('../../scrapers/fril');

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
        mock.onGet(primaryUrl).reply(502);
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

    test('uses the native in-stock search after the first two providers fail', async () => {
        mock.onGet(primaryUrl).reply(502);
        mock.onGet(doorzoUrl).reply(502);
        const otherUrl = `https://item.fril.jp/${'b'.repeat(32)}`;
        const card = link => `<div class="item-box">
            <div class="item-box__image-wrapper"><a href="${link}"></a></div>
            <div class="item-box__item-name"><span>Asuka garage kit</span></div>
            <div class="item-box__item-price">¥12,000</div>
        </div>`;
        mock.onGet(nativeUrl).reply(({ url }) => {
            const next = new URL(url).searchParams.get('page') === '2';
            return [200, `<div class="search_tab">${next ? card(otherUrl) : card(itemUrl) +
                '<nav class="pagination"><a href="/s?query=garage+kit&amp;transaction=selling&amp;page=2">2</a></nav>'}</div>`];
        });

        await expect(fril.search('garage kit')).resolves.toEqual([
            expect.objectContaining({ link: itemUrl }),
            expect.objectContaining({ link: otherUrl })
        ]);
        expect(mock.history.get.map(request => request.url)).toEqual([
            expect.stringMatching(primaryUrl), doorzoUrl, expect.stringMatching(nativeUrl), expect.stringMatching(nativeUrl)
        ]);
        expect(new URL(mock.history.get[2].url).searchParams.get('transaction')).toBe('selling');
    });

    test('an explicit empty final page preserves prior listings without retrying other providers', async () => {
        mock.onGet(primaryUrl).replyOnce(200, `
            <div class="showing">We could find 2 results for garage kit</div>
            <div class="product-title"><a href="?shopping_url=${encodeURIComponent(itemUrl)}">Asuka garage kit</a></div>
            <div class="shop-pagination"><a href="?keyword=garage+kit&amp;page=2">2</a></div>`);
        mock.onGet(primaryUrl).replyOnce(200, `
            <div class="showing">We could find 2 results for garage kit</div>
            <div class="no_search_result">No items matched your search.</div>`);
        await expect(fril.search('garage kit')).resolves.toEqual([expect.objectContaining({ link: itemUrl })]);
        expect(mock.history.get).toHaveLength(2);
    });

    test('a completed empty search skips fallbacks', async () => {
        mock.onGet(primaryUrl).reply(200, '<div class="showing">We could find 0 results for garage kit</div>');
        await expect(fril.search('garage kit')).resolves.toEqual([]);
        expect(mock.history.get).toHaveLength(1);
    });

    test('preserves the initial page when J-Subculture repeats it', async () => {
        const html = `<div class="showing">We could find 2 results for garage kit</div>
            <div class="product-title"><a href="?shopping_url=${encodeURIComponent(itemUrl)}">Asuka garage kit</a></div>
            <div class="shop-pagination"><a href="?keyword=garage+kit&amp;page=2">2</a></div>`;
        const secondId = 'c'.repeat(32);
        mock.onGet(primaryUrl).reply(200, html);
        mock.onGet(doorzoUrl).reply(200, {
            code: 0,
            data: { items: [{ Asin: itemId, Name: 'Asuka garage kit' }, { Asin: secondId, Name: 'Another garage kit' }] }
        });
        const results = await fril.search('garage kit');
        expect(results.map(item => item.link)).toEqual([itemUrl, `https://item.fril.jp/${secondId}`]);
        expect(mock.history.get).toHaveLength(3);
    });

    test('returns a provider failure when native Rakuma serves a challenge page', async () => {
        mock.onGet(primaryUrl).reply(502);
        mock.onGet(doorzoUrl).reply(502);
        mock.onGet(nativeUrl).reply(200, '<html>challenge page</html>');
        await expect(fril.search('garage kit')).resolves.toBeNull();
    });
});
