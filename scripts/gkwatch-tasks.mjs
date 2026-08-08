#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const CLIENT_DIR = path.join(ROOT, 'client');
const CLIENT_BUILD = path.join(CLIENT_DIR, 'dist', 'index.html');
const IS_WINDOWS = process.platform === 'win32';

export function isSupportedNodeVersion(version = process.versions.node) {
    const [major, minor, patch] = String(version).split('.').map(Number);
    if (![major, minor, patch].every(Number.isFinite)) return false;
    return (major === 20 && (minor > 18 || (minor === 18 && patch >= 1))) || (major > 20 && major < 27);
}

export function browserCandidates(env = process.env, platform = process.platform) {
    const candidates = [env.PUPPETEER_EXECUTABLE_PATH];

    if (platform === 'linux') {
        candidates.push(
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable'
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );
    } else if (platform === 'win32') {
        for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
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

export function resolveBrowser(env = process.env, platform = process.platform) {
    return browserCandidates(env, platform).find(candidate => fs.existsSync(candidate)) || null;
}

function npmCommand() {
    return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

function commandInvocation(command, args) {
    if (IS_WINDOWS && command.toLowerCase().endsWith('.cmd')) {
        return {
            command: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', command, ...args]
        };
    }
    return { command, args };
}

function runChecked(command, args, options = {}) {
    const invocation = commandInvocation(command, args);
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: options.cwd || ROOT,
        env: options.env || process.env,
        stdio: 'inherit'
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
}

function checkNode() {
    if (!isSupportedNodeVersion()) {
        throw new Error(`Node.js 20.18.1 through 26.x is required. Found ${process.version}.`);
    }
}

function checkNpm() {
    const invocation = commandInvocation(npmCommand(), ['--version']);
    const result = spawnSync(invocation.command, invocation.args, { stdio: 'ignore' });
    if (result.status !== 0) throw new Error('npm is required but was not found in PATH.');
}

function doctor({ checkBrowser = true } = {}) {
    checkNode();
    checkNpm();

    if (checkBrowser) {
        const browser = resolveBrowser();
        if (!browser) {
            throw new Error('Chrome, Chromium, or Edge is required; set PUPPETEER_EXECUTABLE_PATH if it is installed in a custom location.');
        }
        console.log(`[OK] Browser: ${browser}`);
    }

    console.log(`[OK] Node.js: ${process.version}`);
    console.log('[OK] npm is available.');
}

function installDependencies() {
    const installEnv = {
        ...process.env,
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD: 'true'
    };

    console.log('\nInstalling server dependencies...');
    try {
        runChecked(npmCommand(), ['ci'], { cwd: SERVER_DIR, env: installEnv });
    } catch (error) {
        console.warn(`Server install failed once: ${error.message}`);
        console.warn('Retrying server install...');
        runChecked(npmCommand(), ['ci'], { cwd: SERVER_DIR, env: installEnv });
    }

    console.log('\nInstalling client dependencies...');
    runChecked(npmCommand(), ['ci'], { cwd: CLIENT_DIR, env: installEnv });
}

function verify() {
    console.log('\nAuditing and testing server...');
    runChecked(npmCommand(), ['audit', '--omit=dev', '--audit-level=high'], { cwd: SERVER_DIR });
    runChecked(npmCommand(), ['test', '--', '--runInBand'], { cwd: SERVER_DIR });

    console.log('\nAuditing, linting, and testing client...');
    runChecked(npmCommand(), ['audit', '--omit=dev', '--audit-level=high'], { cwd: CLIENT_DIR });
    runChecked(npmCommand(), ['run', 'lint'], { cwd: CLIENT_DIR });
    runChecked(npmCommand(), ['test', '--', '--run'], { cwd: CLIENT_DIR });
}

function buildClient() {
    console.log('\nBuilding client...');
    runChecked(npmCommand(), ['run', 'build'], { cwd: CLIENT_DIR });
}

function setup() {
    doctor();
    installDependencies();
    verify();
    buildClient();
    fs.mkdirSync(path.join(SERVER_DIR, 'data'), { recursive: true, mode: 0o700 });
    console.log('\nSetup completed successfully.');
}

function isPortOpen(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const socket = net.createConnection({ port, host });
        const finish = value => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(500);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function waitForHttp(url, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.gkwatchSpawnError) throw child.gkwatchSpawnError;
        if (child.exitCode !== null) throw new Error(`Process exited before ${url} became ready.`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
            if (response.ok) return;
        } catch (_) {
            // Retry until the deadline while the child remains alive.
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`Timed out waiting for ${url}.`);
}

function exitReason(result) {
    return result.error?.message || result.signal || `code ${result.code}`;
}

async function waitForReadiness(url, child, exitPromises) {
    const earlyExit = Promise.race(exitPromises).then(result => {
        throw new Error(`A GK Watcher process exited during startup (${exitReason(result)}).`);
    });
    await Promise.race([waitForHttp(url, child), earlyExit]);
}

function spawnManaged(command, args, options) {
    const invocation = commandInvocation(command, args);
    return spawn(invocation.command, invocation.args, {
        ...options,
        stdio: 'inherit',
        detached: !IS_WINDOWS
    });
}

function terminateChild(child) {
    if (!child || child.exitCode !== null || child.killed) return;

    if (IS_WINDOWS) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
    }
}

function openUrl(url) {
    let command;
    let args;
    if (IS_WINDOWS) {
        command = process.env.ComSpec || 'cmd.exe';
        args = ['/d', '/s', '/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
}

async function startApplication(args) {
    checkNode();

    if (args.includes('--check')) {
        checkNpm();
        console.log('[OK] Start prerequisites passed.');
        return;
    }

    const requestedDev = args.includes('--dev');
    const requestedProduction = args.includes('--production');
    if (requestedDev && requestedProduction) throw new Error('Choose either --dev or --production, not both.');

    const mode = requestedDev ? 'dev' : requestedProduction ? 'production' : fs.existsSync(CLIENT_BUILD) ? 'production' : 'dev';
    const shouldOpen = args.includes('--open') || (IS_WINDOWS && !args.includes('--no-open'));

    if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
        throw new Error('Server dependencies are missing. Run the deploy or update script first.');
    }
    if (mode === 'production' && !fs.existsSync(CLIENT_BUILD)) {
        throw new Error('The production client build is missing. Run the deploy or update script first.');
    }
    if (mode === 'dev' && !fs.existsSync(path.join(CLIENT_DIR, 'node_modules'))) {
        throw new Error('Client dependencies are missing. Run the deploy or update script first.');
    }

    const ports = mode === 'dev' ? [3000, 5173] : [3000];
    for (const port of ports) {
        if (await isPortOpen(port)) throw new Error(`Port ${port} is already in use. Stop the existing process before starting GK Watcher.`);
    }

    console.log(`Starting GK Watcher in ${mode} mode...`);
    const children = [];
    const exitPromises = [];
    const manageChild = child => {
        children.push(child);
        exitPromises.push(new Promise(resolve => {
            child.once('exit', (code, signal) => resolve({ child, code, signal }));
            child.once('error', error => {
                child.gkwatchSpawnError = error;
                resolve({ child, error });
            });
        }));
        return child;
    };
    let cleaningUp = false;
    const cleanup = () => {
        if (cleaningUp) return;
        cleaningUp = true;
        for (const child of children) terminateChild(child);
    };

    const onSignal = signal => {
        console.log(`\nReceived ${signal}; stopping GK Watcher...`);
        cleanup();
        process.exitCode = 130;
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    try {
        const backend = manageChild(spawnManaged(process.execPath, ['server.js'], {
            cwd: SERVER_DIR,
            env: { ...process.env, NODE_ENV: mode === 'production' ? 'production' : 'development' }
        }));
        await waitForReadiness('http://127.0.0.1:3000/api/health', backend, exitPromises);

        let frontend = null;
        if (mode === 'dev') {
            frontend = manageChild(spawnManaged(npmCommand(), ['run', 'dev'], { cwd: CLIENT_DIR, env: process.env }));
            await waitForReadiness('http://127.0.0.1:5173', frontend, exitPromises);
        }

        const url = mode === 'production' ? 'http://localhost:3000' : 'http://localhost:5173';
        console.log(`GK Watcher is ready at ${url}`);
        if (shouldOpen) openUrl(url);

        const result = await Promise.race(exitPromises);
        if (!cleaningUp) {
            throw new Error(`A GK Watcher process exited unexpectedly (${exitReason(result)}).`);
        }
    } finally {
        cleanup();
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
    }
}

function usage() {
    console.log(`Usage: node scripts/gkwatch-tasks.mjs <command> [options]

Commands:
  doctor [--skip-browser]      Validate Node, npm, and browser prerequisites
  setup                         Install, audit, test, lint, and build
  install                       Install server and client dependencies
  verify                        Run audits, server tests, client lint, and client tests
  build                         Build the production client
  start [--dev|--production]   Start and supervise GK Watcher
`);
}

async function main(argv = process.argv.slice(2)) {
    const [command, ...args] = argv;
    switch (command) {
        case 'doctor':
            doctor({ checkBrowser: !args.includes('--skip-browser') });
            break;
        case 'setup':
            setup();
            break;
        case 'install':
            doctor();
            installDependencies();
            break;
        case 'verify':
            doctor({ checkBrowser: false });
            verify();
            break;
        case 'build':
            checkNode();
            checkNpm();
            buildClient();
            break;
        case 'start':
            await startApplication(args);
            break;
        default:
            usage();
            throw new Error(command ? `Unknown command: ${command}` : 'A command is required.');
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    main().catch(error => {
        console.error(`[ERROR] ${error.message}`);
        process.exitCode = 1;
    });
}
