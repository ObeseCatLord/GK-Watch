const fs = require('fs');
const path = require('path');

const BENCHMARK_FILE = path.join(__dirname, 'benchmark_results.json');
const ITERATIONS = 50; // Reduced iterations to keep it fast but visible
const INITIAL_ITEMS = 5000; // Larger dataset to make I/O significant

// Setup: Create a file with some initial data
function setup() {
    const data = {};
    for (let i = 0; i < INITIAL_ITEMS; i++) {
        data[`item_${i}`] = {
            id: `item_${i}`,
            items: Array(10).fill({ title: 'Existing Item', link: `http://example.com/${i}` })
        };
    }
    fs.writeFileSync(BENCHMARK_FILE, JSON.stringify(data, null, 2));
    const size = fs.statSync(BENCHMARK_FILE).size / 1024 / 1024;
    console.log(`[Setup] Created ${BENCHMARK_FILE} (~${size.toFixed(2)} MB) with ${INITIAL_ITEMS} items.`);
}

function cleanup() {
    if (fs.existsSync(BENCHMARK_FILE)) fs.unlinkSync(BENCHMARK_FILE);
}

// 1. Current Implementation (Sync Read/Write inside loop)
function runSyncBenchmark() {
    console.log('\n--- Sync Read/Write Loop (Current) ---');
    const start = Date.now();

    for (let i = 0; i < ITERATIONS; i++) {
        // Read
        const content = fs.readFileSync(BENCHMARK_FILE, 'utf8');
        const data = JSON.parse(content);

        // Modify
        const key = `item_${i % INITIAL_ITEMS}`;
        if (data[key]) {
            data[key].newCount = (data[key].newCount || 0) + 1;
        }

        // Write
        fs.writeFileSync(BENCHMARK_FILE, JSON.stringify(data, null, 2));

        if (i % 10 === 0) process.stdout.write('.');
    }
    console.log('');

    const end = Date.now();
    console.log(`Total Time: ${end - start}ms`);
    console.log(`Avg Time per Iteration: ${((end - start) / ITERATIONS).toFixed(2)}ms`);
    return end - start;
}

// 2. Optimized Implementation (In-Memory Cache)
function runOptimizedBenchmark() {
    console.log('\n--- In-Memory Cache (Optimized) ---');
    const start = Date.now();

    // 1. Load Once
    const content = fs.readFileSync(BENCHMARK_FILE, 'utf8');
    const data = JSON.parse(content);

    for (let i = 0; i < ITERATIONS; i++) {
        // Modify In-Memory
        const key = `item_${i % INITIAL_ITEMS}`;
        if (data[key]) {
            data[key].newCount = (data[key].newCount || 0) + 1;
        }
    }

    // 2. Write Once (simulating end of batch)
    fs.writeFileSync(BENCHMARK_FILE, JSON.stringify(data, null, 2));

    const end = Date.now();
    console.log(`Total Time: ${end - start}ms`);
    console.log(`Avg Time per Iteration: ${((end - start) / ITERATIONS).toFixed(2)}ms`);
    return end - start;
}

function run() {
    try {
        setup();
        const syncTime = runSyncBenchmark();
        const optTime = runOptimizedBenchmark();

        console.log(`\nImprovement: ${(syncTime / optTime).toFixed(1)}x faster`);
    } catch(e) {
        console.error(e);
    } finally {
        cleanup();
    }
}

run();
