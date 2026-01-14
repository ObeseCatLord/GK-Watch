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

    // Test 6: Pipe Connection + Shell Headless
    const pipeDir = path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium', `test-profile-pipe-${Date.now()}`);
    console.log('Using Pipe Dir:', pipeDir);

    try {
        const browser = await puppeteer.launch({
            headless: "shell", // Old headless
            executablePath,
            userDataDir: pipeDir,
            pipe: true, // Use pipe instead of WS
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched with PIPE!');
        await browser.close();
    } catch (err) {
        console.error('Pipe Launch Failed:', err.message);
    }

    // Test 7: XDG Runtime Dir
    const runDir = '/run/user/1001/puppeteer_test';
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

    const xdgProfile = path.join(runDir, `test-profile-${Date.now()}`);
    console.log('Using XDG Dir:', xdgProfile);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir: xdgProfile,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in XDG Dir!');
        await browser.close();
    } catch (err) {
        console.error('XDG Launch Failed:', err.message);
    }

    // Test 8: Headless FALSE (Diagnostic)
    const displayDir = path.resolve(`./test-profile-display-${Date.now()}`);
    console.log('Using Display Dir:', displayDir);

    try {
        const browser = await puppeteer.launch({
            headless: false,
            executablePath: '/snap/bin/chromium', // Direct path
            userDataDir: displayDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in Display Mode!');
        await browser.close();
    } catch (err) {
        console.error('Display Mode Launch Failed:', err.message);
    }

    // Test 5: Relative Path (in CWD)
    const relativeDir = path.resolve(`./test-profile-${Date.now()}`);
    console.log('Using Relative Dir:', relativeDir);

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath,
            userDataDir: relativeDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        console.log('SUCCESS: Browser launched in Relative Dir!');
        await browser.close();
    } catch (err) {
        console.error('Relative Dir Launch Failed:', err.message);
        // Test 9: Default /tmp Dir
        const tmpProfile = path.join('/tmp', `test-profile-${Date.now()}`);
        console.log('Using /tmp Dir:', tmpProfile);

        try {
            const browser = await puppeteer.launch({
                headless: "new",
                executablePath,
                userDataDir: tmpProfile,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
            console.log('SUCCESS: Browser launched in /tmp Dir!');
            await browser.close();
        } catch (err) {
            console.error('/tmp Dir Launch Failed:', err.message);
        }
    }) ();
