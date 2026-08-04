/**
 * Integration Tests: BlockedItems Model
 * 
 * Tests the BlockedItems model against an isolated test database.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let BlockedItems;
let Watchlist;
let db;

beforeAll(() => {
    db = getTestDb();
    BlockedItems = require('../../models/blocked_items');
    Watchlist = require('../../models/watchlist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    // Reset the internal cache
    BlockedItems._resetCache();
});

describe('BlockedItems', () => {
    describe('getAll', () => {
        test('returns empty array when no items exist', () => {
            const list = BlockedItems.getAll();
            expect(Array.isArray(list)).toBe(true);
            expect(list).toHaveLength(0);
        });
    });

    describe('add', () => {
        test('adds a new blocked item', () => {
            const item = BlockedItems.add('http://example.com/item1', 'Blocked Item', 'http://img.com/1.jpg');
            expect(item).toBeDefined();
            expect(item.id).toBeDefined();
            expect(item.url).toBe('http://example.com/item1');
            expect(item.title).toBe('Blocked Item');
            expect(item.image).toBe('http://img.com/1.jpg');
            expect(item.blockedAt).toBeDefined();
        });

        test('returns null for null/empty URL', () => {
            expect(BlockedItems.add(null)).toBeNull();
            expect(BlockedItems.add('')).toBeNull();
        });

        test('prevents duplicate URLs', () => {
            BlockedItems.add('http://example.com/dup');
            const dup = BlockedItems.add('http://example.com/dup');
            expect(dup).toBeNull();
        });

        test('defaults title and image to empty string', () => {
            const item = BlockedItems.add('http://example.com/minimal');
            expect(item.title).toBe('');
            expect(item.image).toBe('');
        });
    });

    describe('remove', () => {
        test('removes a blocked item by ID', () => {
            const item = BlockedItems.add('http://example.com/removable');
            BlockedItems.remove(item.id);

            const list = BlockedItems.getAll();
            expect(list).toHaveLength(0);
        });

        test('retains live-only, visible, and hidden blocked items without confirmed absence', async () => {
            const watch = await Watchlist.add({ term: 'blocked-cleanup', strict: false });
            const now = new Date().toISOString();

            BlockedItems.add('http://example.com/visible', 'Visible Item');
            BlockedItems.add('http://example.com/hidden', 'Hidden Item');
            BlockedItems.add('http://example.com/missing', 'Missing Item');

            const insertResult = db.prepare(`
                INSERT INTO results (watch_id, title, link, first_seen, last_seen, hidden)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            insertResult.run(watch.id, 'Visible Item', 'http://example.com/visible', now, now, 0);
            insertResult.run(watch.id, 'Hidden Item', 'http://example.com/hidden', now, now, 1);

            const removed = BlockedItems.clearMissingFromResults();
            const remainingUrls = BlockedItems.getAll().map(item => item.url).sort();

            expect(removed).toBe(0);
            expect(remainingUrls).toEqual([
                'http://example.com/hidden',
                'http://example.com/missing',
                'http://example.com/visible'
            ]);
        });

        test('clears only a blocked item with confirmed absence and no stored observation', () => {
            const item = BlockedItems.add('http://example.com/confirmed-missing', 'Missing Item');

            expect(BlockedItems.confirmMissing(item.url)).toBe(true);
            expect(BlockedItems.clearMissingFromResults()).toBe(1);
            expect(BlockedItems.isBlocked(item.url)).toBe(false);
        });

        test('a later raw sighting cancels confirmed absence', () => {
            const item = BlockedItems.add('http://example.com/reappeared', 'Reappeared Item');
            BlockedItems.confirmMissing(item.url, '2026-08-01T00:00:00.000Z');

            BlockedItems.recordSeen([{ link: item.url }], '2026-08-02T00:00:00.000Z');

            expect(BlockedItems.clearMissingFromResults()).toBe(0);
            expect(BlockedItems.isBlocked(item.url)).toBe(true);
        });

        test('blocking a stored unread result hides it and refreshes counts', async () => {
            const watch = await Watchlist.add({ term: 'block-counts', strict: false });
            const now = new Date().toISOString();
            db.prepare(`
                INSERT INTO results (watch_id, title, link, first_seen, last_seen, hidden, is_new)
                VALUES (?, ?, ?, ?, ?, 0, 1)
            `).run(watch.id, 'Unread Item', 'http://example.com/unread', now, now);
            db.prepare('INSERT INTO results_meta (watch_id, updated_at, new_count) VALUES (?, ?, 1)').run(watch.id, now);
            db.prepare('UPDATE watchlist SET last_result_count = 1 WHERE id = ?').run(watch.id);

            BlockedItems.add('http://example.com/unread', 'Unread Item');

            expect(db.prepare('SELECT hidden, is_new FROM results WHERE link = ?').get('http://example.com/unread')).toEqual({ hidden: 1, is_new: 0 });
            expect(db.prepare('SELECT new_count FROM results_meta WHERE watch_id = ?').get(watch.id).new_count).toBe(0);
            expect(db.prepare('SELECT last_result_count FROM watchlist WHERE id = ?').get(watch.id).last_result_count).toBe(0);
        });
    });

    describe('isBlocked', () => {
        test('returns false for null/empty URL', () => {
            expect(BlockedItems.isBlocked(null)).toBe(false);
            expect(BlockedItems.isBlocked('')).toBe(false);
        });

        test('returns true for blocked URL', () => {
            BlockedItems.add('http://example.com/blocked');
            expect(BlockedItems.isBlocked('http://example.com/blocked')).toBe(true);
        });

        test('returns false for non-blocked URL', () => {
            BlockedItems.add('http://example.com/blocked');
            expect(BlockedItems.isBlocked('http://example.com/safe')).toBe(false);
        });
    });

    describe('filterResults', () => {
        test('returns empty/null input unchanged', () => {
            expect(BlockedItems.filterResults(null)).toBeNull();
            expect(BlockedItems.filterResults([])).toEqual([]);
        });

        test('filters out results with blocked URLs', () => {
            BlockedItems.add('http://blocked.com/1');
            BlockedItems.add('http://blocked.com/2');

            const results = [
                { link: 'http://blocked.com/1', title: 'Blocked 1' },
                { link: 'http://safe.com/1', title: 'Safe 1' },
                { link: 'http://blocked.com/2', title: 'Blocked 2' },
                { link: 'http://safe.com/2', title: 'Safe 2' },
            ];

            const filtered = BlockedItems.filterResults(results);
            expect(filtered).toHaveLength(2);
            expect(filtered[0].title).toBe('Safe 1');
            expect(filtered[1].title).toBe('Safe 2');
        });

        test('returns all results when no items are blocked', () => {
            const results = [
                { link: 'http://a.com', title: 'A' },
                { link: 'http://b.com', title: 'B' },
            ];
            const filtered = BlockedItems.filterResults(results);
            expect(filtered).toHaveLength(2);
        });

        test('uses link field for matching', () => {
            BlockedItems.add('http://match.com');
            const results = [
                { link: 'http://match.com', title: 'Should be filtered' },
                { link: 'http://other.com', title: 'Should remain' },
            ];
            const filtered = BlockedItems.filterResults(results);
            expect(filtered).toHaveLength(1);
            expect(filtered[0].title).toBe('Should remain');
        });
    });
});
