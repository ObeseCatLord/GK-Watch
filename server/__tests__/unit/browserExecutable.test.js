'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveBrowserExecutable } = require('../../utils/browserExecutable');

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

describe('browser executable resolution', () => {
    let existsSyncSpy;
    const originalExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;

    beforeEach(() => {
        existsSyncSpy = jest.spyOn(fs, 'existsSync');
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        delete process.env.PUPPETEER_EXECUTABLE_PATH;
    });

    afterEach(() => {
        existsSyncSpy.mockRestore();
        if (ORIGINAL_PLATFORM) {
            Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
        }
        if (originalExecutable === undefined) {
            delete process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
            process.env.PUPPETEER_EXECUTABLE_PATH = originalExecutable;
        }
    });

    test('uses explicit browser path when provided', () => {
        const explicit = path.join(os.tmpdir(), 'puppeteer-browser');
        process.env.PUPPETEER_EXECUTABLE_PATH = explicit;
        existsSyncSpy.mockImplementation(candidate => candidate === explicit);

        expect(resolveBrowserExecutable()).toBe(explicit);
    });

    test('falls back to known system candidates when explicit path is missing', () => {
        const systemPath = '/usr/bin/chromium';
        existsSyncSpy.mockImplementation(candidate => candidate === systemPath);

        expect(resolveBrowserExecutable()).toBe(systemPath);
    });

    test('throws when no browser executable can be resolved', () => {
        existsSyncSpy.mockReturnValue(false);

        expect(() => resolveBrowserExecutable()).toThrow('Chrome, Chromium, or Edge is required; set PUPPETEER_EXECUTABLE_PATH');
    });

    test('uses Microsoft Edge on Windows when Chrome is unavailable', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const programFiles = process.env.PROGRAMFILES;
        process.env.PROGRAMFILES = 'C:\\Program Files';
        const edge = path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe');
        existsSyncSpy.mockImplementation(candidate => candidate === edge);

        try {
            expect(resolveBrowserExecutable()).toBe(edge);
        } finally {
            if (programFiles === undefined) delete process.env.PROGRAMFILES;
            else process.env.PROGRAMFILES = programFiles;
        }
    });
});
