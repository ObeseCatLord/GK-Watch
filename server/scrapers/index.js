const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
// Mandarake and Suruga-ya disabled due to anti-bot blocking

let payPayFailed = false;

const Settings = require('../models/settings');

async function searchAll(query) {
    console.log(`Starting search for: ${query}`);
    const settings = Settings.get();

    // Defaults (safe fallback)
    const enabled = settings.enabledSites || { mercari: true, yahoo: true, paypay: true, fril: true };
    const strict = settings.strictFiltering || { mercari: true, yahoo: true, paypay: true, fril: true };

    // Run all scrapers in parallel
    // using Promise.allSettled so one failure doesn't stop others
    const promises = [];

    if (enabled.mercari !== false) {
        promises.push(mercari.search(query, strict.mercari ?? true).then(res => res.map(i => ({ ...i, source: 'Mercari' }))));
    } else {
        promises.push(Promise.resolve([])); // push empty result if disabled to keep indices stable? No, we filter below.
    }

    if (enabled.yahoo !== false) {
        promises.push(yahoo.search(query, strict.yahoo ?? true).then(res => res.map(i => ({ ...i, source: 'Yahoo Auctions' }))));
    }

    if (enabled.paypay !== false) {
        promises.push(paypay.search(query, strict.paypay ?? true));
    }

    if (enabled.fril !== false) {
        promises.push(fril.search(query, strict.fril ?? true).then(res => res.map(i => ({ ...i, source: 'Fril' }))));
    }

    const results = await Promise.allSettled(promises);
    const flatResults = [];

    results.forEach((res, index) => {
        if (res.status === 'fulfilled') {
            const val = res.value;
            // Handle PayPay error object specially
            if (val && !Array.isArray(val) && val.error) {
                // It's a paypay error
                payPayFailed = true;
                console.log('[Scraper] PayPay failed:', val.status);
            } else if (Array.isArray(val)) {
                // If it's paypay results, check if we need to map source (paypay.search doesn't map it internally?)
                // paypay.js returns object with source already set? Let's check paypay.js.
                // paypay.js returns { source: 'PayPay Flea Market' } in item.
                // But in generic loop here we just spread.

                // Note: The structure of promises array is dynamic now so we can't assume index 2 is paypay.
                // We should rely on the returned data having 'source' or being empty.
                if (val.length > 0) {
                    flatResults.push(...val);
                }
            }
        }
    });

    // Reset paypay failed flag if it was enabled and succeeded (or if disabled)
    // Actually simplest way is: if enabled.paypay === false, payPayFailed = false.
    // If enabled.paypay === true, and result was error, payPayFailed = true.

    if (enabled.paypay === false) {
        payPayFailed = false;
    }
    // If enabled and error, handled in loop above.
    // If enabled and success, we should set false?
    // Current loop sets true if error. We need to clear it somewhere? reset() clears it.

    return flatResults.map(item => {
        // Ensure source is set for PayPay if missing (Wait, paypay.js sets it)
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
