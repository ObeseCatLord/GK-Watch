/**
 * Integration Tests: Blacklist Model
 * 
 * Tests the Blacklist model against an isolated test database.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let Blacklist;

beforeAll(() => {
    getTestDb();
    Blacklist = require('../../models/blacklist');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    // Reset the internal cache
    Blacklist._resetCache();
});

describe('Blacklist', () => {
    describe('getAll', () => {
        test('returns empty array when no items exist', () => {
            const list = Blacklist.getAll();
            expect(Array.isArray(list)).toBe(true);
            expect(list).toHaveLength(0);
        });
    });

    describe('add', () => {
        test('adds a new blacklist term', () => {
            const item = Blacklist.add('ジャンク');
            expect(item).toBeDefined();
            expect(item.id).toBeDefined();
            expect(item.term).toBe('ジャンク');
            expect(item.addedAt).toBeDefined();
        });

        test('trims whitespace', () => {
            const item = Blacklist.add('  spaced term  ');
            expect(item.term).toBe('spaced term');
        });

        test('returns null for empty/whitespace-only term', () => {
            expect(Blacklist.add('')).toBeNull();
            expect(Blacklist.add('   ')).toBeNull();
        });

        test('prevents duplicate terms (case-insensitive)', () => {
            Blacklist.add('Duplicate');
            const dup = Blacklist.add('duplicate');
            expect(dup).toBeNull();
        });

        test('added term appears in getAll', () => {
            Blacklist.add('test term');
            const list = Blacklist.getAll();
            expect(list).toHaveLength(1);
            expect(list[0].term).toBe('test term');
        });
    });

    describe('remove', () => {
        test('removes a term by ID', () => {
            const item = Blacklist.add('removable');
            Blacklist.remove(item.id);

            const list = Blacklist.getAll();
            expect(list).toHaveLength(0);
        });
    });

    describe('isBlacklisted', () => {
        test('returns false for null/empty title', () => {
            Blacklist.add('test');
            expect(Blacklist.isBlacklisted(null)).toBe(false);
            expect(Blacklist.isBlacklisted('')).toBe(false);
        });

        test('returns true if title contains blacklisted term', () => {
            Blacklist.add('ジャンク');
            expect(Blacklist.isBlacklisted('ジャンク品 ガレージキット')).toBe(true);
        });

        test('returns false if title does not contain any blacklisted term', () => {
            Blacklist.add('ジャンク');
            expect(Blacklist.isBlacklisted('美品 ガレージキット')).toBe(false);
        });

        test('matching is case-insensitive', () => {
            Blacklist.add('junk');
            expect(Blacklist.isBlacklisted('This has JUNK in it')).toBe(true);
        });
    });

    describe('filterResults', () => {
        test('returns empty/null input unchanged', () => {
            expect(Blacklist.filterResults(null)).toBeNull();
            expect(Blacklist.filterResults([])).toEqual([]);
        });

        test('filters out results matching blacklisted terms', () => {
            Blacklist.add('ジャンク');
            const results = [
                { title: 'ジャンク品 フィギュア', link: 'http://a' },
                { title: '美品 ガレージキット', link: 'http://b' },
                { title: 'ジャンク セイバー', link: 'http://c' },
            ];
            const filtered = Blacklist.filterResults(results);
            expect(filtered).toHaveLength(1);
            expect(filtered[0].title).toBe('美品 ガレージキット');
        });

        test('handles results with missing titles', () => {
            Blacklist.add('test');
            const results = [
                { link: 'http://a' }, // no title
                { title: 'safe item', link: 'http://b' },
            ];
            const filtered = Blacklist.filterResults(results);
            expect(filtered).toHaveLength(2);
        });

        test('returns all results when blacklist is empty', () => {
            const results = [
                { title: 'item 1', link: 'http://a' },
                { title: 'item 2', link: 'http://b' },
            ];
            const filtered = Blacklist.filterResults(results);
            expect(filtered).toHaveLength(2);
        });
    });

    describe('replaceAll', () => {
        test('replaces all terms at once', () => {
            Blacklist.add('old1');
            Blacklist.add('old2');

            const results = Blacklist.replaceAll(['new1', 'new2', 'new3']);
            expect(results).toHaveLength(3);


            const list = Blacklist.getAll();
            expect(list).toHaveLength(3);
            const terms = list.map(i => i.term);
            expect(terms).toContain('new1');
            expect(terms).toContain('new2');
            expect(terms).toContain('new3');
            expect(terms).not.toContain('old1');
        });

        test('handles object-format terms', () => {
            const results = Blacklist.replaceAll([{ term: 'foo' }, { term: 'bar' }]);
            expect(results).toHaveLength(2);
        });

        test('skips empty terms', () => {
            const results = Blacklist.replaceAll(['valid', '', '  ', 'also valid']);
            expect(results).toHaveLength(2);
        });
    });
});
