'use strict';

describe('Mercari native production pacing', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalMinTime = process.env.GKWATCH_MERCARI_NATIVE_MIN_TIME_MS;
    const originalDeadline = process.env.GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS;

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env.NODE_ENV = originalNodeEnv;
        if (originalMinTime === undefined) delete process.env.GKWATCH_MERCARI_NATIVE_MIN_TIME_MS;
        else process.env.GKWATCH_MERCARI_NATIVE_MIN_TIME_MS = originalMinTime;
        if (originalDeadline === undefined) delete process.env.GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS;
        else process.env.GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS = originalDeadline;
    });

    test('paces every native result page with conservative production defaults', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.GKWATCH_MERCARI_NATIVE_MIN_TIME_MS;
        delete process.env.GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS;

        const mockSchedule = jest.fn(task => Promise.resolve().then(task));
        const mockStats = jest.fn(() => ({ active: 0, queued: 0, minTimeMs: 1500 }));
        const mockRequestPacer = jest.fn().mockImplementation(() => ({
            schedule: mockSchedule,
            stats: mockStats
        }));
        const mockPost = jest.fn()
            .mockResolvedValueOnce({
                data: {
                    items: [{ id: 'm1', name: 'test item one', price: '1000' }],
                    meta: { nextPageToken: 'page-two' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    items: [{ id: 'm2', name: 'test item two', price: '2000' }],
                    meta: { nextPageToken: null }
                }
            });

        jest.doMock('../../utils/requestPacer', () => ({ RequestPacer: mockRequestPacer }));
        jest.doMock('axios', () => ({ post: mockPost, get: jest.fn() }));

        const mercari = require('../../scrapers/mercari');
        const results = await mercari.searchAxios('test', false, [], null, null, {
            sort: 'SORT_CREATED_TIME',
            maxPages: 2,
            timeoutMs: 3000
        });

        expect(mockRequestPacer).toHaveBeenCalledWith({
            name: 'Mercari native API',
            minTimeMs: 1500,
            maxQueue: 4
        });
        expect(mockSchedule).toHaveBeenCalledTimes(2);
        expect(mockPost).toHaveBeenCalledTimes(2);
        expect(results.map(item => item.link)).toEqual([
            'https://jp.mercari.com/item/m1',
            'https://jp.mercari.com/item/m2'
        ]);
        expect(mercari.getNativeRateLimitStats()).toMatchObject({
            minTimeMs: 1500,
            freshnessDeadlineMs: 20000,
            circuitState: 'closed'
        });
    });

    test('accepts bounded pacing and freshness deadline overrides', () => {
        process.env.NODE_ENV = 'production';
        process.env.GKWATCH_MERCARI_NATIVE_MIN_TIME_MS = '2000';
        process.env.GKWATCH_MERCARI_FRESHNESS_DEADLINE_MS = '30000';

        const mockRequestPacer = jest.fn().mockImplementation(() => ({
            schedule: task => Promise.resolve().then(task),
            stats: () => ({})
        }));
        jest.doMock('../../utils/requestPacer', () => ({ RequestPacer: mockRequestPacer }));

        const mercari = require('../../scrapers/mercari');

        expect(mockRequestPacer).toHaveBeenCalledWith({
            name: 'Mercari native API',
            minTimeMs: 2000,
            maxQueue: 4
        });
        expect(mercari.getNativeRateLimitStats()).toMatchObject({
            minTimeMs: 2000,
            freshnessDeadlineMs: 30000
        });
    });
});
