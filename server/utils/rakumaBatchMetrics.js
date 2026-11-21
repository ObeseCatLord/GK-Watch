function createRakumaBatchMetrics() {
    const durations = [];
    let matched = 0;
    let failures = 0;
    let fallbacks = 0;

    return {
        recordFallback() {
            fallbacks++;
        },

        trackQuery(onProgress) {
            let hasMatches = false;
            return event => {
                onProgress(event);
                if (event.source !== 'Fril') return;

                if (event.type === 'result' && event.items?.length) hasMatches = true;
                if (event.type === 'error') failures++;
                else if (event.type !== 'result' || event.partial) return;
                else if (hasMatches) matched++;
                durations.push(event.duration);
            };
        },

        summarize() {
            const queries = durations.length;
            if (!queries) return null;
            const ordered = [...durations].sort((a, b) => a - b);
            const medianMs = ordered[Math.ceil(queries / 2) - 1];
            const p95Ms = ordered[Math.ceil(queries * 0.95) - 1];
            const empty = queries - matched - failures;
            const warning = failures > 0 || (queries >= 10 && (
                medianMs >= 2000 || p95Ms >= 5000 || fallbacks / queries >= 0.2
            ));
            return { queries, matched, empty, failures, fallbacks, medianMs, p95Ms, warning };
        }
    };
}

module.exports = { createRakumaBatchMetrics };
