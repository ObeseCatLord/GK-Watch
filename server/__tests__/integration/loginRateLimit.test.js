const request = require('supertest');
const app = require('../../server'); // Adjust path as needed

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

        for (let i = 0; i < limit; i++) {
            // Using a dummy password to fail auth but trigger rate limit
            promises.push(request(app).post('/api/login').send({ password: 'wrongpassword' }));
        }

        await Promise.all(promises);

        // The 11th request should fail with rate limit error
        const response = await request(app).post('/api/login').send({ password: 'wrongpassword' });

        expect(response.status).toBe(429);
        // Default error from express-rate-limit or our custom message
        expect(response.body).toHaveProperty('error', 'Too many login attempts, please try again after 5 minutes.');
    });
});
