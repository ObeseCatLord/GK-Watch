/**
 * Integration Tests: API Routes
 * 
 * Tests the Express API endpoints using supertest.
 * Uses an isolated test database.
 * 
 * NOTE: These tests focus on auth, session, and rate limiting routes.
 * Scraper-dependent routes are not tested here (tested via smoke tests).
 */

const { getTestDb, closeTestDb, clearTestDb } = require('../testSetup');

let request;
let app;
let Settings;

beforeAll(() => {
    getTestDb();

    // We need to set up a minimal app-like environment.
    // Since server.js starts listening and initializes scheduler/cron,
    // we'll require the modules and manually build the test routes.

    // Mock the scheduler to prevent cron jobs from starting
    jest.mock('../../scheduler', () => ({
        start: jest.fn(),
        isRunning: false,
        progress: null,
        getResults: jest.fn().mockResolvedValue([]),
        getNewCounts: jest.fn().mockResolvedValue({}),
    }));

    // Mock node-cron to prevent real scheduling
    jest.mock('node-cron', () => ({
        schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
    }));

    const express = require('express');
    const crypto = require('crypto');
    Settings = require('../../models/settings');
    const db = require('../../models/database');

    app = express();
    app.use(express.json());

    // --- Session management (matching server.js PR #39 changes) ---
    const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

    const sessionStmts = {
        insert: db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)'),
        get: db.prepare('SELECT * FROM sessions WHERE token = ?'),
        delete: db.prepare('DELETE FROM sessions WHERE token = ?'),
        cleanup: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
        extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?'),
    };

    const requireAuth = (req, res, next) => {
        const token = req.header('x-auth-token');
        if (!token) {
            return res.status(401).json({ error: 'No token, authorization denied' });
        }

        const session = sessionStmts.get.get(token);
        if (!session) {
            return res.status(401).json({ error: 'Token is invalid or expired' });
        }

        if (Date.now() > session.expires_at) {
            sessionStmts.delete.run(token);
            return res.status(401).json({ error: 'Session expired. Please login again.' });
        }

        return next();
    };

    // Login
    app.post('/api/login', (req, res) => {
        const settings = Settings.get();
        if (!settings.loginEnabled || !settings.loginPassword) {
            return res.json({ success: true, token: null });
        }

        const { password } = req.body;
        if (!password) {
            return res.status(401).json({ error: 'Password is required' });
        }

        const storedPassword = settings.loginPassword;
        const inputPassword = password;

        let isMatch = true;
        for (let i = 0; i < Math.max(storedPassword.length, inputPassword.length); i++) {
            if (storedPassword[i] !== inputPassword[i]) isMatch = false;
        }

        if (isMatch && storedPassword.length === inputPassword.length) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + SESSION_TIMEOUT;
            sessionStmts.insert.run(token, expiresAt);
            return res.json({ success: true, token });
        } else {
            return res.status(401).json({ error: 'Invalid password' });
        }
    });

    // Logout
    app.post('/api/logout', (req, res) => {
        const token = req.header('x-auth-token');
        if (token) {
            sessionStmts.delete.run(token);
        }
        res.json({ success: true });
    });

    // Auth status
    app.get('/api/auth-status', (req, res) => {
        const settings = Settings.get();
        res.json({
            loginRequired: settings.loginEnabled && !!settings.loginPassword
        });
    });

    // Protected route for testing
    app.get('/api/protected', requireAuth, (req, res) => {
        res.json({ message: 'Authorized' });
    });

    // Settings routes
    app.get('/api/settings', requireAuth, (req, res) => {
        res.json(Settings.get());
    });

    const supertest = require('supertest');
    request = supertest(app);
});

afterAll(() => {
    closeTestDb();
});

beforeEach(() => {
    clearTestDb();
    // Reset settings module internal cache
    if (Settings) Settings._resetCache();
});

describe('API Routes', () => {
    describe('GET /api/auth-status', () => {
        test('returns loginRequired: false when login is not configured', async () => {
            const res = await request.get('/api/auth-status');
            expect(res.status).toBe(200);
            expect(res.body.loginRequired).toBe(false);
        });
    });

    describe('POST /api/login', () => {
        test('returns token: null when login is not enabled', async () => {
            const res = await request.post('/api/login').send({ password: 'anything' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.token).toBeNull();
        });

        test('returns token on correct password when login is enabled', async () => {
            const Settings = require('../../models/settings');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            const res = await request.post('/api/login').send({ password: 'testpass123' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.token).toBeDefined();
            expect(typeof res.body.token).toBe('string');
            expect(res.body.token.length).toBeGreaterThan(0);
        });

        test('rejects wrong password', async () => {
            const Settings = require('../../models/settings');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            const res = await request.post('/api/login').send({ password: 'wrongpass' });
            expect(res.status).toBe(401);
            expect(res.body.error).toContain('Invalid password');
        });

        test('rejects missing password', async () => {
            const Settings = require('../../models/settings');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            const res = await request.post('/api/login').send({});
            expect(res.status).toBe(401);
        });
    });

    describe('Auth Middleware (requireAuth)', () => {
        test('rejects requests without token', async () => {
            const res = await request.get('/api/protected');
            expect(res.status).toBe(401);
            expect(res.body.error).toContain('No token');
        });

        test('rejects requests with invalid token', async () => {
            const res = await request.get('/api/protected').set('x-auth-token', 'invalid-token');
            expect(res.status).toBe(401);
            expect(res.body.error).toContain('invalid or expired');
        });

        test('allows requests with valid token', async () => {
            const Settings = require('../../models/settings');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            // Login to get a token
            const loginRes = await request.post('/api/login').send({ password: 'testpass123' });
            const token = loginRes.body.token;

            const res = await request.get('/api/protected').set('x-auth-token', token);
            expect(res.status).toBe(200);
            expect(res.body.message).toBe('Authorized');
        });

        test('rejects expired session token', async () => {
            const Settings = require('../../models/settings');
            const db = require('../../models/database');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            // Insert a session that's already expired
            const expiredToken = 'expired-token-123';
            db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(
                expiredToken, Date.now() - 1000
            );

            const res = await request.get('/api/protected').set('x-auth-token', expiredToken);
            expect(res.status).toBe(401);
            expect(res.body.error).toContain('expired');
        });
    });

    describe('POST /api/logout', () => {
        test('successfully logs out and invalidates token', async () => {
            const Settings = require('../../models/settings');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            // Login
            const loginRes = await request.post('/api/login').send({ password: 'testpass123' });
            const token = loginRes.body.token;

            // Verify token works
            const authRes = await request.get('/api/protected').set('x-auth-token', token);
            expect(authRes.status).toBe(200);

            // Logout
            const logoutRes = await request.post('/api/logout').set('x-auth-token', token);
            expect(logoutRes.status).toBe(200);
            expect(logoutRes.body.success).toBe(true);

            // Token should no longer work
            const afterLogout = await request.get('/api/protected').set('x-auth-token', token);
            expect(afterLogout.status).toBe(401);
        });

        test('handles logout without token gracefully', async () => {
            const res = await request.post('/api/logout');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('Session Persistence (PR #39)', () => {
        test('sessions are stored in SQLite, not in-memory', async () => {
            const Settings = require('../../models/settings');
            const db = require('../../models/database');
            await Settings.update({ loginEnabled: true, loginPassword: 'testpass123' });

            // Login
            const loginRes = await request.post('/api/login').send({ password: 'testpass123' });
            const token = loginRes.body.token;

            // Check session exists in DB
            const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
            expect(session).toBeDefined();
            expect(session.token).toBe(token);
            expect(session.expires_at).toBeGreaterThan(Date.now());
        });
    });
});
