
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import WatchlistManager from '../components/WatchlistManager';
import React from 'react';

// Mock child components
vi.mock('../components/ResultCard', () => ({ default: () => <div>ResultCard</div> }));

describe('WatchlistManager Crash Regression', () => {
    let originalConsoleError;

    beforeAll(() => {
        originalConsoleError = console.error;
        // Suppress expected errors from React boundary or fetch failures
        console.error = vi.fn();
    });

    afterAll(() => {
        console.error = originalConsoleError;
    });

    it('handles ECONNREFUSED/network error gracefully without crashing', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

        await act(async () => {
            render(
                <WatchlistManager
                    authenticatedFetch={mockFetch}
                    onBlock={vi.fn()}
                    taobaoEnabled={false}
                    goofishEnabled={false}
                    handleExportClipboard={vi.fn()}
                />
            );
        });

        // Should render even empty
        expect(screen.getByText(/No items in watchlist/i)).toBeInTheDocument();
    });

    it('handles null/undefined data from API gracefully', async () => {
        const mockFetch = vi.fn((url) => {
            if (url.includes('/api/watchlist')) {
                return Promise.resolve({
                    json: () => Promise.resolve(null)
                });
            }
            if (url.includes('/api/settings')) {
                return Promise.resolve({
                    json: () => Promise.resolve(null)
                });
            }
            if (url.includes('/api/watchlist/newcounts')) {
                return Promise.resolve({
                    json: () => Promise.resolve(null)
                });
            }
            return Promise.resolve({
                json: () => Promise.resolve({})
            });
        });

        await act(async () => {
            render(
                <WatchlistManager
                    authenticatedFetch={mockFetch}
                    onBlock={vi.fn()}
                    taobaoEnabled={false}
                    goofishEnabled={false}
                    handleExportClipboard={vi.fn()}
                />
            );
        });

        expect(screen.getByText(/No items in watchlist/i)).toBeInTheDocument();
    });
});
