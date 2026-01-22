const searchAggregator = require('./scrapers');

(async () => {
    const query = "東方 ガレージキット";
    console.log(`\nStarting benchmark for query: "${query}"...`);

    // Warmup? No, usually cold start is what we care about here or just one-off.
    // Let's just run it once as requested.

    const start = performance.now();
    try {
        // Search logic similar to server.js: strict=true, no blacklists for raw benchmark
        // Enable ALL scrapers (including Taobao) for full check
        const results = await searchAggregator.searchAll(query, {}, true, []);


        const end = performance.now();

        const duration = (end - start) / 1000;
        console.log(`\n✅ Search Completed!`);
        console.log(`Found ${results.length} items.`);
        console.log(`Time taken: ${duration.toFixed(3)} seconds`);

    } catch (err) {
        console.error('❌ Search Failed:', err);
    }

    // Allow process to exit naturally or force exit if scrapers hang
    process.exit(0);
})();
