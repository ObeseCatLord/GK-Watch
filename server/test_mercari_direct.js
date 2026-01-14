const mercari = require('./scrapers/mercari');

(async () => {
    console.log("Testing Mercari Scraper Direct Import...");
    const results = await mercari.search("test");
    console.log(`Results found: ${results.length}`);
    process.exit(0);
})();
