const doorzo = require('./scrapers/doorzo');
const TERM = 'ガレージキット';

// Check if Doorzo loops
async function run() {
    console.log('Verifying Doorzo Pagination Integration (MAX 200)...');
    try {
        // Start the search, but we likely don't want to wait for 200 pages here if it works.
        // We can inspect output logs if we run it.
        // However, 200 pages takes time.
        // Let's just run it and kill it after seeing page 2 logic trigger in logs.
        // Or trust the code review. 
        // We'll let it run for a bit.
        const res = await doorzo.search(TERM, 'surugaya');
        console.log(`[Result] Found ${res ? res.length : 0} items.`);
    } catch (e) { console.error(e); }
}

run();
