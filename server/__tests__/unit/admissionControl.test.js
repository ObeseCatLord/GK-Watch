const { AdmissionController, AdmissionLimitError, AdmissionAbortError } = require('../../utils/admissionControl');

describe('AdmissionController', () => {
    test('bounds active work and drains queued tasks', async () => {
        const controller = new AdmissionController({ name: 'test', maxConcurrent: 1, maxQueue: 2 });
        let release;
        const blocker = new Promise(resolve => { release = resolve; });
        const order = [];

        const first = controller.run(async () => {
            order.push('first-start');
            await blocker;
            order.push('first-end');
        });
        const second = controller.run(async () => order.push('second'));

        await Promise.resolve();
        expect(controller.stats()).toMatchObject({ active: 1, queued: 1 });
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(['first-start', 'first-end', 'second']);
        expect(controller.stats()).toMatchObject({ active: 0, queued: 0 });
    });

    test('rejects overflow without executing it', async () => {
        const controller = new AdmissionController({ name: 'test', maxConcurrent: 1, maxQueue: 0 });
        let release;
        const first = controller.run(() => new Promise(resolve => { release = resolve; }));

        await expect(controller.run(() => 'never')).rejects.toBeInstanceOf(AdmissionLimitError);
        expect(controller.stats().rejected).toBe(1);
        release();
        await first;
    });

    test('releases capacity when a task rejects', async () => {
        const controller = new AdmissionController({ name: 'test', maxConcurrent: 1, maxQueue: 1 });
        await expect(controller.run(() => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
        await expect(controller.run(() => 'ok')).resolves.toBe('ok');
    });

    test('removes an aborted queued task and recovers capacity', async () => {
        const controller = new AdmissionController({ name: 'test', maxConcurrent: 1, maxQueue: 1 });
        let release;
        const first = controller.run(() => new Promise(resolve => { release = resolve; }));
        const abortController = new AbortController();
        const queuedTask = jest.fn(() => 'never');
        const queued = controller.run(queuedTask, { signal: abortController.signal });

        expect(controller.stats()).toMatchObject({ active: 1, queued: 1 });
        abortController.abort();

        await expect(queued).rejects.toBeInstanceOf(AdmissionAbortError);
        expect(queuedTask).not.toHaveBeenCalled();
        expect(controller.stats()).toMatchObject({ active: 1, queued: 0 });

        release();
        await first;
        expect(controller.stats()).toMatchObject({ active: 0, queued: 0 });
    });
});
