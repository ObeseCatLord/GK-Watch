const { performance } = require('perf_hooks');
const crypto = require('crypto');
const Watchlist = require('../server/models/watchlist');
const yahoo = require('../server/scrapers/yahoo');

const MAX_TERMS = 50;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PARALLEL = 4;
const PROVIDERS = new Set(['both', 'native', 'doorzo']);

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
    const options = {
        limit: null,
        timeoutMs: 180000,
        query: null,
        acknowledgeLiveTraffic: false,
        authenticated: false,
        provider: 'both',
        parallel: 1,
        showTerms: false,
        verbose: false
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--limit') options.limit = positiveInteger(argv[++index], Infinity);
        else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger(argv[++index], 180000);
        else if (arg === '--query') options.query = argv[++index] || null;
        else if (arg === '--acknowledge-live-traffic') options.acknowledgeLiveTraffic = true;
        else if (arg === '--authenticated') options.authenticated = true;
        else if (arg === '--provider') options.provider = argv[++index] || '';
        else if (arg === '--parallel') options.parallel = positiveInteger(argv[++index], Infinity);
        else if (arg === '--show-terms') options.showTerms = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--help') options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function links(results) {
    return new Set((results || []).map(item => item?.link).filter(Boolean));
}

async function scheduledYahooTerms(queryOverride, limit) {
    if (queryOverride) return [queryOverride];
    const watches = await Watchlist.getAll();
    const terms = [];
    const seen = new Set();
    for (const watch of watches) {
        if (!watch.active || watch.enabledSites?.yahoo === false) continue;
        for (const term of watch.terms || [watch.term]) {
            const normalized = String(term || '').trim();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            terms.push(normalized);
            if (terms.length >= limit) return terms;
        }
    }
    return terms;
}

async function withScraperLogsSuppressed(verbose, task) {
    if (verbose) return task();
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
        return await task();
    } finally {
        Object.assign(console, original);
    }
}

async function runProvider(provider, query, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const started = performance.now();
    try {
        const results = await withScraperLogsSuppressed(options.verbose, () => yahoo.search(
            query,
            false,
            false,
            'yahoo',
            [],
            controller.signal,
            { mode: 'live', provider, fallback: false, useCookies: options.authenticated }
        ));
        return {
            ok: true,
            durationMs: Math.round(performance.now() - started),
            results: Array.isArray(results) ? results : []
        };
    } catch (error) {
        return {
            ok: false,
            durationMs: Math.round(performance.now() - started),
            results: [],
            errorCode: error?.code || error?.name || 'ERROR',
            error: String(error?.message || error)
        };
    } finally {
        clearTimeout(timeout);
    }
}

function providerSummary(rows, provider) {
    const samples = rows.map(row => row[provider]).filter(Boolean);
    const successful = samples.filter(sample => sample.ok);
    const durations = successful.map(sample => sample.durationMs);
    return {
        attempted: samples.length,
        successful: successful.length,
        failed: samples.length - successful.length,
        totalItems: successful.reduce((sum, sample) => sum + sample.count, 0),
        medianDurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        maxDurationMs: durations.length ? Math.max(...durations) : null
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: node scripts/benchmark-yahoo-providers.js --acknowledge-live-traffic (--limit N | --query TERM) [--provider both|native|doorzo] [--parallel 1-4] [--timeout-ms N] [--authenticated] [--show-terms] [--verbose]');
        return;
    }
    if (!options.acknowledgeLiveTraffic) {
        throw new Error('Refusing live provider traffic without --acknowledge-live-traffic');
    }
    if (!options.query && options.limit === null) {
        throw new Error('Provide an explicit --limit or --query');
    }
    if (options.limit !== null && options.limit > MAX_TERMS) {
        throw new Error(`--limit cannot exceed ${MAX_TERMS}`);
    }
    if (options.timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`--timeout-ms cannot exceed ${MAX_TIMEOUT_MS}`);
    }
    if (!PROVIDERS.has(options.provider)) {
        throw new Error('--provider must be both, native, or doorzo');
    }
    if (options.parallel > MAX_PARALLEL) {
        throw new Error(`--parallel cannot exceed ${MAX_PARALLEL}`);
    }
    if (options.verbose && !options.showTerms) {
        throw new Error('--verbose requires --show-terms because scraper logs contain raw queries');
    }
    if (options.authenticated && !yahoo.hasValidCookies()) {
        throw new Error('--authenticated requires a valid configured Yahoo cookie');
    }

    const terms = await scheduledYahooTerms(options.query, options.query ? 1 : options.limit);
    if (terms.length === 0) throw new Error('No active Yahoo watch terms found');

    const rows = new Array(terms.length);
    const batchStarted = performance.now();
    let nextIndex = 0;
    async function runTerm(index) {
        const query = terms[index];
        const order = options.provider === 'both'
            ? (index % 2 === 0 ? ['native', 'doorzo'] : ['doorzo', 'native'])
            : [options.provider];
        const samples = {};
        for (const provider of order) {
            samples[provider] = await runProvider(provider, query, options);
        }

        const nativeLinks = links(samples.native?.results);
        const doorzoLinks = links(samples.doorzo?.results);
        const overlap = samples.native && samples.doorzo
            ? [...nativeLinks].filter(link => doorzoLinks.has(link)).length
            : 0;
        const row = {
            index: index + 1,
            ...(options.showTerms
                ? { query }
                : { termHash: crypto.createHash('sha256').update(query).digest('hex').slice(0, 12) }),
            ...(samples.native ? { native: {
                ok: samples.native.ok,
                durationMs: samples.native.durationMs,
                count: nativeLinks.size,
                errorCode: samples.native.errorCode || null,
                error: samples.native.error || null
            } } : {}),
            ...(samples.doorzo ? { doorzo: {
                ok: samples.doorzo.ok,
                durationMs: samples.doorzo.durationMs,
                count: doorzoLinks.size,
                errorCode: samples.doorzo.errorCode || null,
                error: samples.doorzo.error || null
            } } : {}),
            overlap,
            nativeOnly: nativeLinks.size - overlap,
            doorzoOnly: doorzoLinks.size - overlap
        };
        rows[index] = row;
        console.log(`YAHOO_BENCHMARK_TERM ${JSON.stringify(row)}`);
    }

    const workerCount = Math.min(options.parallel, terms.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < terms.length) {
            const index = nextIndex++;
            await runTerm(index);
        }
    }));

    const summary = {
        generatedAt: new Date().toISOString(),
        termCount: rows.length,
        provider: options.provider,
        parallel: options.parallel,
        batchDurationMs: Math.round(performance.now() - batchStarted),
        ...(options.provider !== 'doorzo' ? { native: providerSummary(rows, 'native') } : {}),
        ...(options.provider !== 'native' ? { doorzo: providerSummary(rows, 'doorzo') } : {}),
        ...(options.provider === 'both' ? { overlap: {
            common: rows.reduce((sum, row) => sum + row.overlap, 0),
            nativeOnly: rows.reduce((sum, row) => sum + row.nativeOnly, 0),
            doorzoOnly: rows.reduce((sum, row) => sum + row.doorzoOnly, 0)
        } } : {}),
        nativeState: yahoo.getNativeState()
    };
    console.log(`YAHOO_BENCHMARK_SUMMARY ${JSON.stringify(summary)}`);
}

main().catch(error => {
    console.error(`YAHOO_BENCHMARK_FATAL ${JSON.stringify({ error: String(error?.message || error) })}`);
    process.exitCode = 1;
});
