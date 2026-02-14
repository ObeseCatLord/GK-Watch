
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest'; // wait, need jest-dom?

// Testing Library automatically cleans up after each test if using proper import
// but explicit cleanup is good practice if needed.
afterEach(() => {
    cleanup();
});
