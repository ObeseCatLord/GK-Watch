jest.mock('axios');
jest.mock('../../scrapers', () => ({ reset: jest.fn(), searchAll: jest.fn() }));
jest.mock('../../scrapers/yahoo', () => ({ search: jest.fn() }));
jest.mock('../../scrapers/doorzo', () => ({ search: jest.fn() }));

const axios = require('axios');
const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

const doorzo = require('../../scrapers/doorzo');

function buildSearchPage(items, total = items.length, nextPage) {
    const cards = items.map(item => {
        const url = encodeURIComponent(`https://paypayfleamarket.yahoo.co.jp/item/${item.id}`);
        return `<div class="product-item">
            <img src="https://example.test/${item.id}.jpg">
            <h6 class="product-title"><a href="/en/shoppings/detail?shopping_url=${url}">${item.title}</a></h6>
            <span class="cur-price-main"><span class="num">${item.price || '9,500'}</span> JPY</span>
        </div>`;
    }).join('');
    const next = nextPage ? `<a href="?keyword=garage+kit&amp;page=${nextPage}">Next</a>` : '';
    return { data: `<div class="showing">We could find ${total} results for garage kit</div>
        ${cards}<div class="shop-pagination">${next}</div>` };
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

    test('Doorzo fallback retains recently sold items for 24 hours', async () => {
        const paypay = require('../../scrapers/paypay');
        const now = Date.now();

        axios.get.mockRejectedValueOnce(new Error('Request timed out'));
        doorzo.search.mockResolvedValueOnce([
            { title: 'Old sold garage kit', link: 'old', isSold: true, endTime: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
            { title: 'Recent sold garage kit', link: 'recent', isSold: true, endTime: new Date(now - 23 * 60 * 60 * 1000).toISOString() },
            { title: 'Open garage kit', link: 'open', isSold: false, endTime: '' }
        ]);

        const results = await paypay.search('garage kit');
        expect(doorzo.search).toHaveBeenCalledWith('garage kit', 'paypay', null);
        expect(results.map(result => result.link)).toEqual(['recent', 'open']);
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

    test('J-Subculture follows pagination and deduplicates before filtering', async () => {
        const paypay = require('../../scrapers/paypay');
        const item = { id: 'z123', title: 'Garage kit &amp; base' };
        axios.get.mockResolvedValueOnce(buildSearchPage([
            item,
            { id: 'z124', title: 'Blocked garage kit' }
        ], 4, 2)).mockResolvedValueOnce(buildSearchPage([
            item,
            { id: 'z125', title: 'Garage kit with box' },
            { id: 'z126', title: 'Unrelated figure' }
        ], 4));

        const results = await paypay.search('garage kit', true, ['blocked']);
        expect(results).toEqual([
            { title: 'Garage kit & base', link: 'https://paypayfleamarket.yahoo.co.jp/item/z123', price: '¥9,500', image: 'https://example.test/z123.jpg' },
            { title: 'Garage kit with box', link: 'https://paypayfleamarket.yahoo.co.jp/item/z125', price: '¥9,500', image: 'https://example.test/z125.jpg' }
        ]);
        expect(new URL(axios.get.mock.calls[1][0]).searchParams.get('page')).toBe('2');
        expect(doorzo.search).not.toHaveBeenCalled();
    });

    test('a malformed second page preserves J-Subculture results and fills in from Doorzo', async () => {
        const paypay = require('../../scrapers/paypay');
        const primaryLink = 'https://paypayfleamarket.yahoo.co.jp/item/z123';
        const fallback = { title: 'Doorzo garage kit', link: 'https://paypayfleamarket.yahoo.co.jp/item/z124' };
        axios.get.mockResolvedValueOnce(buildSearchPage([{ id: 'z123', title: 'J-Subculture garage kit' }], 2, 2))
            .mockResolvedValueOnce({ data: '<html>Service unavailable</html>' });
        doorzo.search.mockResolvedValueOnce([{ title: 'Duplicate garage kit', link: primaryLink }, fallback]);

        const results = await paypay.search('garage kit');
        expect(results.map(item => item.title)).toEqual(['J-Subculture garage kit', 'Doorzo garage kit']);
    });

    test('a genuine empty J-Subculture search falls back to Doorzo', async () => {
        const paypay = require('../../scrapers/paypay');
        axios.get.mockResolvedValueOnce(buildSearchPage([]));
        doorzo.search.mockResolvedValueOnce([]);
        expect(await paypay.search('garage kit')).toEqual([]);
        expect(doorzo.search).toHaveBeenCalledTimes(1);
    });

    test('a provider error remains distinguishable from an empty search', async () => {
        const paypay = require('../../scrapers/paypay');
        axios.get.mockResolvedValueOnce({ data: '<html>Service unavailable</html>' });
        doorzo.search.mockResolvedValueOnce(null);
        expect(await paypay.search('garage kit')).toBeNull();
    });

    test('an aborted J-Subculture search never starts Doorzo', async () => {
        const paypay = require('../../scrapers/paypay');
        const controller = new AbortController();
        axios.get.mockImplementationOnce(async () => {
            controller.abort();
            return buildSearchPage([]);
        });
        await expect(paypay.search('garage kit', true, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(doorzo.search).not.toHaveBeenCalled();
    });
});
