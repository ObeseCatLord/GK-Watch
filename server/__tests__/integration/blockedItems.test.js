/**
 * Integration Tests: BlockedItems Model
 * 
 * Tests the BlockedItems model against an isolated test database.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let BlockedItems;

beforeAll(() => {
    getTestDb();
    BlockedItems = require('../../models/blocked_items');
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
