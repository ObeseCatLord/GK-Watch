/**
 * Integration Tests: Watchlist Model
 * 
 * Tests the Watchlist model against an isolated test database.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let Watchlist;

beforeAll(() => {
    getTestDb();
    Watchlist = require('../../models/watchlist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
});

describe('Watchlist', () => {
    describe('getAll', () => {
        test('returns empty array when no items exist', async () => {
            const list = await Watchlist.getAll();
            expect(Array.isArray(list)).toBe(true);
            expect(list).toHaveLength(0);
        });
    });

    describe('add', () => {
        test('adds a new watchlist item', async () => {
            const item = await Watchlist.add({ term: '東方 ガレージキット' });
            expect(item).toBeDefined();
            expect(item.id).toBeDefined();
            expect(item.terms).toContain('東方 ガレージキット');
        });

        test('generates a unique ID', async () => {
            const item1 = await Watchlist.add({ term: 'term_unique_1' });
            // Small delay to ensure different timestamp IDs
            await new Promise(r => setTimeout(r, 5));
            const item2 = await Watchlist.add({ term: 'term_unique_2' });
            expect(item1.id).not.toBe(item2.id);
        });

        test('sets default values correctly', async () => {
            const item = await Watchlist.add({ term: 'test_defaults' });
            expect(item.active).toBe(true);
            expect(item.emailNotify).toBe(true); // Watchlist defaults emailNotify to true
            expect(item.priority).toBe(false);
        });

        test('returns existing item for duplicate terms', async () => {
            const original = await Watchlist.add({ term: 'duplicate_test_item' });
            const duplicate = await Watchlist.add({ term: 'duplicate_test_item' });
            // Watchlist.add returns the existing item (not null) for duplicates
            expect(duplicate).toBeDefined();
            expect(duplicate.id).toBe(original.id);
        });

        test('uses custom name if provided', async () => {
            const item = await Watchlist.add({ term: 'my_search_custom', name: 'Custom Name' });
            expect(item.name).toBe('Custom Name');
        });
    });

    describe('get', () => {
        test('retrieves a single item by ID', async () => {
            const added = await Watchlist.add({ term: 'test_get_item' });
            const retrieved = await Watchlist.get(added.id);
            expect(retrieved).toBeDefined();
            expect(retrieved.id).toBe(added.id);
        });

        test('returns null for non-existent ID', async () => {
            const result = await Watchlist.get('nonexistent_id_12345');
            expect(result).toBeNull();
        });
    });

    describe('update', () => {
        test('updates item name', async () => {
            const item = await Watchlist.add({ term: 'test_update_name' });
            await Watchlist.update(item.id, { name: 'Updated Name' });
            const updated = await Watchlist.get(item.id);
            expect(updated.name).toBe('Updated Name');
        });

        test('updates active status', async () => {
            const item = await Watchlist.add({ term: 'test_update_active' });
            await Watchlist.update(item.id, { active: false });
            const updated = await Watchlist.get(item.id);
            expect(updated.active).toBe(false);
        });
    });

    describe('remove', () => {
        test('removes an item', async () => {
            const item = await Watchlist.add({ term: 'test_to_remove' });
            await Watchlist.remove(item.id);
            const result = await Watchlist.get(item.id);
            expect(result).toBeNull();
        });

        test('removed item no longer appears in getAll', async () => {
            const item = await Watchlist.add({ term: 'test_remove_getall' });
            await Watchlist.remove(item.id);
            const list = await Watchlist.getAll();
            expect(list.find(i => i.id === item.id)).toBeUndefined();
        });
    });

    describe('toggleActive', () => {
        test('toggles active state off then on', async () => {
            const item = await Watchlist.add({ term: 'test_toggle_active' });
            const newState1 = await Watchlist.toggleActive(item.id);
            expect(newState1).toBe(false);

            const newState2 = await Watchlist.toggleActive(item.id);
            expect(newState2).toBe(true);
        });

        test('returns null for non-existent item', async () => {
            const result = await Watchlist.toggleActive('fake-id-toggle');
            expect(result).toBeNull();
        });
    });

    describe('toggleEmailNotify', () => {
        test('toggles email notification state', async () => {
            const item = await Watchlist.add({ term: 'test_toggle_email' });
            // Default is true, so toggling should make it false
            const newState = await Watchlist.toggleEmailNotify(item.id);
            expect(newState).toBe(false);
        });
    });

    describe('reorder', () => {
        test('reorders items by provided ID list', async () => {
            const item1 = await Watchlist.add({ term: 'reorder_first' });
            await new Promise(r => setTimeout(r, 5));
            const item2 = await Watchlist.add({ term: 'reorder_second' });
            await new Promise(r => setTimeout(r, 5));
            const item3 = await Watchlist.add({ term: 'reorder_third' });

            // Reverse order
            await Watchlist.reorder([item3.id, item2.id, item1.id]);
            const list = await Watchlist.getAll();

            // Find items by ID and check their sort order
            const sortOrders = {};
            list.forEach(i => { sortOrders[i.id] = i.sortOrder; });

            expect(sortOrders[item3.id]).toBeLessThan(sortOrders[item1.id]);
        });
    });

    describe('merge', () => {
        test('merges multiple items into one', async () => {
            const item1 = await Watchlist.add({ term: 'merge_search_one' });
            await new Promise(r => setTimeout(r, 5));
            const item2 = await Watchlist.add({ term: 'merge_search_two' });

            const merged = await Watchlist.merge([item1.id, item2.id], 'Merged Watch');
            expect(merged).toBeDefined();
            expect(merged.name).toBe('Merged Watch');

            // Original items should be removed, merged item should exist
            const remaining = await Watchlist.getAll();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].name).toBe('Merged Watch');
        });
    });

    describe('updateLastRun', () => {
        test('updates last run timestamp', async () => {
            const item = await Watchlist.add({ term: 'test_last_run' });
            await Watchlist.updateLastRun(item.id, 42);
            const updated = await Watchlist.get(item.id);
            expect(updated.lastRun).toBeDefined();
            expect(updated.lastResultCount).toBe(42);
        });
    });
});
