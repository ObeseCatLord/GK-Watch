const request = require('supertest');
const http = require('http');
const app = require('../../server');

describe('Rate Limiting Integration Test', () => {
    let server;

    beforeAll(async () => {
        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    });

    afterAll(async () => {
        if (!server) return;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    it('should return 429 after exceeding rate limit', async () => {
        // Send 1001 requests to exceed the limit of 1000
        const limit = 1000;
        const promises = [];

        // We use a lightweight endpoint that doesn't require auth for rate limit checking if possible,
        // but our rate limiter is on /api/, so we can hit /api/auth-status which is public.
        for (let i = 0; i < limit; i++) {
            promises.push(request(server).get('/api/auth-status'));
        }

        await Promise.all(promises);

        const response = await request(server).get('/api/auth-status');

        expect(response.status).toBe(429);
        expect(response.body).toHaveProperty('error', 'Too many requests, please try again later.');
    });
});
