/**
 * Unit Tests: Scheduler saveResults
 * 
 * Verifies that the new item state and counts are preserved
 * correctly across subsequent runs.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../../testSetup');

// Mock out dependencies
const mockSearchAggregator = { reset: jest.fn(), searchAll: jest.fn() };
jest.mock('../../../scrapers', () => mockSearchAggregator);

let Scheduler;
let Watchlist;
let db;

beforeAll(() => {
    db = getTestDb();
    Scheduler = require('../../../scheduler');
    Watchlist = require('../../../models/watchlist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
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
});
