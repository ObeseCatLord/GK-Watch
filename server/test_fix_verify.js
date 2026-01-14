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

    // Test 4: Downloads + TMPDIR Override
    const customTmp = path.join(downloadsDir, 'tmp_override');
    if (!fs.existsSync(customTmp)) fs.mkdirSync(customTmp);
    process.env.TMPDIR = customTmp;
    console.log(`Set TMPDIR = ${customTmp}`);
    await testConfig('Downloads + TMPDIR', false, downloadsDir);
    // Test 5: Dedicated Custom Binary (Bypass Snap)
    console.log('\n--- Testing Config: Dedicated Binary ---');
    // Find the binary dynamically
    const binBase = path.join(os.homedir(), 'chrome_bin', 'chrome');
    let customBinPath = '';
    if (fs.existsSync(binBase)) {
        const versions = fs.readdirSync(binBase);
        if (versions.length > 0) {
            customBinPath = path.join(binBase, versions[0], 'chrome-linux64', 'chrome');
        }
    }

    if (customBinPath && fs.existsSync(customBinPath)) {
        console.log(`Found binary: ${customBinPath}`);
        // Override executable path logic locally for this test
        const originalEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
        process.env.PUPPETEER_EXECUTABLE_PATH = customBinPath;

        await testConfig('Dedicated Binary + WS', false, downloadsDir);

        process.env.PUPPETEER_EXECUTABLE_PATH = originalEnv || '';
    } else {
        console.log('Skipping Dedicated Binary test (not found)');
    }

})();
