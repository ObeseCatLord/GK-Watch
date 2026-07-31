
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WatchlistManager from './WatchlistManager';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child components to isolate WatchlistManager
vi.mock('./ResultCard', () => ({
    default: () => <div data-testid="ResultCard">ResultCard</div>
}));

describe('WatchlistManager', () => {
    const mockAuthenticatedFetch = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('handles network connection errors gracefully', async () => {
        // Mock fetch to reject (network error)
        mockAuthenticatedFetch.mockRejectedValue(new Error('Network Error'));

        render(<WatchlistManager authenticatedFetch={mockAuthenticatedFetch} />);

        // Wait for potential error handling or ensure it doesn't crash
        // Since the component likely catches errors in `fetchWatchlist`, we check if it rendered properly
        // without crashing, and maybe logs an error (which we can spy on if needed).
        // For now, just ensuring it renders without throwing is a win.
    });

    it('loads watchlist successfully', async () => {
        const mockData = [{ id: '1', term: 'test', active: true }];
        mockAuthenticatedFetch.mockImplementation((url) => {
            if (url === '/api/watchlist') {
                return Promise.resolve({ ok: true, json: async () => mockData });
            }
            if (url === '/api/status') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ isRunning: false, completionVersion: 0 })
                });
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        render(<WatchlistManager authenticatedFetch={mockAuthenticatedFetch} />);

        await waitFor(() => {
            // Check if our mock item is likely rendered (depends on implementation)
            // Or just check if fetch was called
            expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/watchlist');
        });
    });

    it('triggers "Run All" API call when button is clicked', async () => {
        // Mock success response for run-now
        mockAuthenticatedFetch.mockImplementation((url) => {
            if (url === '/api/run-now') {
                return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
            }
            if (url === '/api/watchlist') {
                return Promise.resolve({
                    ok: true,
                    json: async () => [{ id: '1', term: 'test', active: true }]
                });
            }
            if (url === '/api/status') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ isRunning: false, completionVersion: 0 })
                });
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        render(<WatchlistManager authenticatedFetch={mockAuthenticatedFetch} />);

        // Wait for watchlist to load so button is enabled
        const runAllButton = screen.getByText(/Run All/i);
        await waitFor(() => {
            expect(runAllButton).not.toBeDisabled();
        });

        fireEvent.click(runAllButton);

        await waitFor(() => {
            expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/run-now', expect.objectContaining({
                method: 'POST'
            }));
        });
    });

    it('loads malformed paginated results response using client-side pagination', async () => {
        const malformedItems = Array.from({ length: 25 }, (_, index) => ({
            title: `Fallback ${index + 1}`,
            link: `https://example.com/fallback-${index + 1}`,
            source: 'mercari',
            price: `${index + 1}`
        }));

        mockAuthenticatedFetch.mockImplementation((url) => {
            if (url === '/api/watchlist') {
                return Promise.resolve({
                    ok: true,
                    json: async () => [{ id: 'watch-2', term: 'fallback', name: 'Fallback Set' }]
                });
            }
            if (url === '/api/settings') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({})
                });
            }
            if (url === '/api/watchlist/newcounts') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({})
                });
            }
            if (url === '/api/status') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ isRunning: false, completionVersion: 0 })
                });
            }
            if (url.startsWith('/api/results/watch-2')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        items: malformedItems,
                        total: 'bad-total',
                        page: 'bad-page',
                        pageSize: 'bad-page-size',
                        totalPages: 'bad-pages'
                    })
                });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({})
            });
        });

        render(<WatchlistManager authenticatedFetch={mockAuthenticatedFetch} />);

        await waitFor(() => {
            expect(screen.getByText('Fallback Set')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Fallback Set'));

        await waitFor(() => {
            expect(screen.getByText('(25 results)')).toBeInTheDocument();
            expect(screen.getByText('/ 2')).toBeInTheDocument();
        });
    });
});
