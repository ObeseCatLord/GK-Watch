const taobao = require('./server/scrapers/taobao');

async function test() {
    console.log('='.repeat(60));
    console.log('Testing Taobao scraper...');
    console.log('='.repeat(60));
    console.log('');

    // Test 1: Chinese search term - 东方 白模 (Touhou resin kit)
    console.log('Test 1: Searching for "东方 白模"...');
    console.log('-'.repeat(60));
    const results1 = await taobao.search('东方 白模');
    console.log(`Found ${results1.length} results`);
    if (results1.length > 0) {
        console.log('\nSample result:');
        console.log(JSON.stringify(results1[0], null, 2));
        console.log('\nFirst 3 titles:');
        results1.slice(0, 3).forEach((item, idx) => {
            console.log(`  ${idx + 1}. ${item.title.substring(0, 80)}...`);
            console.log(`     Price: ${item.price}`);
        });
    }
    console.log('');

    // Test 2: Alternative search term - 手办 (figure)
    console.log('Test 2: Searching for "手办 白模"...');
    console.log('-'.repeat(60));
    const results2 = await taobao.search('手办 白模');
    console.log(`Found ${results2.length} results`);
    if (results2.length > 0) {
        console.log('\nFirst title:', results2[0].title.substring(0, 80));
        console.log('Price:', results2[0].price);
    }
    console.log('');

    // Test 3: Strict filtering test with OR operator
    console.log('Test 3: Testing strict filtering with "东方 | 手办"...');
    console.log('-'.repeat(60));
    const results3 = await taobao.search('东方 | 手办', true);
    console.log(`Strict mode - Found ${results3.length} results`);
    if (results3.length > 0) {
        console.log('Sample matches:');
        results3.slice(0, 2).forEach((item, idx) => {
            console.log(`  ${idx + 1}. ${item.title.substring(0, 80)}...`);
        });
    }
    console.log('');

    // Test 4: Non-strict mode
    console.log('Test 4: Testing non-strict mode with "东方"...');
    console.log('-'.repeat(60));
    const results4 = await taobao.search('东方', false);
    console.log(`Non-strict mode - Found ${results4.length} results`);
    console.log('');

    console.log('='.repeat(60));
    console.log('Test completed!');
    console.log('='.repeat(60));
}

test()
    .catch(error => {
        console.error('\n\nTest Error:', error.message);
        console.error(error.stack);
    })
    .finally(() => {
        process.exit(0);
    });
