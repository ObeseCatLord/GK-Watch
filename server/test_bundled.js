const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');

(async () => {
    // Path found from previous step (will confirm dynamically or hardcode if standard)
    // Likely: /home/ubuntu/.cache/puppeteer/chromium/linux_arm-*/chrome-linux/chrome
    const executablePath = process.argv[2];

    if (!executablePath) {
        console.error("Usage: node test_bundled.js <path_to_chrome>");
        process.exit(1);
    }

    console.log(`Testing Bundled Binary: ${executablePath}`);

    const userDataDir = path.join('/tmp', `bundled-test-${Date.now()}`);
    console.log(`Using Profile: ${userDataDir}`);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath: executablePath,
            userDataDir: userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Bundled Browser Launched!');
        const version = await browser.version();
        console.log(`Browser Version: ${version}`);
        await browser.close();
    } catch (err) {
        console.error('Bundled Launch Failed:', err);
    }
})();
