
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../App';
import React from 'react';

// Mock child components to isolate App logic
vi.mock('../components/ResultCard', () => ({ default: () => <div>ResultCard</div> }));
vi.mock('../components/WatchlistManager', () => ({ default: () => <div>WatchlistManager</div> }));
vi.mock('../components/BlockedManager', () => ({ default: () => <div>BlockedManager</div> }));
vi.mock('../components/OptionsManager', () => ({ default: () => <div>OptionsManager</div> }));
vi.mock('../components/Clock', () => ({ default: () => <div>Clock</div> }));

describe('App Regression Test', () => {
    let originalConsoleError;

    beforeAll(() => {
        originalConsoleError = console.error;
        // Suppress expected console errors during test (e.g. "Failed to load search history")
        console.error = vi.fn();

        // Mock fetch globally
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({})
        }));
    });

    afterAll(() => {
        console.error = originalConsoleError;
        vi.restoreAllMocks();
    });

    it('should NOT crash when localStorage contains non-array search history and Search view is active', async () => {
        // Mock localStorage using Storage.prototype
        const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
        getItemSpy.mockImplementation((key) => {
            if (key === 'gkwatch_search_history') {
                return JSON.stringify("corrupted-string"); // Simulates corrupted data
            }
            return null;
        });

        // Render App
        render(<App />);

        // Wait for loading to finish
        await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

        // Switch to Live Search view
        const searchButton = screen.getByText('Live Search');
        fireEvent.click(searchButton);

        // Verify that it rendered correctly (e.g. search input is present)
        // If it crashed, this assertion will fail or the test will terminate.
        expect(await screen.findByPlaceholderText(/Search for resin crack/)).toBeInTheDocument();

        // Also verify that the error message is NOT present (in case ErrorBoundary caught it and showed "Something went wrong")
        expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
        expect(screen.queryByText(/map is not a function/)).not.toBeInTheDocument();

        getItemSpy.mockRestore();
    });
});
