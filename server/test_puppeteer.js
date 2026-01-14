const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');

(async () => {
    console.log('Starting Puppeteer Test...');
    console.log('Platform:', process.platform);
    console.log('Arch:', process.arch);
    console.log('TMPDIR env:', process.env.TMPDIR);
    console.log('os.tmpdir():', os.tmpdir());

    // Test 3: Using Bundled Chrome (no executablePath)

    // Test 2: Using Snap Common Dir
    const snapDir = path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium', `test-profile-${Date.now()}`);
    console.log('Using Snap Dir:', snapDir);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            // executablePath, // REMOVED
            userDataDir: snapDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in Snap Dir!');
        await browser.close();
    } catch (err) {
        console.error('Snap Dir Launch Failed:', err.message);
    }
})();
