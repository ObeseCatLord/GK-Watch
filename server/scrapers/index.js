const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
const surugaya = require('./surugaya');

let payPayFailed = false;

const Settings = require('../models/settings');

async function searchAll(query) {
    console.log(`Starting search for: ${query}`);
    const settings = Settings.get();

    // Defaults (safe fallback)
    const enabled = settings.enabledSites || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true };
    const strict = settings.strictFiltering || { mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true };

    // Run all scrapers in parallel
    // using Promise.allSettled so one failure doesn't stop others
    const promises = [];

    if (enabled.mercari !== false) {
        promises.push(mercari.search(query, strict.mercari ?? true).then(res => res.map(i => ({ ...i, source: 'Mercari' }))));
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

    if (enabled.surugaya !== false) {
        promises.push(surugaya.search(query).then(res => res.map(i => ({ ...i, source: 'Suruga-ya' }))));
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
                if (val.length > 0) {
                    flatResults.push(...val);
                }
            }
        }
    });

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

