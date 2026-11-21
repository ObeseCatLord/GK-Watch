const { matchesQuery, parseQuery } = require('../utils/queryMatcher');
const doorzo = require('./doorzo');
const jsubculture = require('./jsubculture');

const SOLD_RETENTION_MS = 24 * 60 * 60 * 1000;

function filterItems(items, parsedQuery, strictEnabled, excludedTerms) {
    return items.filter(item => {
        if (!matchesQuery(item.title, parsedQuery, strictEnabled)) return false;
        if (excludedTerms.some(term => item.title.toLowerCase().includes(term))) return false;

        const soldAt = item.soldAt || item.endTime;
        return item.isSold !== true || !soldAt || !(Date.now() - new Date(soldAt).getTime() >= SOLD_RETENTION_MS);
    });
}

async function search(query, strictEnabled = true, filters = [], signal = null) {
    signal?.throwIfAborted();
    const parsedQuery = parseQuery(query);
    const excludedTerms = (filters || []).map(term => term.toLowerCase());
    const primary = await jsubculture.search(query, 'paypay', signal);
    const results = filterItems(primary.items, parsedQuery, strictEnabled, excludedTerms);

    if (primary.complete && results.length > 0) {
        console.log(`[PayPay] J-Subculture found ${results.length} matching listings.`);
        return results;
    }

    try {
        console.log('[PayPay] Falling back to Doorzo.');
        const fallback = await doorzo.search(query, 'paypay', signal);
        signal?.throwIfAborted();
        if (Array.isArray(fallback)) {
            const listings = new Map(results.map(item => [item.link, item]));
            for (const item of filterItems(fallback, parsedQuery, strictEnabled, excludedTerms)) {
                if (!listings.has(item.link)) listings.set(item.link, item);
            }
            return [...listings.values()];
        }
    } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[PayPay] Doorzo failed: ${error.message}`);
    }

    return primary.complete || results.length > 0 ? results : null;
}

module.exports = { search };
