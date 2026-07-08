/**
 * Unit Tests: ScheduleSettings (jstToCst conversion + basic CRUD)
 * 
 * Tests the time-zone conversion and scheduling logic.
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let ScheduleSettings;

beforeAll(() => {
    getTestDb();
    ScheduleSettings = require('../../models/schedule');
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    // Reset the internal cache
    ScheduleSettings._resetCache();
});

describe('ScheduleSettings', () => {
    describe('jstToCst', () => {
        test('converts JST 0:00 to CST 9:00 (previous day)', () => {
            expect(ScheduleSettings.jstToCst(0)).toBe(9);
        });

        test('converts JST 15:00 to CST 0:00', () => {
            expect(ScheduleSettings.jstToCst(15)).toBe(0);
        });

        test('converts JST 23:00 to CST 8:00', () => {
            expect(ScheduleSettings.jstToCst(23)).toBe(8);
        });

        test('converts JST 14:00 to CST 23:00 (previous day)', () => {
            expect(ScheduleSettings.jstToCst(14)).toBe(23);
        });

        test('converts JST 9:00 to CST 18:00 (previous day)', () => {
            expect(ScheduleSettings.jstToCst(9)).toBe(18);
        });
    });

    describe('get', () => {
        test('returns default timezone', () => {
            const settings = ScheduleSettings.get();
            expect(settings.timezone).toBe('JST');
        });

        test('returns enabledHours as array', () => {
            const settings = ScheduleSettings.get();
            expect(Array.isArray(settings.enabledHours)).toBe(true);
        });

        test('returns enabledSlots and interval defaults', () => {
            const settings = ScheduleSettings.get();
            expect(Array.isArray(settings.enabledSlots)).toBe(true);
            expect(Array.isArray(settings.disabledHalfHourSlots)).toBe(true);
            expect(settings.intervalMinutes).toBe(60);
        });
    });

    describe('setEnabledHours', () => {
        test('sets and retrieves enabled hours', () => {
            ScheduleSettings.setEnabledHours([0, 6, 12, 18]);
            const settings = ScheduleSettings.get();
            expect(settings.enabledHours).toEqual([0, 6, 12, 18]);
            expect(settings.enabledSlots).toEqual([0, 360, 720, 1080]);
            expect(settings.intervalMinutes).toBe(60);
        });

        test('overwrites previous hours', () => {
            ScheduleSettings.setEnabledHours([1, 2, 3]);
            ScheduleSettings.setEnabledHours([10, 20]);
            const settings = ScheduleSettings.get();
            expect(settings.enabledHours).toEqual([10, 20]);
        });

        test('can set to empty array', () => {
            ScheduleSettings.setEnabledHours([1, 2, 3]);
            ScheduleSettings.setEnabledHours([]);
            const settings = ScheduleSettings.get();
            expect(settings.enabledHours).toEqual([]);
        });
    });

    describe('isScheduledNow', () => {
        test('returns false when enabledHours is empty', () => {
            ScheduleSettings.setEnabledHours([]);
            expect(ScheduleSettings.isScheduledNow()).toBe(false);
        });

        test('matches hourly schedules only on the hour', () => {
            ScheduleSettings.setEnabledHours([0]);

            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:00:00.000Z'))).toBe(true);
            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:30:00.000Z'))).toBe(false);
        });

        test('matches half-hour slots when interval is 30 minutes', () => {
            ScheduleSettings.setSchedule({
                intervalMinutes: 30,
                enabledSlots: [0, 30, 90]
            });

            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:00:00.000Z'))).toBe(true);
            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:30:00.000Z'))).toBe(true);
            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T16:30:00.000Z'))).toBe(true);
            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:15:00.000Z'))).toBe(false);
        });
    });

    describe('setSchedule', () => {
        test('normalizes half-hour slots and keeps whole-hour compatibility', () => {
            ScheduleSettings.setSchedule({
                intervalMinutes: 30,
                enabledSlots: [30, 0, 30, 60, 75, 1440, -30],
                disabledHalfHourSlots: [30, 60, 90, 75]
            });

            const settings = ScheduleSettings.get();
            expect(settings.intervalMinutes).toBe(30);
            expect(settings.enabledSlots).toEqual([0, 30, 60]);
            expect(settings.disabledHalfHourSlots).toEqual([30, 90]);
            expect(settings.enabledHours).toEqual([0, 1]);
        });

        test('switching back to hourly preserves half-hour slot preferences', () => {
            ScheduleSettings.setSchedule({
                intervalMinutes: 30,
                enabledSlots: [0, 30, 60],
                disabledHalfHourSlots: [90]
            });
            ScheduleSettings.setSchedule({
                intervalMinutes: 60,
                enabledSlots: ScheduleSettings.get().enabledSlots,
                disabledHalfHourSlots: ScheduleSettings.get().disabledHalfHourSlots
            });

            const settings = ScheduleSettings.get();
            expect(settings.intervalMinutes).toBe(60);
            expect(settings.enabledSlots).toEqual([0, 30, 60]);
            expect(settings.disabledHalfHourSlots).toEqual([90]);
            expect(settings.enabledHours).toEqual([0, 1]);
            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:30:00.000Z'))).toBe(false);

            ScheduleSettings.setSchedule({
                intervalMinutes: 30,
                enabledSlots: ScheduleSettings.get().enabledSlots,
                disabledHalfHourSlots: ScheduleSettings.get().disabledHalfHourSlots
            });

            expect(ScheduleSettings.isScheduledNow(new Date('2026-01-01T15:30:00.000Z'))).toBe(true);
        });
    });
});
