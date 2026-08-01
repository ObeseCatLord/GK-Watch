const request = require('supertest');
const { getTestDb, closeTestDb } = require('../testSetup');

let app;
const password = 'rate-limit-password-123';

beforeAll(async () => {
    getTestDb();
    app = require('../../server');
    const Settings = require('../../models/settings');
    await Settings.update({ loginEnabled: true, loginPassword: password });
});

afterAll(() => closeTestDb());

describe('Login Rate Limiting Integration Test', () => {
    // Increase timeout since we might need to send multiple requests
    jest.setTimeout(30000);

    it('should return 429 after exceeding login rate limit', async () => {
        const limit = 10;
        const promises = [];

        // We need to use DIFFERENT IPs or mock IP/reset limit between tests if running multiple tests on same instance.
        // Supertest usually uses same IP.
        // We will send 11 requests.

        // Note: Global limit is 1000, but login limit is 10.
        // We expect the 11th request to fail with 429 AND specific message.

        const clientIp = '198.51.100.77';
        for (let i = 0; i < limit; i++) {
            // Using a dummy password to fail auth but trigger rate limit
            promises.push(request(app).post('/api/login').set('X-Forwarded-For', clientIp).send({ password: 'wrongpassword' }));
        }

        await Promise.all(promises);

        // The 11th request should fail with rate limit error
        const response = await request(app).post('/api/login').set('X-Forwarded-For', clientIp).send({ password: 'wrongpassword' });

        expect(response.status).toBe(429);
        // Default error from express-rate-limit or our custom message
        expect(response.body).toHaveProperty('error', 'Too many login attempts, please try again after 5 minutes.');
    });

    it('keeps a distinct proxied client outside another client rate-limit bucket', async () => {
        const response = await request(app).post('/api/login').set('X-Forwarded-For', '198.51.100.78').send({ password: 'wrongpassword' });
        expect(response.status).not.toBe(429);
    });

    it('does not consume the failed-attempt budget for successful logins', async () => {
        for (let i = 0; i < 11; i++) {
            const response = await request(app).post('/api/login').set('X-Forwarded-For', '198.51.100.79').send({ password });
            expect(response.status).toBe(200);
        }
    });

    it('uses an HttpOnly same-site cookie and enforces same-origin writes', async () => {
        const agent = request.agent(app);
        const login = await agent.post('/api/login').send({ password });
        expect(login.status).toBe(200);
        expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
        expect(login.headers['set-cookie'][0]).toContain('SameSite=Strict');

        const authStatus = await agent.get('/api/auth-status');
        expect(authStatus.body).toMatchObject({ loginRequired: true, authenticated: true });
        expect((await agent.get('/api/settings')).status).toBe(200);
        expect((await agent.post('/api/settings').send({ concurrency: 3 })).status).toBe(403);

        const allowedWrite = await agent.post('/api/settings')
            .set('Host', '127.0.0.1:5173')
            .set('Origin', 'http://127.0.0.1:5173')
            .send({ concurrency: 3 });
        expect(allowedWrite.status).toBe(200);

        const proxiedHttpsWrite = await agent.post('/api/settings')
            .set('Host', 'gkwatch.example.test')
            .set('Origin', 'https://gkwatch.example.test')
            .set('X-Forwarded-Proto', 'https')
            .send({ concurrency: 4 });
        expect(proxiedHttpsWrite.status).toBe(200);

        const mismatchedOriginWrite = await agent.post('/api/settings')
            .set('Host', 'gkwatch.example.test')
            .set('Origin', 'https://attacker.example.test')
            .set('X-Forwarded-Proto', 'https')
            .send({ concurrency: 5 });
        expect(mismatchedOriginWrite.status).toBe(403);

        expect((await request(app).post('/api/blocked/clear-missing')).status).toBe(401);
        expect((await request(app).get('/api/yahoo/status')).status).toBe(401);
        expect((await request(app).post('/api/cookies/yahoo').send({ cookies: [] })).status).toBe(401);
        const allowedBlockedCleanup = await agent.post('/api/blocked/clear-missing')
            .set('Host', 'gkwatch.example.test')
            .set('Origin', 'https://gkwatch.example.test')
            .set('X-Forwarded-Proto', 'https');
        expect(allowedBlockedCleanup.status).toBe(200);
        expect(allowedBlockedCleanup.body).toEqual({ success: true, removed: 0 });
    });
});
