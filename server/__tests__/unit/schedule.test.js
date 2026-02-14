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
    });

    describe('setEnabledHours', () => {
        test('sets and retrieves enabled hours', () => {
            ScheduleSettings.setEnabledHours([0, 6, 12, 18]);
            const settings = ScheduleSettings.get();
            expect(settings.enabledHours).toEqual([0, 6, 12, 18]);
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
    });
});
