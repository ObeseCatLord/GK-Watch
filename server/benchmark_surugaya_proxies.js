const axios = require('axios');
const dejapan = require('./scrapers/dejapan');
const neokyo = require('./scrapers/surugaya');

const QUERY = '東方 ガレージキット';

// --- Doorzo Scraper (Ad-hoc) ---
const ENDPOINT = 'https://sig.doorzo.com/';
function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

function decodeHexUrl(hex) {
    if (!hex) return null;
    try {
        const url = Buffer.from(hex, 'hex').toString('utf8');
        return url;
    } catch (e) {
        return null;
    }
}

async function searchDoorzo(query) {
    console.log(`[Doorzo] Searching...`);
    const params = {
        n: 'Sig.Front.SubSite.AppGlobal.MixSearch',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        keyword: query,
        website: 'surugaya',
        onlyInStock: 1,
        orderBy: 'created_desc',
        deviceId: generateDeviceId()
    };

    const start = Date.now();
    try {
        const res = await axios.get(ENDPOINT, {
            params,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://www.doorzo.com',
                'Referer': 'https://www.doorzo.com/'
            },
            timeout: 15000
        });
        const duration = Date.now() - start;

        if (res.data && res.data.data && Array.isArray(res.data.data.items)) {
            const items = res.data.data.items.map(i => ({
                title: i.Name,
                price: i.JPYPrice,
                link: decodeHexUrl(i.Url)
            }));
            return { count: items.length, duration, items };
        }
        return { count: 0, duration, items: [] };

    } catch (err) {
        return { count: 0, duration: Date.now() - start, error: err.message };
    }
}

// --- Benchmark Runner ---
async function runBenchmark() {
    console.log(`\n\n=== BENCHMARK: Suruga-ya Proxies ("${QUERY}") ===\n`);

    // 1. Run Doorzo
    const item1 = await searchDoorzo(QUERY);
    console.log(`Doorzo:  ${item1.count} items in ${(item1.duration / 1000).toFixed(2)}s`);

    // 2. Run Neokyo (via existing scraper)
    // Note: Neokyo scraper in surugaya.js logs to console, so output might be mixed
    console.log(`[Neokyo] Searching...`);
    const start2 = Date.now();
    let count2 = 0;
    try {
        // Force strict=false to match Doorzo/Dejapan broad search
        const res2 = await neokyo.search(QUERY, false);
        count2 = res2 ? res2.length : 0;
    } catch (e) { console.error(e.message); }
    const duration2 = Date.now() - start2;
    console.log(`Neokyo:  ${count2} items in ${(duration2 / 1000).toFixed(2)}s`);

    // 3. Run Dejapan (via existing scraper)
    console.log(`[Dejapan] Searching...`);
    const start3 = Date.now();
    let count3 = 0;
    try {
        const res3 = await dejapan.searchSurugaya(QUERY, false);
        count3 = res3 ? res3.length : 0;
    } catch (e) { console.error(e.message); }
    const duration3 = Date.now() - start3;
    console.log(`Dejapan: ${count3} items in ${(duration3 / 1000).toFixed(2)}s`);

    console.log(`\n=== SUMMARY ===`);
    console.table([
        { Proxy: 'Doorzo', Items: item1.count, Time: `${(item1.duration / 1000).toFixed(2)}s`, Status: item1.error ? 'Error' : 'OK' },
        { Proxy: 'Neokyo', Items: count2, Time: `${(duration2 / 1000).toFixed(2)}s`, Status: 'OK' },
        { Proxy: 'Dejapan', Items: count3, Time: `${(duration3 / 1000).toFixed(2)}s`, Status: 'OK' }
    ]);
}

runBenchmark();
