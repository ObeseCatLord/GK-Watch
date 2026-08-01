const mandarake = require('../../scrapers/mandarake');

describe('Mandarake scraper helpers', () => {
    beforeEach(() => {
        mandarake._resetCacheForTests();
    });

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
              <tr>
                <th>商品情報</th>
                <td>在庫確認します 王者の剣 レジンキャストキット キラキラ☆プリキュアアラモード 原型 アルス</td>
              </tr>
              <tr class="category_path">
                <th>カテゴリ</th>
                <td>TOY &gt; ジャンル別 &gt; ガレージキットTOY &gt; 作品別 &gt; プリキュア</td>
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
        expect(mandarake.parseDetailMetadata(garageKitHtml)).toMatchObject({
            categoryPath: expect.stringContaining('プリキュア'),
            itemInformation: expect.stringContaining('キラキラ☆プリキュアアラモード')
        });
        expect(mandarake.isGarageKitCategory(mandarake.parseDetailCategory(garageKitHtml))).toBe(true);
        expect(mandarake.isGarageKitCategory(mandarake.parseDetailCategory(figureHtml))).toBe(false);
    });

    test('shares the garage-kit catalog cache and matches item information', async () => {
        const listHtml = `
            <div class="entry">
              <div class="thumlarge">
                <div class="block" data-itemidx="1343263609">
                  <div class="pic">
                    <a href="/order/detailPage/item?itemCode=1343263609&amp;ref=list">
                      <img src="/images/precure.jpg" />
                    </a>
                  </div>
                  <div class="basic">
                    <span class="shop">Complex</span>
                    <span class="itemno">cmp-kit (0230251949)</span>
                    <span class="stock">在庫確認します</span>
                  </div>
                  <div class="title"><a>王者の剣 レジンキャストキット 原型 アルス キュアホイップ</a></div>
                  <div class="price">22,000円</div>
                </div>
              </div>
            </div>
        `;
        const detailHtml = `
            <table>
              <tr>
                <th>商品情報</th>
                <td>在庫確認します 王者の剣 レジンキャストキット キラキラ☆プリキュアアラモード 原型 アルス</td>
              </tr>
              <tr class="category_path">
                <th>カテゴリ</th>
                <td>TOY &gt; ジャンル別 &gt; ガレージキットTOY &gt; 作品別 &gt; プリキュア</td>
              </tr>
            </table>
        `;
        const fetchSearchHtml = jest.fn(async () => listHtml);
        const fetchDetailHtml = jest.fn(async () => detailHtml);
        const options = {
            fetchSearchHtml,
            fetchDetailHtml,
            concurrency: 2,
            forceRefresh: true,
            persistCache: false,
            now: 1000
        };

        const [firstCatalog, secondCatalog] = await Promise.all([
            mandarake.getGarageKitCatalog([], options),
            mandarake.getGarageKitCatalog([], options)
        ]);

        expect(fetchSearchHtml).toHaveBeenCalledTimes(1);
        expect(fetchDetailHtml).toHaveBeenCalledTimes(1);
        expect(firstCatalog).toEqual(secondCatalog);
        expect(firstCatalog[0].title).not.toContain('プリキュア');

        const matches = mandarake.findGarageKitCatalogMatches(firstCatalog, 'プリキュア');
        expect(matches).toHaveLength(1);
        expect(mandarake.getItemCode(matches[0])).toBe('1343263609');

        await mandarake.getGarageKitCatalog([], { ...options, forceRefresh: false, now: 1500 });
        expect(fetchSearchHtml).toHaveBeenCalledTimes(1);

        await mandarake.getGarageKitCatalog([], { ...options, now: 2000 });
        expect(fetchSearchHtml).toHaveBeenCalledTimes(2);
        expect(fetchDetailHtml).toHaveBeenCalledTimes(1);

        fetchSearchHtml.mockResolvedValueOnce('<html></html>');
        const staleCatalog = await mandarake.getGarageKitCatalog([], {
            ...options,
            now: 15 * 60 * 1000
        });
        expect(staleCatalog).toEqual(firstCatalog);

        fetchSearchHtml.mockResolvedValueOnce('<html></html>');
        await expect(mandarake.getGarageKitCatalog([], {
            ...options,
            now: 31 * 60 * 1000
        })).rejects.toThrow('returned no items');
    });

    test('does not start a cold catalog refresh for an interactive search', async () => {
        const fetchSearchHtml = jest.fn();

        const catalog = await mandarake.getGarageKitCatalog([], {
            fetchSearchHtml,
            refresh: false
        });

        expect(catalog).toEqual([]);
        expect(fetchSearchHtml).not.toHaveBeenCalled();
    });

    test('passes abort signals to uncached direct detail requests', async () => {
        const controller = new AbortController();
        const fetchDetailHtml = jest.fn((url, cookies, item, signal) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                error.code = 'ABORT_ERR';
                reject(error);
            }, { once: true });
        }));
        const results = [{
            title: 'Test garage kit',
            link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=1343263609'
        }];

        const filtering = mandarake.filterGarageKitResults(results, [], {
            fetchDetailHtml,
            persistCache: false
        }, controller.signal);
        controller.abort();

        await expect(filtering).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchDetailHtml).toHaveBeenCalledWith(
            expect.any(String),
            [],
            results[0],
            controller.signal
        );
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
