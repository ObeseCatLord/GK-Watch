jest.mock('axios');
jest.mock('../../scrapers', () => ({ reset: jest.fn(), searchAll: jest.fn() }));
jest.mock('../../scrapers/yahoo', () => ({ search: jest.fn() }));
jest.mock('../../scrapers/doorzo', () => ({ search: jest.fn() }));

const axios = require('axios');
const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

function buildPayPaySearchHtml(items) {
    const nextData = {
        props: {
            initialState: {
                searchState: {
                    search: {
                        result: { items }
                    }
                }
            }
        }
    };

    return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

function buildPayPaySearchHtmlWithDomFallback(items, domItems) {
    const dom = domItems.map(item => `
        <a href="/item/${item.id}">
            <img alt="${item.title}" src="${item.image}">
            <p>${item.price}円</p>
        </a>
    `).join('');

    return buildPayPaySearchHtml(items).replace('</body>', `${dom}</body>`);
}

describe('PayPay SOLD retention', () => {
    let Scheduler;
    let Watchlist;
    let db;

    beforeAll(() => {
        db = getTestDb();
        Scheduler = require('../../scheduler');
        Watchlist = require('../../models/watchlist');
    });

    afterAll(() => {
        closeTestDb();
    });

    beforeEach(() => {
        clearTestDb();
        jest.clearAllMocks();
    });

    test('scraper drops Yahoo Flea Market SOLD items older than 24 hours', async () => {
        const paypay = require('../../scrapers/paypay');
        const now = Date.now();

        axios.get.mockResolvedValue({
            data: buildPayPaySearchHtml([
                {
                    id: 'z-old-sold',
                    title: 'Old sold garage kit',
                    price: 17000,
                    itemStatus: 'SOLD',
                    endTime: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
                    thumbnailImageUrl: 'https://example.test/old.jpg'
                },
                {
                    id: 'z-recent-sold',
                    title: 'Recent sold garage kit',
                    price: 18000,
                    itemStatus: 'SOLD',
                    endTime: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
                    thumbnailImageUrl: 'https://example.test/recent.jpg'
                },
                {
                    id: 'z-open',
                    title: 'Open garage kit',
                    price: 19000,
                    itemStatus: 'OPEN',
                    endTime: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
                    thumbnailImageUrl: 'https://example.test/open.jpg'
                }
            ])
        });

        const results = await paypay.search('garage kit', false, []);
        const links = results.map(result => result.link);

        expect(links).not.toContain('https://paypayfleamarket.yahoo.co.jp/item/z-old-sold');
        expect(links).toContain('https://paypayfleamarket.yahoo.co.jp/item/z-recent-sold');
        expect(links).toContain('https://paypayfleamarket.yahoo.co.jp/item/z-open');
        expect(results.find(result => result.link.endsWith('/z-recent-sold')).isSold).toBe(true);
        expect(results.find(result => result.link.endsWith('/z-open')).endTime).toBe('');
    });

    test('scheduler refuses to persist PayPay SOLD items older than 24 hours', async () => {
        const watch = await Watchlist.add({ term: 'garage kit', strict: false });
        const oldSoldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

        const result = Scheduler.saveResults(watch.id, [
            {
                link: 'https://paypayfleamarket.yahoo.co.jp/item/z-old-sold',
                title: 'Old sold garage kit',
                source: 'PayPay Flea Market',
                price: '¥17,000',
                endTime: oldSoldTime,
                isSold: true
            }
        ], 'garage kit');

        const item = db.prepare('SELECT * FROM results WHERE watch_id = ?').get(watch.id);
        expect(result.totalCount).toBe(0);
        expect(item).toBeUndefined();
    });

    test('scheduler prunes cached PayPay SOLD items once they pass 24 hours', async () => {
        const watch = await Watchlist.add({ term: 'garage kit', strict: false });
        const recentSoldTime = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
        const oldSoldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

        Scheduler.saveResults(watch.id, [
            {
                link: 'https://paypayfleamarket.yahoo.co.jp/item/z-recent-sold',
                title: 'Recent sold garage kit',
                source: 'PayPay Flea Market',
                price: '¥18,000',
                endTime: recentSoldTime,
                isSold: true
            }
        ], 'garage kit');

        let item = db.prepare('SELECT hidden FROM results WHERE watch_id = ?').get(watch.id);
        expect(item).toBeDefined();
        expect(item.hidden).toBe(0);

        db.prepare('UPDATE results SET end_time = ? WHERE watch_id = ?').run(oldSoldTime, watch.id);
        const results = await Scheduler.getResults(watch.id);

        item = db.prepare('SELECT hidden FROM results WHERE watch_id = ?').get(watch.id);
        expect(results.items).toHaveLength(0);
        expect(item).toBeUndefined();
    });

    test('paginated reads exclude expired PayPay items without a pre-page cleanup scan', async () => {
        const watch = await Watchlist.add({ term: 'garage kit', strict: false });
        const oldSoldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

        db.prepare(`
            INSERT INTO results (watch_id, title, link, source, end_time, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            watch.id,
            'Expired sold garage kit',
            'https://paypayfleamarket.yahoo.co.jp/item/z-expired-page',
            'PayPay Flea Market',
            oldSoldTime,
            oldSoldTime,
            oldSoldTime
        );

        const results = await Scheduler.getResults(watch.id, { page: 1, pageSize: 50 });

        expect(results.items).toHaveLength(0);
        expect(results.total).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS count FROM results WHERE watch_id = ?').get(watch.id).count).toBe(1);
    });

    test('scheduler preserves missing PayPay items without sold timestamps for the original 48 hour grace period', async () => {
        const watch = await Watchlist.add({ term: 'garage kit', strict: false });

        Scheduler.saveResults(watch.id, [
            {
                link: 'https://paypayfleamarket.yahoo.co.jp/item/z-open-missing',
                title: 'Open listing missed by one scrape',
                source: 'PayPay Flea Market',
                price: '¥9,500'
            }
        ], 'garage kit');

        const oldLastSeen = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE results SET last_seen = ? WHERE watch_id = ?').run(oldLastSeen, watch.id);

        Scheduler.saveResults(watch.id, [], 'garage kit');

        const item = db.prepare('SELECT hidden FROM results WHERE watch_id = ?').get(watch.id);
        expect(item).toBeDefined();
        expect(item.hidden).toBe(1);
    });

    test('scraper falls back to DOM parsing when structured PayPay items cannot be mapped', async () => {
        const paypay = require('../../scrapers/paypay');

        axios.get.mockResolvedValue({
            data: buildPayPaySearchHtmlWithDomFallback(
                [{ unexpectedId: 'z-unmapped', unexpectedName: 'Unmapped structured item' }],
                [{
                    id: 'z-dom-fallback',
                    title: 'DOM fallback garage kit',
                    image: 'https://example.test/dom.jpg',
                    price: '9500'
                }]
            )
        });

        const results = await paypay.search('garage kit', false, []);
        expect(results.map(result => result.link)).toContain('https://paypayfleamarket.yahoo.co.jp/item/z-dom-fallback');
    });
});
