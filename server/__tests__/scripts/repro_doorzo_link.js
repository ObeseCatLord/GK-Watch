const doorzo = require('./server/scrapers/doorzo');

async function test() {
    console.log('Searching for "miku" on Doorzo (PayPay)...');
    const results = await doorzo.search('miku', 'paypay');

    if (results && results.length > 0) {
        console.log('First item link:', results[0].link);
        if (results[0].link.includes('doorzo.com')) {
            console.log('FAIL: Link is a Doorzo link.');
        } else if (results[0].link.includes('paypayfleamarket.yahoo.co.jp')) {
            console.log('SUCCESS: Link is a native PayPay link.');
        } else {
            console.log('UNKNOWN: Link format not recognized.');
        }
    } else {
        console.log('No results found to test.');
    }
}

test();
