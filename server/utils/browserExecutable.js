'use strict';

const fs = require('fs');
const path = require('path');

function browserCandidates() {
    const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];
    if (process.platform === 'linux') {
        candidates.push('/usr/bin/chromium', '/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else if (process.platform === 'win32') {
        for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
            if (base) candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
        }
    }
    return candidates.filter(Boolean);
}

function resolveBrowserExecutable() {
    const executable = browserCandidates().find(candidate => fs.existsSync(candidate));
    if (!executable) {
        throw new Error('Chromium or Google Chrome is required; set PUPPETEER_EXECUTABLE_PATH');
    }
    return executable;
}

module.exports = { resolveBrowserExecutable };
