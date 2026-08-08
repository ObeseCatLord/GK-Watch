import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { browserCandidates, isSupportedNodeVersion } from './gkwatch-tasks.mjs';

test('accepts the supported Node range', () => {
    assert.equal(isSupportedNodeVersion('20.18.1'), true);
    assert.equal(isSupportedNodeVersion('20.20.2'), true);
    assert.equal(isSupportedNodeVersion('26.9.0'), true);
});

test('rejects unsupported or malformed Node versions', () => {
    assert.equal(isSupportedNodeVersion('20.18.0'), false);
    assert.equal(isSupportedNodeVersion('19.9.0'), false);
    assert.equal(isSupportedNodeVersion('27.0.0'), false);
    assert.equal(isSupportedNodeVersion('invalid'), false);
});

test('includes Windows Chrome, Edge, and Chromium candidates', () => {
    const env = {
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local'
    };
    const candidates = browserCandidates(env, 'win32');

    assert.ok(candidates.includes(path.join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')));
    assert.ok(candidates.includes(path.join(env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe')));
    assert.ok(candidates.includes(path.join(env.LOCALAPPDATA, 'Chromium/Application/chrome.exe')));
});

test('includes Microsoft Edge candidates on Linux and macOS', () => {
    assert.ok(browserCandidates({}, 'linux').includes('/usr/bin/microsoft-edge-stable'));
    assert.ok(browserCandidates({}, 'darwin').includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
});
