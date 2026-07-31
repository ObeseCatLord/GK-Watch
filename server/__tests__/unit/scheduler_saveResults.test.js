/**
 * Unit Tests: Scheduler saveResults
 * 
 * Verifies that the new item state and counts are preserved
 * correctly across subsequent runs.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

// Mock out dependencies
const mockSearchAggregator = { reset: jest.fn(), searchAll: jest.fn() };
jest.mock('../../scrapers', () => mockSearchAggregator);

let Scheduler;
let Watchlist;
let FavoriteItems;
let db;

beforeAll(() => {
    db = getTestDb();
    Scheduler = require('../../scheduler');
    Watchlist = require('../../models/watchlist');
    FavoriteItems = require('../../models/favorite_items');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    FavoriteItems._resetCache();
});

describe('Scheduler.saveResults', () => {
    test('preserves isNew flag on repeated runs and accurately counts new items', async () => {
        // Create a watch item
        const watch = await Watchlist.add({ term: 'test', strict: false });

        // Mock some results
        const resultsParamsRun1 = [
            { link: 'link1', title: 'item1', source: 'yahoo', price: '1000' },
            { link: 'link2', title: 'item2', source: 'mercari', price: '2000' }
        ];

        // First run
        const run1 = await Scheduler.saveResults(watch.id, resultsParamsRun1, 'test');
        expect(run1.newItems.length).toBe(2);
        expect(run1.totalCount).toBe(2);

        // Check meta
        const meta1 = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta1.new_count).toBe(2);

        // Second run with the same items plus one more
        const resultsParamsRun2 = [
            { link: 'link1', title: 'item1', source: 'yahoo', price: '1000' },
            { link: 'link2', title: 'item2', source: 'mercari', price: '2000' },
            { link: 'link3', title: 'item3', source: 'surugaya', price: '3000' }
        ];

        const run2 = await Scheduler.saveResults(watch.id, resultsParamsRun2, 'test');
        expect(run2.newItems.length).toBe(1); // Only 1 newly discovered item
        expect(run2.totalCount).toBe(3);

        const meta2 = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta2.new_count).toBe(3); // Should be 3 (2 old unread + 1 new unread)

        // Verify the existing items in DB still have is_new = 1
        const items = db.prepare('SELECT link, is_new FROM results WHERE watch_id = ?').all(watch.id);
        items.forEach(item => {
            expect(item.is_new).toBe(1);
        });

        // Mark explicitly read
        Scheduler.clearNewFlags(watch.id);

        const itemsRead = db.prepare('SELECT link, is_new FROM results WHERE watch_id = ?').all(watch.id);
        itemsRead.forEach(item => {
            expect(item.is_new).toBe(0); // Everything should become 0
        });

        const meta3 = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta3.new_count).toBe(0);

        // Third run
        const run3 = await Scheduler.saveResults(watch.id, resultsParamsRun2, 'test');
        expect(run3.newItems.length).toBe(0);

        const itemsRun3 = db.prepare('SELECT link, is_new FROM results WHERE watch_id = ?').all(watch.id);
        itemsRun3.forEach(item => {
            expect(item.is_new).toBe(0); // Should remain 0
        });

        const meta4 = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta4.new_count).toBe(0);
    });

    test('returns favorite price updates with old and new prices', async () => {
        const watch = await Watchlist.add({ term: 'favorite-price', strict: false });

        FavoriteItems.add(
            'favorite-link',
            'Favorite Price Item',
            '',
            '¥1,000',
            'mercari'
        );

        const run1 = await Scheduler.saveResults(watch.id, [
            { link: 'favorite-link', title: 'Favorite Price Item', source: 'mercari', price: '¥1,500' }
        ], 'favorite-price');

        expect(run1.favoritePriceUpdates).toHaveLength(1);
        expect(run1.favoritePriceUpdates[0].oldPrice).toBe('¥1,000');
        expect(run1.favoritePriceUpdates[0].newPrice).toBe('¥1,500');

        const storedUpdate = db.prepare('SELECT is_new, new_type FROM results WHERE watch_id = ? AND link = ?').get(watch.id, 'favorite-link');
        expect(storedUpdate.is_new).toBe(1);
        expect(storedUpdate.new_type).toBe('updated');

        const apiResults = await Scheduler.getResults(watch.id);
        expect(apiResults.newCount).toBe(1);
        expect(apiResults.items[0].isNew).toBe(true);
        expect(apiResults.items[0].isUpdated).toBe(true);
        expect(apiResults.items[0].newType).toBe('updated');

        const refreshedFavorite = FavoriteItems.getByUrlMap().get('favorite-link');
        expect(refreshedFavorite.price).toBe('¥1,500');

        Scheduler.clearNewFlags(watch.id);

        const run2 = await Scheduler.saveResults(watch.id, [
            { link: 'favorite-link', title: 'Favorite Price Item', source: 'mercari', price: '¥1,500' }
        ], 'favorite-price');

        expect(run2.favoritePriceUpdates).toHaveLength(0);
        const meta = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta.new_count).toBe(0);
    });

    test('skips scraper error and missing-link results before saving', async () => {
        const watch = await Watchlist.add({ term: 'bad-results', strict: false });

        const run = await Scheduler.saveResults(watch.id, [
            { error: 'timeout of 30000ms exceeded', source: 'Mandarake' },
            { title: 'No Link Item', source: 'Mercari', price: '¥1,000' },
            { link: 'valid-link', title: 'Valid Item', source: 'Mandarake', price: '¥2,000' }
        ], 'bad-results');

        expect(run.newItems).toHaveLength(1);
        expect(run.newItems[0].link).toBe('valid-link');
        expect(run.totalCount).toBe(1);

        const rows = db.prepare('SELECT link, title, source FROM results WHERE watch_id = ?').all(watch.id);
        expect(rows).toEqual([
            { link: 'valid-link', title: 'Valid Item', source: 'Mandarake' }
        ]);

        const meta = db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id);
        expect(meta.new_count).toBe(1);
    });

    test('returns server-side paginated, filtered, allowlisted-sort results when requested', async () => {
        const watch = await Watchlist.add({ term: 'paged-results', strict: false });
        await Scheduler.saveResults(watch.id, [
            { link: 'https://example.test/charlie', title: 'Charlie', source: 'Mercari', price: '300' },
            { link: 'https://example.test/alpha', title: 'Alpha', source: 'Mercari', price: '100' },
            { link: 'https://example.test/bravo', title: 'Bravo', source: 'Yahoo', price: '200' }
        ], 'paged-results');

        const paged = await Scheduler.getResults(watch.id, {
            page: 1,
            pageSize: 1,
            source: 'mercari',
            sortBy: 'title',
            sortDirection: 'asc'
        });

        expect(paged.total).toBe(2);
        expect(paged.page).toBe(1);
        expect(paged.pageSize).toBe(1);
        expect(paged.totalPages).toBe(2);
        expect(paged.items.map(item => item.title)).toEqual(['Alpha']);
        expect(paged.sources).toEqual(['Mercari', 'Yahoo']);

        const searched = await Scheduler.getResults(watch.id, {
            page: 1,
            pageSize: 10,
            search: 'bravo',
            sortBy: 'not_a_column; DROP TABLE results',
            sortDirection: 'ascending'
        });
        expect(searched.total).toBe(1);
        expect(searched.items[0].title).toBe('Bravo');
        expect(db.prepare('SELECT COUNT(*) AS count FROM results').get().count).toBe(3);
    });

    test('excludes blocked and blacklisted rows from paginated totals and pages', async () => {
        const watch = await Watchlist.add({ term: 'blocked-page', strict: false });
        await Scheduler.saveResults(watch.id, [
            { link: 'https://example.test/alpha', title: 'Alpha', source: 'Mercari', price: '100' },
            { link: 'https://example.test/bravo', title: 'Bravo Recast', source: 'Yahoo', price: '200' },
            { link: 'https://example.test/charlie', title: 'Charlie', source: 'Mercari', price: '300' }
        ], 'blocked-page');
        db.prepare('INSERT INTO blocked_items (id, url, blocked_at) VALUES (?, ?, ?)').run('blocked-1', 'https://example.test/alpha', new Date().toISOString());
        db.prepare('INSERT INTO blacklist (id, term, added_at) VALUES (?, ?, ?)').run('term-1', 'recast', new Date().toISOString());

        const paged = await Scheduler.getResults(watch.id, {
            page: 1,
            pageSize: 10,
            sortBy: 'title',
            sortDirection: 'asc',
            hidden: false
        });

        expect(paged.total).toBe(1);
        expect(paged.totalPages).toBe(1);
        expect(paged.items.map(item => item.title)).toEqual(['Charlie']);
        expect(paged.sources).toEqual(['Mercari']);
    });
});
