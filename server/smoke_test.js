#!/usr/bin/env node
/**
 * Smoke Test Suite for GK-Watch
 * Run after deploy to verify core functionality
 * Exit code 0 = all tests passed, 1 = failures
 */

const searchAggregator = require('./scrapers');
const Watchlist = require('./models/watchlist');
const Settings = require('./models/settings');
const BlockedItems = require('./models/blocked_items');

const TEST_QUERY = '東方 ガレージキット';
const TIMEOUT_MS = 60000;

// Skip scrapers in CI to avoid geo-blocking and network issues
const SKIP_SCRAPERS = process.env.CI === 'true' || process.env.SKIP_SCRAPERS === 'true';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
    process.stdout.write(`  ${name}... `);
    try {
        await Promise.race([
            fn(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
            )
        ]);
        console.log('✅');
        passed++;
    } catch (err) {
        console.log(`❌ ${err.message}`);
        failed++;
    }
};

const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'Assertion failed');
};

(async () => {
    console.log('\n🧪 GK-Watch Smoke Tests\n');
    console.log('━'.repeat(50));

    // =====================
    // Settings Tests
    // =====================
    console.log('\n📋 Settings');

    await test('Can read settings', async () => {
        const settings = Settings.get();
        assert(settings !== null, 'Settings is null');
        assert(typeof settings === 'object', 'Settings is not an object');
    });

    await test('Settings has required fields', async () => {
        const settings = Settings.get();
        assert('loginEnabled' in settings, 'Missing loginEnabled');
        assert('enabledSites' in settings, 'Missing enabledSites');
    });

    // =====================
    // Watchlist Tests
    // =====================
    console.log('\n📝 Watchlist');

    await test('Can read watchlist', async () => {
        const list = await Watchlist.getAll();
        assert(Array.isArray(list), 'Watchlist is not an array');
    });

    await test('Can add and remove item', async () => {
        const testTerm = `__SMOKE_TEST_${Date.now()}__`;
        const item = await Watchlist.add({ term: testTerm });
        assert(item && item.id, 'Failed to add item');

        await Watchlist.remove(item.id);
        const afterRemove = await Watchlist.getAll();
        const found = afterRemove.find(i => i.id === item.id);
        assert(!found, 'Item was not removed');
    });

    // =====================
    // BlockedItems Tests
    // =====================
    console.log('\n🚫 Blocked Items');

    await test('Can read blocked items', async () => {
        const blocked = BlockedItems.getAll();
        assert(Array.isArray(blocked), 'Blocked items is not an array');
    });

    await test('Can filter results', async () => {
        const testResults = [
            { link: 'http://test1.com', title: 'Test 1' },
            { link: 'http://test2.com', title: 'Test 2' }
        ];
        const filtered = BlockedItems.filterResults(testResults);
        assert(Array.isArray(filtered), 'Filter did not return array');
    });

    // =====================
    // Individual Scraper Tests
    // =====================
    console.log('\n🔍 Scrapers (Individual)');

    if (SKIP_SCRAPERS) {
        console.log('  ⏭️  Skipping individual scraper tests (CI/SKIP_SCRAPERS)');
    } else {

        // Mercari
        await test('Mercari scraper returns results', async () => {
            const mercari = require('./scrapers/mercari');
            const results = await mercari.search(TEST_QUERY, true);
            assert(Array.isArray(results), 'Mercari did not return array');
            assert(results.length > 0, 'Mercari returned no results');
            console.log(`(${results.length} items)`);
        });

        // Yahoo
        await test('Yahoo scraper returns results', async () => {
            const yahoo = require('./scrapers/yahoo');
            const results = await yahoo.search(TEST_QUERY, true);
            assert(Array.isArray(results), 'Yahoo did not return array');
            assert(results.length > 0, 'Yahoo returned no results');
            console.log(`(${results.length} items)`);
        });

        // PayPay
        await test('PayPay scraper returns results', async () => {
            const paypay = require('./scrapers/paypay');
            const results = await paypay.search(TEST_QUERY, true);
            assert(Array.isArray(results), 'PayPay did not return array');
            // PayPay may return 0 if blocked, so just check it doesn't crash
            console.log(`(${results.length} items)`);
        });

        // Fril
        await test('Fril scraper returns results', async () => {
            const fril = require('./scrapers/fril');
            const results = await fril.search(TEST_QUERY, true);
            assert(Array.isArray(results), 'Fril did not return array');
            console.log(`(${results.length} items)`);
        });

        // Surugaya
        await test('Surugaya scraper returns results', async () => {
            const surugaya = require('./scrapers/surugaya');
            const results = await surugaya.search(TEST_QUERY, true);
            assert(Array.isArray(results), 'Surugaya did not return array');
            console.log(`(${results.length} items)`);
        });

    }

    // =====================
    // Aggregated Search Test
    // =====================
    console.log('\n🔎 Aggregated Search');

    if (SKIP_SCRAPERS) {
        console.log('  ⏭️  Skipping aggregated search test (CI/SKIP_SCRAPERS)');
    } else {

        await test('searchAll returns combined results', async () => {
            const enabledSites = {
                mercari: true,
                yahoo: true,
                paypay: true,
                fril: true,
                surugaya: true,
                taobao: false,
                goofish: false
            };
            const results = await searchAggregator.searchAll(TEST_QUERY, enabledSites, true, []);
            assert(Array.isArray(results), 'searchAll did not return array');
            assert(results.length > 0, 'searchAll returned no results');
            console.log(`(${results.length} total items)`);
        });

    }

    // =====================
    // Results Summary
    // =====================
    console.log('\n' + '━'.repeat(50));
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) {
        console.log('❌ Some tests failed!\n');
        process.exit(1);
    } else {
        console.log('✅ All tests passed!\n');
        process.exit(0);
    }
})();
