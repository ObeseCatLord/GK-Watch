const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'dummy_results.json');

// 1. Generate Dummy Data (~10MB)
function generateData() {
    console.log('Generating dummy data...');
    const data = {};
    const payload = 'x'.repeat(1024); // 1KB string
    for (let i = 0; i < 10000; i++) {
        data[`item_${i}`] = {
            id: `item_${i}`,
            description: payload
        };
    }
    fs.writeFileSync(FILE_PATH, JSON.stringify(data));
    const stats = fs.statSync(FILE_PATH);
    console.log(`Generated ${FILE_PATH} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
}

// 2. Sync Implementation
function getResultsSync() {
    try {
        if (fs.existsSync(FILE_PATH)) {
            const allResults = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
            return allResults['item_1'] || null;
        }
    } catch (e) {
        return null;
    }
}

// 3. Async Implementation
async function getResultsAsync() {
    try {
        // We use fs.promises.access to check existence or just try/catch read
        // The original code checks existsSync first.
        // For async, it's often better to just try reading and handle ENOENT,
        // but to match logic we can use access.
        // However, standard optimization is just readFile and catch error.
        try {
            const content = await fs.promises.readFile(FILE_PATH, 'utf8');
            const allResults = JSON.parse(content);
            return allResults['item_1'] || null;
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    } catch (e) {
        return null;
    }
}

// Helper to measure event loop lag
function monitorLag(durationMs) {
    return new Promise(resolve => {
        const start = Date.now();
        let maxLag = 0;
        let ticks = 0;

        const interval = setInterval(() => {
            const now = Date.now();
            const expected = start + (ticks + 1) * 10;
            const lag = now - expected; // Should be near 0
            if (lag > maxLag) maxLag = lag;
            // ticks++; // Simpler: just measure delta from previous
        }, 10);

        let lastTick = Date.now();
        const checkInterval = setInterval(() => {
            const now = Date.now();
            const delta = now - lastTick;
            const lag = delta - 10;
            if (lag > maxLag) maxLag = lag;
            lastTick = now;
        }, 10);

        setTimeout(() => {
            clearInterval(checkInterval);
            resolve(maxLag);
        }, durationMs);
    });
}

async function runBenchmark() {
    if (!fs.existsSync(FILE_PATH)) {
        generateData();
    }

    const ITERATIONS = 20;

    console.log(`\nRunning Benchmark (${ITERATIONS} iterations)...`);

    // --- SYNC TEST ---
    console.log('\n--- Sync Read ---');

    let maxLagSync = 0;
    const syncLagMonitor = setInterval(() => {
        // This won't even fire if the loop is tight enough, proving the point.
    }, 10);

    // We can't use the interval inside the sync loop because it blocks.
    // We can measure the time of each operation.

    const startSync = Date.now();
    let syncDelays = [];

    // To measure "lag" effectively for sync code:
    // We record timestamp before and after the call. The difference IS the blocked time.
    for (let i = 0; i < ITERATIONS; i++) {
        const t1 = Date.now();
        getResultsSync();
        const t2 = Date.now();
        syncDelays.push(t2 - t1);
    }
    const endSync = Date.now();

    clearInterval(syncLagMonitor);

    const avgSyncDelay = syncDelays.reduce((a,b) => a+b, 0) / syncDelays.length;
    const maxSyncBlock = Math.max(...syncDelays);

    console.log(`Total Time: ${endSync - startSync}ms`);
    console.log(`Avg Block Time: ${avgSyncDelay.toFixed(2)}ms`);
    console.log(`Max Block Time: ${maxSyncBlock}ms`);


    // --- ASYNC TEST ---
    console.log('\n--- Async Read ---');

    // For async, we want to see if we can interleave other work.
    // We'll run the async operations and simultaneously run a "pinger" that checks how responsive the event loop is.

    let maxLagAsync = 0;
    let lastPing = Date.now();
    const pinger = setInterval(() => {
        const now = Date.now();
        const lag = (now - lastPing) - 10; // Expected 10ms
        if (lag > maxLagAsync) maxLagAsync = lag;
        lastPing = now;
    }, 10);

    const startAsync = Date.now();
    // Run sequentially to compare per-request blocking behavior
    for (let i = 0; i < ITERATIONS; i++) {
        await getResultsAsync();
    }
    const endAsync = Date.now();

    clearInterval(pinger);

    console.log(`Total Time: ${endAsync - startAsync}ms`);
    console.log(`Max Event Loop Lag: ${maxLagAsync}ms`);

    console.log('\n--- Result ---');
    console.log(`Sync blocks the thread for ~${avgSyncDelay.toFixed(0)}ms per request.`);
    console.log(`Async max lag was ${maxLagAsync}ms (should be much lower than Sync Block Time).`);

    // Cleanup
    fs.unlinkSync(FILE_PATH);
}

runBenchmark();
