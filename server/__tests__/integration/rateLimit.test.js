const request = require('supertest');
const http = require('http');
process.env.GKWATCH_API_RATE_LIMIT = '20';
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
        delete process.env.GKWATCH_API_RATE_LIMIT;
        if (!server) return;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    it('should return 429 after exceeding rate limit', async () => {
        const limit = 20;

        for (let i = 0; i < limit; i++) {
            const response = await request(server).get('/api/auth-status');
            expect(response.status).toBe(200);
        }

        const response = await request(server).get('/api/auth-status');

        expect(response.status).toBe(429);
        expect(response.body).toHaveProperty('error', 'Too many requests, please try again later.');
    });
});
