const request = require('supertest');
const app = require('../../server'); // Adjust path as needed based on where this file is placed relative to server.js

describe('Rate Limiting Integration Test', () => {
    it('should return 429 after exceeding rate limit', async () => {
        // Send 1001 requests to exceed the limit of 1000
        const limit = 1000;
        const promises = [];

        // We use a lightweight endpoint that doesn't require auth for rate limit checking if possible,
        // but our rate limiter is on /api/, so we can hit /api/auth-status which is public.
        for (let i = 0; i < limit; i++) {
            promises.push(request(app).get('/api/auth-status'));
        }

        await Promise.all(promises);

        // The 101st request should fail
        const response = await request(app).get('/api/auth-status');

        expect(response.status).toBe(429);
        expect(response.body).toHaveProperty('error', 'Too many requests, please try again later.');
    });
});
