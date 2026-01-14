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

    const isARM = process.arch === 'arm' || process.arch === 'arm64';
    const executablePath = (process.platform === 'linux' && isARM)
        ? (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser')
        : undefined;

    console.log('Executable Path:', executablePath);

    // Test 2: Using Snap Common Dir
    const snapDir = path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium', `test-profile-${Date.now()}`);
    console.log('Using Snap Dir:', snapDir);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir: snapDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in Snap Dir!');
        await browser.close();
    } catch (err) {
        console.error('Snap Dir Launch Failed:', err.message);
    }

    // Test 4: Using Downloads Dir (often whitelisted in Snap)
    const downloadsDir = path.join(os.homedir(), 'Downloads', `test-profile-${Date.now()}`);
    console.log('Using Downloads Dir:', downloadsDir);
    if (!fs.existsSync(path.join(os.homedir(), 'Downloads'))) {
        fs.mkdirSync(path.join(os.homedir(), 'Downloads'));
    }

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir: downloadsDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in Downloads Dir!');
        await browser.close();
    } catch (err) {
        console.error('Downloads Dir Launch Failed:', err.message);
    }
})();
