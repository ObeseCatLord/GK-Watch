'use strict';

const { RequestPacer } = require('../../utils/requestPacer');

describe('RequestPacer', () => {
    test('serializes work and spaces request starts', async () => {
        const pacer = new RequestPacer({ name: 'test API', minTimeMs: 25, maxQueue: 4 });
        const starts = [];
        const task = () => {
            starts.push(Date.now());
            return starts.length;
        };

        const results = await Promise.all([
            pacer.schedule(task),
            pacer.schedule(task),
            pacer.schedule(task)
        ]);

        expect(results).toEqual([1, 2, 3]);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(20);
        expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(20);
        expect(pacer.stats()).toMatchObject({ active: 0, queued: 0, minTimeMs: 25 });
    });

    test('removes an aborted queued request without consuming a paced slot', async () => {
        const pacer = new RequestPacer({ name: 'test API', minTimeMs: 40, maxQueue: 4 });
        let releaseFirst;
        const first = pacer.schedule(() => new Promise(resolve => { releaseFirst = resolve; }));
        while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));

        const controller = new AbortController();
        const stale = pacer.schedule(() => 'must not run', { signal: controller.signal });
        controller.abort();

        await expect(stale).rejects.toMatchObject({ code: 'ABORT_ERR' });
        expect(pacer.stats().queued).toBe(0);

        releaseFirst('first');
        await expect(first).resolves.toBe('first');
        await expect(pacer.schedule(() => 'next')).resolves.toBe('next');
        expect(pacer.stats()).toMatchObject({ active: 0, queued: 0 });
    });

    test('does not overlap long-running requests', async () => {
        const pacer = new RequestPacer({ name: 'test API', minTimeMs: 0, maxQueue: 2 });
        let releaseFirst;
        let secondStarted = false;
        const first = pacer.schedule(() => new Promise(resolve => { releaseFirst = resolve; }));
        while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));

        const second = pacer.schedule(() => {
            secondStarted = true;
            return 'second';
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(secondStarted).toBe(false);

        releaseFirst('first');
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
    });

    test('close rejects queued work and prevents new scheduling', async () => {
        const pacer = new RequestPacer({ name: 'test API', minTimeMs: 0, maxQueue: 2 });
        let releaseFirst;
        const first = pacer.schedule(() => new Promise(resolve => { releaseFirst = resolve; }));
        while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));

        const queued = pacer.schedule(() => 'queued');
        pacer.close();

        await expect(queued).rejects.toMatchObject({ code: 'PACE_CLOSED' });
        await expect(pacer.schedule(() => 'new')).rejects.toMatchObject({ code: 'PACE_CLOSED' });
        expect(pacer.stats()).toMatchObject({ queued: 0, closed: true });

        releaseFirst('first');
        await expect(first).resolves.toBe('first');
    });

    test('rejects work beyond the configured waiting queue', async () => {
        const pacer = new RequestPacer({ name: 'test API', minTimeMs: 0, maxQueue: 1 });
        let releaseFirst;
        const first = pacer.schedule(() => new Promise(resolve => { releaseFirst = resolve; }));
        while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));

        const queued = pacer.schedule(() => 'queued');
        await expect(pacer.schedule(() => 'overflow')).rejects.toMatchObject({ code: 'PACE_LIMIT' });
        expect(pacer.stats()).toMatchObject({ queued: 1, maxQueue: 1, rejected: 1 });

        releaseFirst('first');
        await expect(first).resolves.toBe('first');
        await expect(queued).resolves.toBe('queued');
    });
});
