const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Helper to clean up
const cleanup = (dir) => {
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { }
};

async function testConfig(name, usePipe, baseDir) {
    console.log(`\n--- Testing Config: ${name} ---`);
    const userDataDir = path.join(baseDir, `test-${Date.now()}-${Math.random().toString(36).substring(2)}`);
    console.log(`Dir: ${userDataDir}`);
    console.log(`Pipe: ${usePipe}`);

    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    const isARM = process.arch === 'arm' || process.arch === 'arm64';
    const executablePath = (process.platform === 'linux' && isARM)
        ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser')
        : undefined;

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir,
            pipe: usePipe,
            dumpio: true, // Capture stderr to see file errors
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log(`✅ SUCCESS: ${name} launched!`);
        await browser.close();
        cleanup(userDataDir);
        return true;
    } catch (err) {
        console.error(`❌ FAILED: ${name}`);
        console.error(err.message);
        cleanup(userDataDir);
        return false;
    }
}

(async () => {
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

    const snapDir = path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium');
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });

    // Test 1: Downloads + WebSocket
    await testConfig('Downloads + WS', false, downloadsDir);

    // Test 2: Downloads + Pipe
    await testConfig('Downloads + Pipe', true, downloadsDir);

    // Test 3: Snap Common + WS (Baseline)
    await testConfig('SnapCommon + WS', false, snapDir);

})();
