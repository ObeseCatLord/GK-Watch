const yahoo = require('./scrapers/yahoo');

(async () => {
    console.log("=== Benchmarking Native Yahoo vs Doorzo Yahoo ===");
    const query = '東方 ガレージキット';

    try {
        // --- Native Benchmark ---
        console.log(`\nStarting Native Scraper for "${query}"...`);
        const startNative = Date.now();
        const nativeResults = await yahoo.search(query);
        const endNative = Date.now();
        const timeNative = (endNative - startNative) / 1000;
        console.log(`[Native] Time: ${timeNative.toFixed(2)}s | Items: ${nativeResults.length}`);

        // --- Doorzo Benchmark ---
        console.log(`\nStarting Doorzo Scraper for "${query}"...`);
        const startDoorzo = Date.now();
        // searchDoorzo signature: (query, strict, international, target, filters)
        const doorzoResults = await yahoo.searchDoorzo(query, true, false, 'all', []);
        const endDoorzo = Date.now();
        const timeDoorzo = (endDoorzo - startDoorzo) / 1000;
        console.log(`[Doorzo] Time: ${timeDoorzo.toFixed(2)}s | Items: ${doorzoResults ? doorzoResults.length : 'Failed'}`);

        // --- Summary ---
        console.log("\n=== Summary ===");
        console.log(`Query: "${query}"`);
        console.log(`Native: ${timeNative.toFixed(2)}s (${nativeResults.length} items)`);
        console.log(`Doorzo: ${timeDoorzo.toFixed(2)}s (${doorzoResults ? doorzoResults.length : 0} items)`);

        const diff = timeNative - timeDoorzo;
        if (diff < 0) console.log(`Winner: Native is ${Math.abs(diff).toFixed(2)}s FASTER`);
        else console.log(`Winner: Doorzo is ${diff.toFixed(2)}s FASTER`);

    } catch (err) {
        console.error("Benchmark failed:", err);
    }
})();
