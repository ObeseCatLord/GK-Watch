const request = require('supertest');
const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

jest.mock('../../scrapers', () => ({}));
jest.mock('../../scrapers/yahoo', () => ({ hasValidCookies: () => false }));
jest.mock('../../scheduler', () => ({ start: jest.fn(), isRunning: false }));

let app;
let ScheduleSettings;
let Settings;

beforeAll(() => {
    getTestDb();
    app = require('../../server');
    ScheduleSettings = require('../../models/schedule');
    Settings = require('../../models/settings');
});

beforeEach(() => {
    clearTestDb();
    ScheduleSettings._resetCache();
    Settings._resetCache();
});

afterAll(() => closeTestDb());

test.each([15, 20])('saves and reloads %i-minute schedules and reports the next run', async interval => {
    const response = await request(app).post('/api/schedule').send({
        intervalMinutes: interval,
        enabledSlots: [interval, 60 + interval]
    });
    expect(response.status).toBe(200);
    expect(response.body.intervalMinutes).toBe(interval);
    ScheduleSettings._resetCache();

    const saved = await request(app).get('/api/schedule');
    expect(saved.status).toBe(200);
    expect(saved.body.enabledSlots).toEqual([interval, 60 + interval]);
    expect(saved.body.slotsWithCst[0].jst).toBe(`0:${interval}`);

    jest.useFakeTimers({ now: new Date('2026-01-01T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
        const status = await request(app).get('/api/status');
        expect(status.status).toBe(200);
        expect(status.body.nextScheduled).toBe(`0:${interval} JST`);
        expect(status.body.minutesUntilNext).toBe(interval);
    } finally {
        jest.useRealTimers();
    }
});

test('rejects unsupported schedule intervals', async () => {
    const response = await request(app).post('/api/schedule').send({ intervalMinutes: 10, enabledSlots: [0] });
    expect(response.status).toBe(400);
});
