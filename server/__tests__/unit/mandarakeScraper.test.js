const mandarake = require('../../scrapers/mandarake');

describe('Mandarake scraper helpers', () => {
    test('builds full-site search URLs by default', () => {
        const url = new URL(mandarake.buildSearchUrl('saber'));

        expect(url.origin + url.pathname).toBe('https://order.mandarake.co.jp/order/listPage/list');
        expect(url.searchParams.get('keyword')).toBe('saber');
        expect(url.searchParams.get('categoryCode')).toBe(mandarake.EVERYTHING_CATEGORY_CODE);
        expect(url.searchParams.get('soldOut')).toBe('1');
        expect(url.searchParams.get('dispAdult')).toBe('0');
        expect(url.searchParams.get('dispCount')).toBe('240');
        expect(url.searchParams.get('lang')).toBe('en');
    });

    test('builds garage-kit category URLs and strips GK suffixes', () => {
        const url = new URL(mandarake.buildSearchUrl('saber ガレージキット', { mode: 'garageKit' }));

        expect(url.searchParams.get('keyword')).toBe('saber');
        expect(url.searchParams.get('categoryCode')).toBe(mandarake.GARAGE_KIT_CATEGORY_CODE);
    });

    test('parses Mandarake result cards', () => {
        const html = `
            <div class="entry">
              <div class="thumlarge">
                <div class="block">
                  <div class="pic">
                    <a href="/order/detailPage/item?itemCode=abc123&ref=list">
                      <img src="/images/item.jpg" />
                    </a>
                  </div>
                  <div class="basic">
                    <span class="shop">Nakano</span>
                    <span class="itemno">cmp-foo (0181099788)</span>
                    <span class="stock">In stock</span>
                  </div>
                  <div class="title"><a>Fate Saber Garage Kit</a></div>
                  <div class="price">12,000 yen</div>
                </div>
                <div class="block">
                  <div class="pic">
                    <a href="/order/detailPage/item?itemCode=sold&ref=list">
                      <img src="/images/sold.jpg" />
                    </a>
                  </div>
                  <div class="basic">
                    <span class="stock">Sold Out</span>
                  </div>
                  <div class="title"><a>Sold Kit</a></div>
                  <div class="price">1,000 yen</div>
                </div>
              </div>
            </div>
        `;

        const results = mandarake.parseResults(html);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            title: 'Fate Saber Garage Kit',
            link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=abc123&ref=list',
            image: 'https://order.mandarake.co.jp/images/item.jpg',
            price: '¥12,000',
            source: 'Mandarake',
            shopName: 'Nakano'
        });
        expect(results[0].itemNo).toEqual(['cmp-foo', '0181099788']);
    });

    test('strict matching supports Mandarake English Touhou titles for Japanese queries', () => {
        expect(mandarake.matchesMandarakeQuery('WSC Touhou Project Reimu Hakurei', '東方', true)).toBe(true);
        expect(mandarake.matchesMandarakeQuery('Modeling Barrier Resin Cast Kit Reimu Hakurei', '東方', true)).toBe(true);
        expect(mandarake.matchesMandarakeQuery('Antique Heart SD Komeiji Satori', '東方', true)).toBe(true);
        expect(mandarake.matchesMandarakeQuery('Unrelated Saber Resin Cast Kit', '東方', true)).toBe(false);
    });
});
