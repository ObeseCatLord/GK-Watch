const doorzo = require('./scrapers/doorzo');
const TERM = 'ガレージキット';
async function run() {
    console.log('Checking PayPay (Doorzo)...');
    try {
        const res = await doorzo.search(TERM, 'paypay');
        console.log(`PayPay Doorzo Found: ${res ? res.length : 0}`);
    } catch (e) { console.error(e); }
}
run();
