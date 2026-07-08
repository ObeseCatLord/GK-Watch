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
        expect(url.searchParams.get('lang')).toBe('ja');
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
                    <span class="stock">在庫あります</span>
                  </div>
                  <div class="title"><a>東方Project 博麗霊夢 ガレージキット</a></div>
                  <div class="price">12,000円</div>
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
            title: '東方Project 博麗霊夢 ガレージキット',
            link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=abc123&ref=list',
            image: 'https://order.mandarake.co.jp/images/item.jpg',
            price: '¥12,000',
            source: 'Mandarake',
            shopName: 'Nakano'
        });
        expect(results[0].itemNo).toEqual(['cmp-foo', '0181099788']);
    });

    test('parses and recognizes garage-kit detail categories', () => {
        const garageKitHtml = `
            <table>
              <tr class="category_path">
                <th>カテゴリ</th>
                <td>TOY &gt; ジャンル別 &gt; ガレージキットTOY &gt; 作品別 &gt; ゲーム</td>
              </tr>
            </table>
        `;
        const figureHtml = `
            <table>
              <tr class="category_path">
                <th>カテゴリ</th>
                <td>TOY &gt; ジャンル別 &gt; 美少女フィギュアTOY &gt; 作品別 &gt; ゲーム</td>
              </tr>
            </table>
        `;

        expect(mandarake.parseDetailCategory(garageKitHtml)).toContain('ガレージキット');
        expect(mandarake.isGarageKitCategory(mandarake.parseDetailCategory(garageKitHtml))).toBe(true);
        expect(mandarake.isGarageKitCategory(mandarake.parseDetailCategory(figureHtml))).toBe(false);
    });

    test('filters garage-kit mode results by verified detail category', async () => {
        const results = [
            {
                title: 'リキッドストーン カラーレジンキャストキット 東方',
                link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1333360573&ref=list&categoryCode=020107'
            },
            {
                title: 'GRIFFON ENTERPRISES 楽園の巫女 博麗霊夢(赤服) PVC',
                link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1319291778&ref=list&categoryCode=020107'
            },
            {
                title: 'MAXFACTORY figma 東方Project 十六夜咲夜 76',
                link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1338079157&ref=list&categoryCode=020107'
            }
        ];

        const detailFetcher = jest.fn(async (detailUrl) => {
            const itemCode = mandarake.getItemCode(detailUrl);
            if (itemCode === '1333360573') {
                return `
                    <table>
                      <tr class="category_path">
                        <th>カテゴリ</th>
                        <td>TOY &gt; ジャンル別 &gt; ガレージキットTOY &gt; 作品別 &gt; ゲーム</td>
                      </tr>
                    </table>
                `;
            }

            if (itemCode === '1319291778') {
                return `
                    <table>
                      <tr class="category_path">
                        <th>カテゴリ</th>
                        <td>TOY &gt; ジャンル別 &gt; 美少女フィギュアTOY &gt; 作品別 &gt; ゲーム &gt; その他</td>
                      </tr>
                    </table>
                `;
            }

            return `
                <table>
                  <tr class="category_path">
                    <th>カテゴリ</th>
                    <td>TOY &gt; ジャンル別 &gt; アクションフィギュア &gt; figmaTOY</td>
                  </tr>
                </table>
            `;
        });

        const filtered = await mandarake.filterGarageKitResults(results, [], {
            fetchDetailHtml: detailFetcher,
            concurrency: 2
        });

        expect(detailFetcher).toHaveBeenCalledTimes(3);
        expect(filtered).toHaveLength(1);
        expect(filtered[0].link).toContain('itemCode=1333360573');
    });
});
