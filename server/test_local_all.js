const mercari = require('./scrapers/mercari');
const taobao = require('./scrapers/taobao');
const goofish = require('./scrapers/goofish');

process.on('unhandledRejection', error => {
    console.log('Unhandled Rejection:', error);
});

async function testScraper(name, scraperFn, query) {
    console.log(`\n--- Testing ${name} ---`);
    try {
        const results = await scraperFn(query);
        console.log(`✅ ${name} Success: Found ${results.length} items.`);
        return true;
    } catch (err) {
        console.error(`❌ ${name} Failed:`, err.message);
        return false;
    }
}

(async () => {
    console.log('Starting Remote Verification...');

    await testScraper('Mercari', mercari.search, 'Miku');

    // These rely on cookies existing on the server
    await testScraper('Taobao', taobao.search, 'Miku');
    await testScraper('Goofish', goofish.search, 'Miku');

    console.log('\nVerification Complete.');
    process.exit(0);
})();
