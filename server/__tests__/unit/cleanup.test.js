const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let Cleanup;
let db;

beforeAll(() => {
    db = getTestDb();
    Cleanup = require('../../utils/cleanup');
});

afterAll(() => {
    Cleanup.updateConfig({
        maxLogSizeBytes: 1024 * 1024,
        logLinesToKeep: 1000,
        resultsMaxAgeDays: 3
    });
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    Cleanup.updateConfig({
        maxLogSizeBytes: 1024 * 1024,
        logLinesToKeep: 1000,
        resultsMaxAgeDays: 3
    });
});

describe('Cleanup configuration and preview', () => {
    test('rejects unknown, invalid, and unsafe retention settings', () => {
        expect(() => Cleanup.updateConfig({ resultsMaxAgeDays: -1 })).toThrow(RangeError);
        expect(() => Cleanup.updateConfig({ resultsMaxAgeDays: 0 })).toThrow(RangeError);
        expect(() => Cleanup.updateConfig({ resultsMaxAgeDays: 1.5 })).toThrow(RangeError);
        expect(() => Cleanup.updateConfig({ unknown: 1 })).toThrow('Unknown cleanup configuration key');
    });

    test('reports expired rows during a dry run without deleting them', () => {
        const oldTimestamp = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO watchlist (id, name, terms) VALUES (?, ?, ?)')
            .run('preview-watch', 'Preview watch', '[]');
        db.prepare(`INSERT INTO results (watch_id, title, link, first_seen, last_seen)
                    VALUES (?, ?, ?, ?, ?)`)
            .run('preview-watch', 'Old result', 'https://example.test/old', oldTimestamp, oldTimestamp);

        const preview = Cleanup.cleanupExpiredResults({ dryRun: true });

        expect(preview.wouldRemove).toBe(1);
        expect(preview.itemsRemoved).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS count FROM results').get().count).toBe(1);
    });
});
