const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
const surugaya = require('./surugaya');
const taobao = require('./taobao');

const goofish = require('./goofish');
const mandarake = require('./mandarake');

let payPayFailed = false;

const Settings = require('../models/settings');
const queryMatcher = require('../utils/queryMatcher');
const { searchPool, httpPool, mercariFreshnessPool, browserPool } = require('../utils/admissionControl');

const BROWSER_SCRAPERS = new Set(['Taobao', 'Goofish']);

function abortError() {
    const error = new Error('Search was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function waitForAllSettled(tasks, signal) {
    const settled = Promise.allSettled(tasks);
    if (!signal) return settled;
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        settled.then(results => {
            signal.removeEventListener('abort', onAbort);
            resolve(results);
        });
    });
}

// Helper to extract quoted terms: 'foo "bar baz" qux' -> ['bar baz']
function extractQuotedTerms(query) {
    const regex = /"([^"]+)"/g;
    const matches = [];
    let match;
    while ((match = regex.exec(query)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

async function runSearch(query, enabledOverride = null, strictOverride = null, filters = [], onProgress = null, siteOptions = {}, signal = null) {
    console.log(`Starting search for: ${query}`);
    throwIfAborted(signal);
    const settings = Settings.get();

    const quotedTerms = extractQuotedTerms(query);
    if (quotedTerms.length > 0) {
        console.log(`[Scraper] Found quoted strict terms: ${JSON.stringify(quotedTerms)}`);
    }

    // Defaults (safe fallback) or use override
    // Taobao defaults to false - only enabled when explicitly requested (e.g., Search Taobao button)
    const enabled = enabledOverride || settings.enabledSites || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: false, goofish: false, mandarake: false };

    // Determine strict settings:
    // User Request: Options tab (Global Settings) takes priority for DISABLE logic.
    // If Global is OFF for a site, it stays OFF even if Watch is ON.
    // Logic: EffectiveStrict = Override (Watch) AND Global.
    // Both must be TRUE for strict mode to be active.

    const globalStrict = settings.strictFiltering || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: true, goofish: true, mandarake: true };
    let strict;

    if (strictOverride === null || strictOverride === undefined) {
        // No override, use global defaults
        strict = globalStrict;
    } else {
        // Have override (boolean or object)
        // Resolve override to object first
        const overrideObj = typeof strictOverride === 'boolean'
            ? { mercari: strictOverride, yahoo: strictOverride, paypay: strictOverride, fril: strictOverride, surugaya: strictOverride, taobao: strictOverride, goofish: strictOverride, mandarake: strictOverride }
            : strictOverride;

        // Apply AND logic (Lax wins)
        strict = {
            mercari: overrideObj.mercari !== false && globalStrict.mercari !== false,
            yahoo: overrideObj.yahoo !== false && globalStrict.yahoo !== false,
            paypay: overrideObj.paypay !== false && globalStrict.paypay !== false,
            fril: overrideObj.fril !== false && globalStrict.fril !== false,
            surugaya: overrideObj.surugaya !== false && globalStrict.surugaya !== false,
            taobao: overrideObj.taobao !== false && globalStrict.taobao !== false,
            goofish: overrideObj.goofish !== false && (globalStrict.goofish ?? true) !== false,
            mandarake: overrideObj.mandarake !== false && (globalStrict.mandarake ?? true) !== false
        };
    }

    // Enforce global disables (Master Switches)
    // If a site is disabled globally, it should not run even if requested by an item
    if (enabledOverride && settings.enabledSites) {
        if (settings.enabledSites.mercari === false) enabled.mercari = false;
        if (settings.enabledSites.yahoo === false) enabled.yahoo = false;
        if (settings.enabledSites.paypay === false) enabled.paypay = false;
        if (settings.enabledSites.fril === false) enabled.fril = false;
        if (settings.enabledSites.surugaya === false) enabled.surugaya = false;
        if (settings.enabledSites.taobao === false) enabled.taobao = false;
        if (settings.enabledSites.goofish === false) enabled.goofish = false;
        if (settings.enabledSites.mandarake === false) enabled.mandarake = false;
    }

    // Scrapers remain logically parallel, while shared pools bound process-wide work.
    const scraperTasks = [];

    // Total number of enabled scrapers for progress tracking
    let totalScrapers = 0;
    if (enabled.mercari !== false) totalScrapers++;
    if (enabled.yahoo !== false) totalScrapers++;
    if (enabled.paypay !== false) totalScrapers++;
    if (enabled.fril !== false) totalScrapers++;
    if (enabled.surugaya !== false) totalScrapers++;
    if (enabled.taobao !== false) totalScrapers++;
    if (enabled.goofish !== false) totalScrapers++;
    if (enabled.mandarake !== false) totalScrapers++;

    // Helper to log duration and emit progress
    const loggedPromise = async (name, promiseFn, onProgress) => {
        const start = Date.now();
        console.log(`[Scraper] ${name} started`);

        if (onProgress && !signal?.aborted) {
            onProgress({ type: 'start', source: name, totalScrapers });
        }

        // Create a direct progress callback for the scraper to use if it supports streaming
        const scraperProgress = onProgress ? (data) => {
            // data is { items: [], partial: true }
            if (!signal?.aborted && data && data.items && data.items.length > 0) {
                const itemsWithSource = data.items.map(i => ({ ...i, source: name }));
                onProgress({ type: 'result', source: name, items: itemsWithSource, duration: Date.now() - start, partial: true });
            }
        } : null;

        try {
            throwIfAborted(signal);
            // Execute the promise function, passing the progress callback
            const result = await promiseFn(scraperProgress);
            throwIfAborted(signal);
            const duration = Date.now() - start;
            console.log(`[Scraper] ${name} finished in ${duration}ms`);

            // Format results immediately
            let items = [];
            if (Array.isArray(result)) {
                items = result.map(i => ({ ...i, source: name }));
            }

            if (onProgress && !signal?.aborted) {
                const scraperError = result === null
                    ? 'Scraper returned no completion result'
                    : (!Array.isArray(result) && result?.error)
                        ? (result.message || result.error)
                        : items.find(item => item?.error)?.error;
                if (scraperError) {
                    onProgress({ type: 'error', source: name, error: String(scraperError), duration });
                    return result;
                }

                // Always finish with a non-partial event so clients can mark this source complete.
                const CHUNK_SIZE = 50;
                if (items.length > CHUNK_SIZE) {
                    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                        const chunk = items.slice(i, i + CHUNK_SIZE);
                        onProgress({ type: 'result', source: name, items: chunk, duration: 0, partial: true });
                    }
                    onProgress({ type: 'result', source: name, items: [], duration, partial: false });
                } else {
                    onProgress({ type: 'result', source: name, items, duration, partial: false });
                }
            }

            return result;
        } catch (err) {
            const duration = Date.now() - start;
            console.log(`[Scraper] ${name} failed after ${duration}ms`);

            if (onProgress && !signal?.aborted) {
                onProgress({ type: 'error', source: name, error: err.message, duration });
            }
            throw err;
        }
    };

    const scheduleScraper = (name, promiseFn) => {
        const pool = BROWSER_SCRAPERS.has(name) ? browserPool : httpPool;
        return pool.run(() => loggedPromise(name, promiseFn, onProgress), { signal }).catch(error => {
            if (error?.code === 'ADMISSION_LIMIT' && onProgress && !signal?.aborted) {
                onProgress({ type: 'error', source: name, error: error.message, duration: 0 });
            }
            throw error;
        });
    };

    if (enabled.mercari !== false) {
        // Pass function wrapper to allow injecting onProgress
        scraperTasks.push({ name: 'Mercari', promise: scheduleScraper('Mercari', (cb) => mercari.search(query, strict.mercari ?? true, filters, cb, signal)) });
    }

    if (enabled.yahoo !== false) {
        scraperTasks.push({ name: 'Yahoo', promise: scheduleScraper('Yahoo', () => yahoo.search(query, strict.yahoo ?? true, settings.allowYahooInternationalShipping ?? false, 'yahoo', filters, signal)) });
    }

    if (enabled.paypay !== false) {
        scraperTasks.push({ name: 'PayPay Flea Market', promise: scheduleScraper('PayPay Flea Market', () => paypay.search(query, strict.paypay ?? true, filters, signal)) });
    }

    if (enabled.fril !== false) {
        scraperTasks.push({ name: 'Fril', promise: scheduleScraper('Fril', () => fril.search(query, strict.fril ?? true, filters, signal)) });
    }

    if (enabled.surugaya !== false) {
        // Pass filters to Suruga-ya for negative searching
        scraperTasks.push({ name: 'Suruga-ya', promise: scheduleScraper('Suruga-ya', () => surugaya.search(query, strict.surugaya ?? true, filters, signal)) });
    }

    if (enabled.taobao !== false) {
        scraperTasks.push({ name: 'Taobao', promise: scheduleScraper('Taobao', () => taobao.search(query, strict.taobao ?? true, signal)) });
    }

    if (enabled.goofish !== false) {
        // Goofish strict filtering same as others? defaulting to true for now
        scraperTasks.push({ name: 'Goofish', promise: scheduleScraper('Goofish', () => goofish.search(query, strict.goofish ?? true, signal)) });
    }

    if (enabled.mandarake !== false) {
        scraperTasks.push({ name: 'Mandarake', promise: scheduleScraper('Mandarake', () => mandarake.search(query, false, filters, siteOptions.mandarake || {}, signal)) });
    }

    const results = await waitForAllSettled(scraperTasks.map(t => t.promise), signal);
    throwIfAborted(signal);
    let flatResults = [];

    results.forEach((res, index) => {
        const taskName = scraperTasks[index].name;
        if (res.status === 'fulfilled') {
            const val = res.value;

            if (val === null) {
                console.log(`[Scraper] ${taskName} failed and returned null.`);
                if (taskName === 'PayPay Flea Market') payPayFailed = true;

            } else if (Array.isArray(val)) {
                if (val.length > 0) {
                    const itemsWithSource = val.map(i => ({ ...i, source: taskName }));
                    flatResults.push(...itemsWithSource);
                }
            } else if (val && val.error) {
                // Handle PayPay error object specially
                payPayFailed = true;
                console.log(`[Scraper] ${taskName} failed:`, val.status);
            }
        } else {
            // Promise was rejected (Logged in loggedPromise)
            if (taskName === 'PayPay Flea Market') payPayFailed = true;
        }
    });

    // Apply mandatory quoted term filtering
    if (quotedTerms.length > 0) {
        const beforeCount = flatResults.length;
        flatResults = flatResults.filter(item => {
            if (item.error) return true;
            if (item.source === 'Mandarake') return true;
            if (!item.title) return false;
            const titleLower = item.title.toLowerCase();
            return quotedTerms.every(term => titleLower.includes(term.toLowerCase()));
        });
        if (flatResults.length < beforeCount) {
            console.log(`[Scraper] Quoted term filtering removed ${beforeCount - flatResults.length} items. Remaining: ${flatResults.length}`);
        }
    }

    if (enabled.paypay === false) {
        payPayFailed = false;
    }

    // Global Strict Filtering (Safety Net)
    // Ensures that even if a scraper returns loose results (e.g. Suruga-ya Neokyo fallback),
    // we enforce strictness if the user/watch has requested it.
    if (flatResults.length > 0) {
        const parsedQuery = queryMatcher.parseQuery(query);
        const beforeCount = flatResults.length;

        flatResults = flatResults.filter(item => {
            if (item.error) return true;

            // Determine strict setting for this item's source
            let isStrict = true;
            let itemParsedQuery = parsedQuery;
            const source = item.source;

            if (source === 'Mercari') isStrict = strict.mercari ?? true;
            else if (source === 'Yahoo') isStrict = strict.yahoo ?? true;
            else if (source === 'PayPay Flea Market') isStrict = strict.paypay ?? true;
            else if (source === 'Fril') isStrict = strict.fril ?? true;
            else if (source === 'Suruga-ya') isStrict = strict.surugaya ?? true;
            // Taobao/Goofish strictness often handled by API, but safer to enforce
            else if (source === 'Taobao') isStrict = strict.taobao ?? true;
            else if (source === 'Goofish') isStrict = strict.goofish ?? true;
            else if (source === 'Mandarake') {
                isStrict = false;
            }

            // If strict is disabled for this site, pass it through
            if (!isStrict) return true;

            // Otherwise check match
            return queryMatcher.matchesQuery(item.title, itemParsedQuery, true);
        });

        if (flatResults.length < beforeCount) {
            console.log(`[Scraper] Aggregator Strict Safety Net removed ${beforeCount - flatResults.length} loose items.`);
        }
    }

    return flatResults.map(item => {
        if (item.source === 'PayPay Flea Market' && !item.source) item.source = 'PayPay Flea Market';
        return item;
    });
}

function searchAll(query, enabledOverride = null, strictOverride = null, filters = [], onProgress = null, siteOptions = {}, signal = null) {
    return searchPool.run(() => runSearch(query, enabledOverride, strictOverride, filters, onProgress, siteOptions, signal), { signal });
}

function reset() {
    if (mercari.reset) mercari.reset();
    payPayFailed = false;
}

function isPayPayFailed() {
    return payPayFailed;
}

function getAdmissionStats() {
    return {
        searches: searchPool.stats(),
        httpScrapers: httpPool.stats(),
        mercariFreshness: mercariFreshnessPool.stats(),
        mercariNativeRate: mercari.getNativeRateLimitStats?.(),
        browserScrapers: browserPool.stats()
    };
}

module.exports = { searchAll, reset, isPayPayFailed, getAdmissionStats };
