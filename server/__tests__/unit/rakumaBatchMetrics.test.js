const { createRakumaBatchMetrics } = require('../../utils/rakumaBatchMetrics');

test('counts streamed Rakuma matches separately from empty results and failures', () => {
    const metrics = createRakumaBatchMetrics();
    const forward = jest.fn();
    const track = metrics.trackQuery(forward);
    track({ source: 'Mercari', type: 'result', items: [], duration: 20 });
    track({ source: 'Fril', type: 'result', items: [{}], partial: true, duration: 0 });
    track({ source: 'Fril', type: 'result', items: [], partial: false, duration: 550 });
    metrics.trackQuery(forward)({ source: 'Fril', type: 'result', items: [], duration: 600 });
    metrics.recordFallback();
    metrics.trackQuery(forward)({ source: 'Fril', type: 'error', duration: 2000 });

    expect(forward).toHaveBeenCalledTimes(5);
    expect(metrics.summarize()).toEqual({
        queries: 3, matched: 1, empty: 1, failures: 1, fallbacks: 1, medianMs: 600, p95Ms: 2000, warning: true
    });
});

test.each([
    [500, 0, false],
    [500, 2, true],
    [2000, 0, true]
])('warns for slow or fallback-heavy batches while allowing fast empty searches', (duration, fallbacks, warning) => {
    const metrics = createRakumaBatchMetrics();
    for (let i = 0; i < 10; i++) {
        if (i < fallbacks) metrics.recordFallback();
        metrics.trackQuery(() => {})({ source: 'Fril', type: 'result', items: [], duration });
    }
    expect(metrics.summarize()).toMatchObject({ empty: 10, failures: 0, warning });
});
