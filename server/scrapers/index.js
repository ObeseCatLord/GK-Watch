const mercari = require('./mercari');
const yahoo = require('./yahoo');
const paypay = require('./paypay');
const fril = require('./fril');
// Mandarake and Suruga-ya disabled due to anti-bot blocking

let payPayFailed = false;

async function searchAll(query) {
    console.log(`Starting search for: ${query}`);

    // Run all scrapers in parallel
    // using Promise.allSettled so one failure doesn't stop others
    const [mercariRes, yahooRes, paypayRes, frilRes] = await Promise.allSettled([
        mercari.search(query).then(res => res.map(i => ({ ...i, source: 'Mercari' }))),
        yahoo.search(query).then(res => res.map(i => ({ ...i, source: 'Yahoo Auctions' }))),
        paypay.search(query),
        fril.search(query).then(res => res.map(i => ({ ...i, source: 'Fril' })))
    ]);

    const flatResults = [];

    if (mercariRes.status === 'fulfilled') flatResults.push(...mercariRes.value);
    if (yahooRes.status === 'fulfilled') flatResults.push(...yahooRes.value);
    if (frilRes.status === 'fulfilled') flatResults.push(...frilRes.value);

    // Handle PayPay specially - check for error object
    if (paypayRes.status === 'fulfilled') {
        const paypayData = paypayRes.value;
        if (paypayData && paypayData.error) {
            payPayFailed = true;
            console.log('[Scraper] PayPay marked as failed due to error status:', paypayData.status);
        } else if (Array.isArray(paypayData)) {
            payPayFailed = false;
            flatResults.push(...paypayData.map(i => ({ ...i, source: 'PayPay Flea Market' })));
        }
    } else {
        payPayFailed = true;
    }

    return flatResults;
}

function reset() {
    if (mercari.reset) mercari.reset();
    payPayFailed = false;
}

function isPayPayFailed() {
    return payPayFailed;
}

module.exports = { searchAll, reset, isPayPayFailed };
