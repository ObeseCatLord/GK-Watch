
const request = require('supertest');
const app = require('../server');
const db = require('../models/database');

describe('Server Search API - Complex Filters', () => {
    let token;

    beforeAll(() => {
        // Setup a dummy session
        const stmt = db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)');
        token = 'test-token-search';
        stmt.run(token, Date.now() + 100000);
    });

    afterAll(() => {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    });

    test('should accept filters array in query', async () => {
        const res = await request(app)
            .get('/api/search')
            .query({ q: 'test', 'filters[]': ['exclude1', 'exclude2'] }) // Array format
            .set('x-auth-token', token);

        expect(res.statusCode).toBe(200);
        // We can't easily check internal arguments to scraper without mocking scraper.js 
        // closer to the route handler, but 200 OK implies it didn't crash on parsing.
    });

    test('should accept filters string in query', async () => {
        const res = await request(app)
            .get('/api/search')
            .query({ q: 'test', filters: 'exclude1,exclude2' }) // String format
            .set('x-auth-token', token);

        expect(res.statusCode).toBe(200);
    });
});
