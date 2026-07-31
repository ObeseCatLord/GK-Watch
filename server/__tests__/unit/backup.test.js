'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const BASELINE_ENV = { ...process.env };
const MAGICK_LENGTH = Buffer.from('GKWATCH-BACKUP-V1\n', 'ascii').length;

function createFixtureDb(filePath) {
    const db = new Database(filePath);
    db.exec('CREATE TABLE backup_test (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO backup_test(value) VALUES (\'ok\')');
    db.close();
}

function restoreEnvironment() {
    for (const key of Object.keys(process.env)) {
        if (Object.prototype.hasOwnProperty.call(BASELINE_ENV, key)) {
            process.env[key] = BASELINE_ENV[key];
        } else {
            delete process.env[key];
        }
    }
}

function loadBackupModule({ dbPath, backupDir, retentionDays, backupKey }) {
    process.env.GKWATCH_DB_PATH = dbPath;
    process.env.GKWATCH_BACKUP_DIR = backupDir;

    if (typeof retentionDays === 'number') {
        process.env.GKWATCH_BACKUP_RETENTION_DAYS = String(retentionDays);
    } else {
        delete process.env.GKWATCH_BACKUP_RETENTION_DAYS;
    }

    if (typeof backupKey === 'string') {
        process.env.GKWATCH_BACKUP_KEY = backupKey;
    } else {
        delete process.env.GKWATCH_BACKUP_KEY;
    }

    jest.resetModules();
    return require('../../utils/backup');
}

function setFileMtime(filePath, whenMs) {
    const seconds = Math.floor(whenMs / 1000);
    fs.utimesSync(filePath, seconds, seconds);
}

describe('backup module operational security', () => {
    let workspace;
    let dbPath;
    let backupDir;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gkwatch-backup-'));
        dbPath = path.join(workspace, 'source.db');
        backupDir = path.join(workspace, 'backups');
        createFixtureDb(dbPath);
    });

    afterEach(() => {
        restoreEnvironment();
        if (workspace && fs.existsSync(workspace)) {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    test('verifies plaintext backups created by createBackup', async () => {
        const backup = loadBackupModule({ dbPath, backupDir });
        const destination = await backup.createBackup();

        expect(destination.endsWith('.db')).toBe(true);
        expect(fs.existsSync(destination)).toBe(true);
        expect(() => backup.verifyBackup(destination)).not.toThrow();
    });

    test('verifies encrypted backups created with a valid key', async () => {
        const key = crypto.randomBytes(32).toString('base64');
        const backup = loadBackupModule({ dbPath, backupDir, backupKey: key });
        const destination = await backup.createBackup();

        expect(destination.endsWith('.db.enc')).toBe(true);
        const header = fs.readFileSync(destination);
        expect(header.subarray(0, MAGICK_LENGTH).toString('ascii')).toBe('GKWATCH-BACKUP-V1\n');
        expect(() => backup.verifyBackup(destination)).not.toThrow();
    });

    test('rejects tampered encrypted backup data', async () => {
        const key = crypto.randomBytes(32).toString('base64');
        const backup = loadBackupModule({ dbPath, backupDir, backupKey: key });
        const destination = await backup.createBackup();
        const raw = fs.readFileSync(destination);

        raw[raw.length - 1] ^= 0xff;
        fs.writeFileSync(destination, raw);

        expect(() => backup.verifyBackup(destination)).toThrow();
    });

    test('rejects encrypted backup verification with wrong key', async () => {
        const correctKey = crypto.randomBytes(32).toString('base64');
        const backup = loadBackupModule({ dbPath, backupDir, backupKey: correctKey });
        const destination = await backup.createBackup();
        const wrongKey = crypto.randomBytes(32).toString('base64');
        const verifyWithoutKey = loadBackupModule({ dbPath, backupDir, backupKey: wrongKey });

        expect(() => verifyWithoutKey.verifyBackup(destination)).toThrow();
    });

    test('pruneBackups removes only aged backups and ignores non-candidates', () => {
        const backup = loadBackupModule({ dbPath, backupDir });
        fs.mkdirSync(backupDir, { recursive: true });
        const now = Date.now();
        const retentionDays = 14;

        const retained = path.join(backupDir, 'gkwatch-retain.db');
        const expired = path.join(backupDir, 'gkwatch-expire.db.enc');
        const ignored = path.join(backupDir, 'notes.txt');
        fs.writeFileSync(retained, 'ok');
        fs.writeFileSync(expired, 'expired');
        fs.writeFileSync(ignored, 'ignore');

        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        setFileMtime(retained, cutoff + 60_000);
        setFileMtime(expired, cutoff - 60_000);
        setFileMtime(ignored, cutoff - 60_000);

        backup.pruneBackups(now);

        expect(fs.existsSync(retained)).toBe(true);
        expect(fs.existsSync(ignored)).toBe(true);
        expect(fs.existsSync(expired)).toBe(false);
    });
});
