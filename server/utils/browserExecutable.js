'use strict';

const fs = require('fs');
const path = require('path');

function browserCandidates() {
    const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];
    if (process.platform === 'linux') {
        candidates.push(
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable'
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );
    } else if (process.platform === 'win32') {
        for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
            if (!base) continue;
            candidates.push(
                path.join(base, 'Google/Chrome/Application/chrome.exe'),
                path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
                path.join(base, 'Chromium/Application/chrome.exe')
            );
        }
    }
    return candidates.filter(Boolean);
}

function resolveBrowserExecutable() {
    const executable = browserCandidates().find(candidate => fs.existsSync(candidate));
    if (!executable) {
        throw new Error('Chrome, Chromium, or Edge is required; set PUPPETEER_EXECUTABLE_PATH');
    }
    return executable;
}

module.exports = { resolveBrowserExecutable };
