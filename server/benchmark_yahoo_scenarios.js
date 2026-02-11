const yahoo = require('./scrapers/yahoo');

(async () => {
    const terms = [
        '東方 ガレージキット',
        'キュアフローラ ガレージキット',
        'キュアマカロン ガレージキット'
    ];

    console.log("=== Benchmarking Yahoo Native vs Doorzo (Scenarios) ===\n");

    for (const query of terms) {
        console.log(`\n--- Query: "${query}" ---`);

        // Native Benchmark
        let nativeTime = 0;
        let nativeCount = 0;
        try {
            const start = Date.now();
            const results = await yahoo.search(query);
            const end = Date.now();
            nativeTime = (end - start) / 1000;
            nativeCount = results.length;
            console.log(`[Native] Time: ${nativeTime.toFixed(2)}s | Items: ${nativeCount}`);
        } catch (err) {
            console.error(`[Native] Failed: ${err.message}`);
        }

        // Doorzo Benchmark
        let doorzoTime = 0;
        let doorzoCount = 0;
        try {
            const start = Date.now();
            // searchDoorzo(query, strict, international, target, filters)
            // Using loose settings to match native's raw output before strict filtering if possible, 
            // but searchDoorzo applies strictness internally if strict=true.
            // Let's use strict=true for both to compare "final usable results".
            const results = await yahoo.searchDoorzo(query, true, false, 'all', []);
            const end = Date.now();
            doorzoTime = (end - start) / 1000;
            doorzoCount = results ? results.length : 0;
            console.log(`[Doorzo] Time: ${doorzoTime.toFixed(2)}s | Items: ${doorzoCount}`);
        } catch (err) {
            console.error(`[Doorzo] Failed: ${err.message}`);
        }

        // Comparison
        const diff = nativeTime - doorzoTime;
        const winner = diff < 0 ? 'Native' : 'Doorzo';
        console.log(`Winner: ${winner} (${Math.abs(diff).toFixed(2)}s faster)`);
    }

})();
