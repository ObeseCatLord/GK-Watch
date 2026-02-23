const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

// Mock out dependencies
const mockSearchAggregator = { reset: jest.fn(), searchAll: jest.fn() };
jest.mock('../../scrapers', () => mockSearchAggregator);

let Scheduler;
let Watchlist;
let db;

beforeAll(() => {
    db = getTestDb();
    // Require modules AFTER DB is mocked
    Scheduler = require('../../scheduler');
    Watchlist = require('../../models/watchlist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
});

describe('Scheduler Suruga-ya Hiding', () => {
    test('Suruga-ya items should be hidden when out of stock', async () => {
        const watch = await Watchlist.add({ term: 'test-suruga', strict: false });
        const watchId = watch.id;

        // 1. First run: Item found
        const resultsRun1 = [
            { link: 'https://suruga-ya.jp/product/detail/123', title: 'Test Item', source: 'Suruga-ya', price: '1000' }
        ];

        const saveResult = await Scheduler.saveResults(watchId, resultsRun1, 'test-suruga');

        // Check it exists and is visible
        let item = db.prepare('SELECT hidden FROM results WHERE watch_id = ? AND link = ?').get(watchId, resultsRun1[0].link);
        expect(item).toBeDefined();
        expect(item.hidden).toBe(0);

        // 2. Second run: Item NOT found (out of stock)
        const resultsRun2 = []; // Empty results

        await Scheduler.saveResults(watchId, resultsRun2, 'test-suruga');

        // Check it still exists (grace period) but is HIDDEN
        item = db.prepare('SELECT hidden FROM results WHERE watch_id = ? AND link = ?').get(watchId, resultsRun1[0].link);
        expect(item).toBeDefined(); // Still in DB
        expect(item.hidden).toBe(1); // Hidden! (This is what we fixed)
    });
});
