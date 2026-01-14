const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
const surugaya = require('./surugaya');
const taobao = require('./taobao');
const goofish = require('./goofish');

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

async function searchAll(query, enabledOverride = null, strictOverride = null, filters = []) {
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
            goofish: overrideObj.goofish !== false && (globalStrict.goofish ?? true) !== false // Handle goofish if missing in legacy settings
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
    const promises = [];

    if (enabled.mercari !== false) {
        promises.push(mercari.search(query, strict.mercari ?? true, filters).then(res => res.map(i => ({ ...i, source: 'Mercari' }))));
    }

    if (enabled.yahoo !== false) {
        promises.push(yahoo.search(query, strict.yahoo ?? true, settings.allowYahooInternationalShipping ?? false, 'yahoo').then(res => res.map(i => ({ ...i, source: 'Yahoo' }))));
    }

    if (enabled.paypay !== false) {
        promises.push(paypay.search(query, strict.paypay ?? true, filters));
    }

    if (enabled.fril !== false) {
        promises.push(fril.search(query, strict.fril ?? true, filters).then(res => res.map(i => ({ ...i, source: 'Fril' }))));
    }

    if (enabled.surugaya !== false) {
        // Pass filters to Suruga-ya for negative searching
        promises.push(surugaya.search(query, strict.surugaya ?? true, filters).then(res => res.map(i => ({ ...i, source: 'Suruga-ya' }))));
    }

    if (enabled.taobao !== false) {
        promises.push(taobao.search(query, strict.taobao ?? true).then(res => res.map(i => ({ ...i, source: 'Taobao' }))));
    }

    if (enabled.goofish !== false) {
        // Goofish strict filtering same as others? defaulting to true for now
        promises.push(goofish.search(query).then(res => res.map(i => ({ ...i, source: 'Goofish' }))));
    }

    const results = await Promise.allSettled(promises);
    let flatResults = [];

    results.forEach((res, index) => {
        if (res.status === 'fulfilled') {
            const val = res.value;
            // Handle PayPay error object specially
            if (val && !Array.isArray(val) && val.error) {
                // It's a paypay error
                payPayFailed = true;
                console.log('[Scraper] PayPay failed:', val.status);
            } else if (Array.isArray(val)) {
                if (val.length > 0) {
                    flatResults.push(...val);
                }
            }
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

