const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cleanup = (dir) => {
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
};

async function testConfig(name, usePipe, baseDir) {
    console.log(`\n--- Testing Config: ${name} ---`);
    const userDataDir = path.join(baseDir, `test-${Date.now()}-${Math.random().toString(36).substring(2)}`);
    console.log(`Dir: ${userDataDir}`);
    console.log(`Pipe: ${usePipe}`);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    // Use System Chromium (Snap)
    const executablePath = '/usr/bin/chromium-browser';

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir,
            pipe: usePipe,
            dumpio: true,
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

    // Test 1: Downloads + WS
    await testConfig('Downloads + WS', false, downloadsDir);
    // Test 2: Downloads + Pipe
    await testConfig('Downloads + Pipe', true, downloadsDir);
})();
