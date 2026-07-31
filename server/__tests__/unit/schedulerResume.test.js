jest.mock('../../scrapers', () => ({
    reset: jest.fn(),
    searchAll: jest.fn()
}));

const fs = require('fs');
const Watchlist = require('../../models/watchlist');
const searchAggregator = require('../../scrapers');
const { getTestDb, closeTestDb } = require('../testSetup');

describe('scheduler resume state', () => {
    let Scheduler;

    beforeAll(() => {
        getTestDb();
        Scheduler = require('../../scheduler');
    });

    afterAll(() => {
        closeTestDb();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        Scheduler.isRunning = false;
        Scheduler.progress = null;
        Scheduler.shouldAbort = false;
    });

    test('resumes from the saved item and skips watches deleted while offline', async () => {
        const savedState = {
            type: 'scheduled',
            currentIndex: 1,
            items: ['watch-a', 'watch-deleted', 'watch-c'],
            timestamp: Date.now()
        };
        const watchA = { id: 'watch-a', term: 'a' };
        const watchC = { id: 'watch-c', term: 'c' };

        jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 128 });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(savedState));
        jest.spyOn(Watchlist, 'getAll').mockResolvedValue([watchA, watchC]);
        const runBatch = jest.spyOn(Scheduler, 'runBatch').mockResolvedValue();

        await Scheduler.resume();

        expect(searchAggregator.reset).toHaveBeenCalledTimes(1);
        expect(runBatch).toHaveBeenCalledWith([watchC], 'scheduled', 0);
    });

    test('increments completionVersion once for an empty successful batch', async () => {
        jest.spyOn(fs, 'lstatSync').mockImplementation(() => {
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
        });
        const previousVersion = Scheduler.completionVersion;

        await Scheduler.runBatch([], 'manual');

        expect(Scheduler.completionVersion).toBe(previousVersion + 1);
        expect(Scheduler.isRunning).toBe(false);
        expect(Scheduler.progress).toBeNull();
    });
});
