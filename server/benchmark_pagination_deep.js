const axios = require('axios');

const ENDPOINT = 'https://sig.doorzo.com/';
const TERM = 'ガレージキット';

function generateDeviceId() {
    return 'pc_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function fetchAll(site, maxPages = 200) {
    console.log(`\nStarting Deep Benchmark for ${site}...`);
    let token = null;
    let totalItems = 0;
    let pageCount = 0;

    const params = {
        n: 'Sig.Front.SubSite.AppGlobal.MixSearch',
        from: 'INTERNATIONAL',
        isNew: 15,
        language: 'en',
        keyword: TERM,
        website: site, // 'surugaya' or 'paypay'
        onlyInStock: 1,
        orderBy: 'created_desc',
        deviceId: generateDeviceId()
    };

    try {
        do {
            pageCount++;
            const currentParams = { ...params };
            if (token) currentParams.nextPageToken = token;

            const res = await axios.get(ENDPOINT, { params: currentParams, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const items = res.data?.data?.items || [];

            totalItems += items.length;
            process.stdout.write(`Page ${pageCount} found ${items.length} items. Total: ${totalItems}\r`);

            token = res.data?.data?.nextPageToken;
            if (items.length === 0) break;

            // Be nice to the API
            await new Promise(r => setTimeout(r, 500));

        } while (token && pageCount < maxPages);

        console.log(`\n[${site}] Finished. Total pages: ${pageCount}. Total items: ${totalItems}`);

    } catch (e) {
        console.error(`\nError: ${e.message}`);
    }
}

async function run() {
    // await fetchAll('surugaya');
    await fetchAll('paypay');
}

run();
