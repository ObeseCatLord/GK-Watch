const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
const surugaya = require('./surugaya');
const taobao = require('./taobao');

const goofish = require('./goofish');
// Mandarake removed as out of scope

let payPayFailed = false;

const Settings = require('../models/settings');

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

async function searchAll(query, enabledOverride = null, strictOverride = null, filters = [], onProgress = null) {
    console.log(`Starting search for: ${query}`);
    const settings = Settings.get();

    const quotedTerms = extractQuotedTerms(query);
    if (quotedTerms.length > 0) {
        console.log(`[Scraper] Found quoted strict terms: ${JSON.stringify(quotedTerms)}`);
    }

    // Defaults (safe fallback) or use override
    // Taobao defaults to false - only enabled when explicitly requested (e.g., Search Taobao button)
    const enabled = enabledOverride || settings.enabledSites || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: false };

    // Determine strict settings:
    // User Request: Options tab (Global Settings) takes priority for DISABLE logic.
    // If Global is OFF for a site, it stays OFF even if Watch is ON.
    // Logic: EffectiveStrict = Override (Watch) AND Global.
    // Both must be TRUE for strict mode to be active.

    const globalStrict = settings.strictFiltering || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: true };
    let strict;

    if (strictOverride === null || strictOverride === undefined) {
        // No override, use global defaults
        strict = globalStrict;
    } else {
        // Have override (boolean or object)
        // Resolve override to object first
        const overrideObj = typeof strictOverride === 'boolean'
            ? { mercari: strictOverride, yahoo: strictOverride, paypay: strictOverride, fril: strictOverride, surugaya: strictOverride, taobao: strictOverride }
            : strictOverride;

        // Apply AND logic (Lax wins)
        strict = {
            mercari: overrideObj.mercari !== false && globalStrict.mercari !== false,
            yahoo: overrideObj.yahoo !== false && globalStrict.yahoo !== false,
            paypay: overrideObj.paypay !== false && globalStrict.paypay !== false,
            fril: overrideObj.fril !== false && globalStrict.fril !== false,
            surugaya: overrideObj.surugaya !== false && globalStrict.surugaya !== false,
            taobao: overrideObj.taobao !== false && globalStrict.taobao !== false,
            goofish: overrideObj.goofish !== false && (globalStrict.goofish ?? true) !== false
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
    }

    // Run all scrapers in parallel
    // using Promise.allSettled so one failure doesn't stop others
    // Run all scrapers in parallel
    // using Promise.allSettled so one failure doesn't stop others
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

    // Helper to log duration and emit progress
    const loggedPromise = async (name, promise, onProgress) => {
        const start = Date.now();
        console.log(`[Scraper] ${name} started`);

        if (onProgress) {
            onProgress({ type: 'start', source: name, totalScrapers });
        }

        try {
            const result = await promise;
            const duration = Date.now() - start;
            console.log(`[Scraper] ${name} finished in ${duration}ms`);

            // Format results immediately
            let items = [];
            if (Array.isArray(result)) {
                items = result.map(i => ({ ...i, source: name }));
            }

            if (onProgress) {
                // Chunk results to prevent massive payloads (which cause proxy/client disconnects)
                const CHUNK_SIZE = 50;
                if (items.length > CHUNK_SIZE) {
                    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                        const chunk = items.slice(i, i + CHUNK_SIZE);
                        onProgress({ type: 'result', source: name, items: chunk, duration: 0, partial: true });
                    }
                    // Send completion event for duration tracking? 
                    // Or just rely on the last chunk?
                    // Let's send a final empty result to confirm completion and duration
                    onProgress({ type: 'result', source: name, items: [], duration, partial: false });
                } else {
                    onProgress({ type: 'result', source: name, items, duration });
                }
            }

            return result;
        } catch (err) {
            const duration = Date.now() - start;
            console.log(`[Scraper] ${name} failed after ${duration}ms`);

            if (onProgress) {
                onProgress({ type: 'error', source: name, error: err.message, duration });
            }
            throw err;
        }
    };

    if (enabled.mercari !== false) {
        scraperTasks.push({ name: 'Mercari', promise: loggedPromise('Mercari', mercari.search(query, strict.mercari ?? true, filters), onProgress) });
    }

    if (enabled.yahoo !== false) {
        scraperTasks.push({ name: 'Yahoo', promise: loggedPromise('Yahoo', yahoo.search(query, strict.yahoo ?? true, settings.allowYahooInternationalShipping ?? false, 'yahoo', filters), onProgress) });
    }

    if (enabled.paypay !== false) {
        scraperTasks.push({ name: 'PayPay Flea Market', promise: loggedPromise('PayPay Flea Market', paypay.search(query, strict.paypay ?? true, filters), onProgress) });
    }

    if (enabled.fril !== false) {
        scraperTasks.push({ name: 'Fril', promise: loggedPromise('Fril', fril.search(query, strict.fril ?? true, filters), onProgress) });
    }

    if (enabled.surugaya !== false) {
        // Pass filters to Suruga-ya for negative searching
        scraperTasks.push({ name: 'Suruga-ya', promise: loggedPromise('Suruga-ya', surugaya.search(query, strict.surugaya ?? true, filters), onProgress) });
    }

    if (enabled.taobao !== false) {
        scraperTasks.push({ name: 'Taobao', promise: loggedPromise('Taobao', taobao.search(query, strict.taobao ?? true), onProgress) });
    }

    if (enabled.goofish !== false) {
        // Goofish strict filtering same as others? defaulting to true for now
        scraperTasks.push({ name: 'Goofish', promise: loggedPromise('Goofish', goofish.search(query, strict.goofish ?? true), onProgress) });
    }

    const results = await Promise.allSettled(scraperTasks.map(t => t.promise));
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

    return flatResults.map(item => {
        if (item.source === 'PayPay Flea Market' && !item.source) item.source = 'PayPay Flea Market';
        return item;
    });
}

function reset() {
    if (mercari.reset) mercari.reset();
    payPayFailed = false;
}

function isPayPayFailed() {
    return payPayFailed;
}

module.exports = { searchAll, reset, isPayPayFailed };

