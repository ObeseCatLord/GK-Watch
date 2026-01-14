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

    // Test 1: Using os.tmpdir() (which should be $HOME/tmp)
    const userDataDir = path.join(os.tmpdir(), `test-profile-${Date.now()}`);
    console.log('Using UserDataDir:', userDataDir);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('Browser launched successfully!');
        const page = await browser.newPage();
        console.log('Page created.');
        await browser.close();
        console.log('Browser closed.');
    } catch (err) {
        console.error('Launch failed:', err);
    } finally {
        if (fs.existsSync(userDataDir)) {
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
                console.log('Cleanup successful.');
            } catch (e) {
                console.error('Cleanup failed:', e);
            }
        }
    }
})();
