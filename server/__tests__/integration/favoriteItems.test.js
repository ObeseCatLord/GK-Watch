/**
 * Integration Tests: FavoriteItems Model
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let FavoriteItems;
let Watchlist;
let db;

beforeAll(() => {
    db = getTestDb();
    FavoriteItems = require('../../models/favorite_items');
    Watchlist = require('../../models/watchlist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    FavoriteItems._resetCache();
});

describe('FavoriteItems', () => {
    test('adds a new favorite item with price metadata', () => {
        const item = FavoriteItems.add(
            'http://example.com/item1',
            'Favorite Item',
            'http://img.com/1.jpg',
            '¥1,000',
            'Mercari',
            '',
            ''
        );

        expect(item).toBeDefined();
        expect(item.id).toBeDefined();
        expect(item.url).toBe('http://example.com/item1');
        expect(item.price).toBe('¥1,000');
        expect(item.source).toBe('Mercari');
        expect(item.favoritedAt).toBeDefined();
    });

    test('toggle adds and removes by URL', () => {
        const first = FavoriteItems.toggle({
            link: 'http://example.com/toggle',
            title: 'Toggle Item',
            price: '¥2,000'
        });

        expect(first.favorite).toBe(true);
        expect(FavoriteItems.isFavorite('http://example.com/toggle')).toBe(true);

        const second = FavoriteItems.toggle({ link: 'http://example.com/toggle' });
        expect(second.favorite).toBe(false);
        expect(FavoriteItems.isFavorite('http://example.com/toggle')).toBe(false);
    });

    test('annotates matching result URLs as favorites', () => {
        FavoriteItems.add('http://example.com/favorite', 'Favorite');

        const results = FavoriteItems.annotateResults([
            { link: 'http://example.com/favorite', title: 'Favorite' },
            { link: 'http://example.com/other', title: 'Other' }
        ]);

        expect(results[0].isFavorite).toBe(true);
        expect(results[1].isFavorite).toBe(false);
    });

    test('detects price updates and refreshes saved price snapshots', () => {
        FavoriteItems.add('http://example.com/price', 'Price Item', '', '¥1,000', 'Mercari');
        const favorite = FavoriteItems.getByUrlMap().get('http://example.com/price');

        const update = FavoriteItems.getPriceUpdateForResult({
            link: 'http://example.com/price',
            title: 'Price Item',
            price: '¥1,500',
            source: 'Mercari'
        }, favorite);

        expect(update).toBeDefined();
        expect(update.oldPrice).toBe('¥1,000');
        expect(update.newPrice).toBe('¥1,500');

        FavoriteItems.updateSnapshotFromResult(update);
        const refreshed = FavoriteItems.getByUrlMap().get('http://example.com/price');
        expect(refreshed.price).toBe('¥1,500');
    });

    test('clears favorites missing from visible stored results', async () => {
        const watch = await Watchlist.add({ term: 'cleanup-test', strict: false });
        const now = new Date().toISOString();

        FavoriteItems.add('http://example.com/visible', 'Visible Item');
        FavoriteItems.add('http://example.com/hidden', 'Hidden Item');
        FavoriteItems.add('http://example.com/missing', 'Missing Item');

        const insertResult = db.prepare(`
            INSERT INTO results (watch_id, title, link, first_seen, last_seen, hidden)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertResult.run(watch.id, 'Visible Item', 'http://example.com/visible', now, now, 0);
        insertResult.run(watch.id, 'Hidden Item', 'http://example.com/hidden', now, now, 1);

        const removed = FavoriteItems.clearMissingFromResults();
        const remainingUrls = FavoriteItems.getAll().map(item => item.url);

        expect(removed).toBe(2);
        expect(remainingUrls).toEqual(['http://example.com/visible']);
    });
});
