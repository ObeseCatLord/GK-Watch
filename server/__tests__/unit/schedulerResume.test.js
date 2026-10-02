jest.mock('../../scrapers', () => ({
    reset: jest.fn(),
    searchAll: jest.fn()
}));

const fs = require('fs');
const Watchlist = require('../../models/watchlist');
const searchAggregator = require('../../scrapers');
const cron = require('node-cron');
const { getTestDb, closeTestDb } = require('../testSetup');

describe('scheduler resume state', () => {
    let Scheduler;
    let ScheduleSettings;
    let Cleanup;

    beforeAll(() => {
        getTestDb();
        Scheduler = require('../../scheduler');
        ScheduleSettings = require('../../models/schedule');
        Cleanup = require('../../utils/cleanup');
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

    test.each([15, 20, 40, 45])('runs an enabled JST slot at minute %i', async minute => {
        // Capture the actual cron registration without starting background jobs.
        const schedule = jest.spyOn(cron, 'schedule').mockImplementation(() => ({}));
        jest.spyOn(Scheduler, 'resume').mockResolvedValue();
        jest.spyOn(Cleanup, 'runFullCleanup').mockReturnValue({});
        jest.spyOn(Watchlist, 'getAll').mockResolvedValue([{ id: 'active-watch', active: true }, { id: 'disabled-watch', active: false }]);
        const runBatch = jest.spyOn(Scheduler, 'runBatch').mockResolvedValue();
        ScheduleSettings._resetCache();
        ScheduleSettings.setSchedule({ intervalMinutes: minute % 20 === 0 ? 20 : 15, enabledSlots: [minute] });

        Scheduler.start();
        const [expression, tick] = schedule.mock.calls[0];
        expect(expression.split(' ')[0].split(',').map(Number)).toContain(minute);
        jest.useFakeTimers({ now: new Date(Date.UTC(2026, 0, 1, 15, minute)) });
        try {
            await tick();
            expect(runBatch).toHaveBeenCalledWith([{ id: 'active-watch', active: true }], 'scheduled');
            runBatch.mockClear();
            jest.setSystemTime(new Date(Date.UTC(2026, 0, 1, 15, minute + 1)));
            await tick();
            expect(runBatch).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
