'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.resolve(process.env.GKWATCH_DB_PATH || path.join(DATA_DIR, 'gkwatch.db'));
const BACKUP_DIR = path.resolve(process.env.GKWATCH_BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const MAGIC = Buffer.from('GKWATCH-BACKUP-V1\n', 'ascii');

function encryptionKey() {
    if (!process.env.GKWATCH_BACKUP_KEY) return null;
    const key = Buffer.from(process.env.GKWATCH_BACKUP_KEY, 'base64');
    if (key.length !== 32) throw new Error('GKWATCH_BACKUP_KEY must be a base64-encoded 32-byte key');
    return key;
}

function encryptFile(source, destination, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = fs.readFileSync(source);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const output = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
    fs.writeFileSync(destination, output, { mode: 0o600, flag: 'wx' });
}

function decryptFile(source, destination, key) {
    const input = fs.readFileSync(source);
    if (!input.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported encrypted backup format');
    const ivOffset = MAGIC.length;
    const tagOffset = ivOffset + 12;
    const dataOffset = tagOffset + 16;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, input.subarray(ivOffset, tagOffset));
    decipher.setAuthTag(input.subarray(tagOffset, dataOffset));
    const plaintext = Buffer.concat([decipher.update(input.subarray(dataOffset)), decipher.final()]);
    fs.writeFileSync(destination, plaintext, { mode: 0o600, flag: 'wx' });
}

function verifyDatabase(filePath) {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
        const row = db.pragma('integrity_check', { simple: true });
        if (row !== 'ok') throw new Error(`SQLite integrity check failed: ${row}`);
    } finally {
        db.close();
    }
}

function retentionDays() {
    const value = Number(process.env.GKWATCH_BACKUP_RETENTION_DAYS || 14);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
        throw new Error('GKWATCH_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650');
    }
    return value;
}

function pruneBackups(now = Date.now()) {
    const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !/^gkwatch-.*\.db(?:\.enc)?$/.test(entry.name)) continue;
        const filePath = path.join(BACKUP_DIR, entry.name);
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
}

async function createBackup() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(BACKUP_DIR, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const temporary = path.join(BACKUP_DIR, `.gkwatch-${process.pid}-${stamp}.tmp`);
    const key = encryptionKey();
    const destination = path.join(BACKUP_DIR, `gkwatch-${stamp}.db${key ? '.enc' : ''}`);
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    try {
        await db.backup(temporary);
    } finally {
        db.close();
    }

    try {
        fs.chmodSync(temporary, 0o600);
        verifyDatabase(temporary);
        if (key) {
            encryptFile(temporary, destination, key);
            fs.unlinkSync(temporary);
        } else {
            fs.renameSync(temporary, destination);
        }
        pruneBackups();
        return destination;
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        fs.rmSync(destination, { force: true });
        throw error;
    }
}

function verifyBackup(source) {
    const resolved = path.resolve(source);
    if (!resolved.endsWith('.enc')) {
        verifyDatabase(resolved);
        return;
    }

    const key = encryptionKey();
    if (!key) throw new Error('GKWATCH_BACKUP_KEY is required to verify encrypted backups');
    const temporary = path.join(os.tmpdir(), `gkwatch-verify-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
        decryptFile(resolved, temporary, key);
        verifyDatabase(temporary);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

async function main(argv) {
    if (argv[0] === '--verify') {
        if (!argv[1]) throw new Error('Usage: npm run backup:verify -- /path/to/backup.db[.enc]');
        verifyBackup(argv[1]);
        console.log('Backup integrity verified');
        return;
    }

    const destination = await createBackup();
    console.log(destination);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(error => {
        console.error(`Backup failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { createBackup, verifyBackup, verifyDatabase, pruneBackups };
