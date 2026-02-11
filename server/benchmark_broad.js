const axios = require('axios');
const cheerio = require('cheerio');
const dejapan = require('./scrapers/dejapan');
const doorzo = require('./scrapers/doorzo');

const TERM = 'ガレージキット';

// --- Helpers ---
async function searchNeokyoAdHoc(query) {
    const searchUrl = `https://neokyo.com/en/search/surugaya?provider=surugaya&translate=0&order-tag=modificationTime%3Adescending&keyword=${encodeURIComponent(query)}`;
    console.log(`[Neokyo-AdHoc] Fetching: ${searchUrl}`);
    try {
        const res = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.5' },
            timeout: 10000
        });
        const $ = cheerio.load(res.data);
        const count = $('.product-card').length;
        // Neokyo pagination check
        let totalPages = 1;
        const pagination = $('.pagination');
        if (pagination.length) {
            // Rough estimate or just parse page 1 count
        }
        return { count, page1Items: count };
    } catch (e) {
        return { error: e.message };
    }
}

async function runBenchmark() {
    console.log(`\n=== BENCHMARK: "${TERM}" ===\n`);

    // 1. Suruga-ya (Doorzo)
    console.log('1. Suruga-ya (Doorzo)...');
    let sDoorzo = { count: 0 };
    try {
        const res = await doorzo.search(TERM, 'surugaya');
        sDoorzo.count = res ? res.length : 0;
    } catch (e) { sDoorzo.error = e.message; }
    console.log(`   -> Found: ${sDoorzo.count}`);

    // 2. Suruga-ya (Neokyo - AdHoc)
    console.log('2. Suruga-ya (Neokyo Source)...');
    const sNeokyo = await searchNeokyoAdHoc(TERM);
    console.log(`   -> Found (Page 1): ${sNeokyo.count} ${sNeokyo.error ? `(Error: ${sNeokyo.error})` : ''}`);

    // 3. Suruga-ya (Dejapan)
    console.log('3. Suruga-ya (Dejapan)...');
    let sDejapan = { count: 0 };
    try {
        const res = await dejapan.searchSurugaya(TERM, false);
        sDejapan.count = res ? res.length : 0;
    } catch (e) { sDejapan.error = e.message; }
    console.log(`   -> Found: ${sDejapan.count}`);

    // 4. PayPay (Doorzo)
    console.log('4. PayPay (Doorzo)...');
    let pDoorzo = { count: 0 };
    try {
        const res = await doorzo.search(TERM, 'paypay');
        pDoorzo.count = res ? res.length : 0;
    } catch (e) { pDoorzo.error = e.message; }
    console.log(`   -> Found: ${pDoorzo.count}`);

}

runBenchmark();
