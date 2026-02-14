module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/__tests__/**/*.test.js'],
    // Force exit after tests complete (handles open handles from better-sqlite3)
    forceExit: true,
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

