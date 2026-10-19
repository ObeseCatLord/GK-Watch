module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/__tests__/setupPuppeteer.js'],
    testMatch: ['<rootDir>/__tests__/**/*.test.js'],
    // Detect open handles for debugging
    detectOpenHandles: true,
    // Increase timeout for integration tests
    testTimeout: 15000,
    // Coverage configuration
    collectCoverageFrom: [
        'utils/**/*.js',
        'models/**/*.js',
        '!models/database.js',
    ],
    coverageDirectory: 'coverage',
};
