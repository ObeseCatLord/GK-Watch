
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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

    afterEach(() => {
        vi.useRealTimers();
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

    it('loads each startup resource only once', async () => {
        const mockFetch = vi.fn((url) => Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url === '/api/watchlist' ? [] : {})
        }));

        render(
            <WatchlistManager
                authenticatedFetch={mockFetch}
                onBlock={vi.fn()}
                taobaoEnabled={false}
                goofishEnabled={false}
                handleExportClipboard={vi.fn()}
            />
        );

        await waitFor(() => {
            expect(mockFetch).toHaveBeenCalledWith('/api/settings');
        });

        expect(mockFetch.mock.calls.filter(([url]) => url === '/api/watchlist')).toHaveLength(1);
        expect(mockFetch.mock.calls.filter(([url]) => url === '/api/watchlist/newcounts')).toHaveLength(1);
    });

    it('refreshes after a scheduler run that starts and finishes between polls', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        const mockFetch = vi.fn((url) => {
            if (url === '/api/status') {
                statusCalls += 1;
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        isRunning: false,
                        completionVersion: statusCalls - 1
                    })
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(url === '/api/watchlist' ? [] : {})
            });
        });

        render(
            <WatchlistManager
                authenticatedFetch={mockFetch}
                onBlock={vi.fn()}
                taobaoEnabled={false}
                goofishEnabled={false}
                handleExportClipboard={vi.fn()}
            />
        );

        await act(async () => {});
        const initialWatchlistCalls = mockFetch.mock.calls.filter(([url]) => url === '/api/watchlist').length;

        await act(async () => {
            vi.advanceTimersByTime(15000);
        });

        expect(statusCalls).toBe(2);
        expect(mockFetch.mock.calls.filter(([url]) => url === '/api/watchlist')).toHaveLength(initialWatchlistCalls + 1);
        expect(mockFetch.mock.calls.filter(([url]) => url === '/api/watchlist/newcounts')).toHaveLength(2);
    });

    it('aborts a stalled status request and retries promptly', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        const mockFetch = vi.fn((url, options = {}) => {
            if (url === '/api/status') {
                statusCalls += 1;
                if (statusCalls === 1) {
                    return new Promise((resolve, reject) => {
                        options.signal.addEventListener('abort', () => {
                            reject(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ isRunning: false, completionVersion: 0 })
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(url === '/api/watchlist' ? [] : {})
            });
        });

        render(
            <WatchlistManager
                authenticatedFetch={mockFetch}
                onBlock={vi.fn()}
                taobaoEnabled={false}
                goofishEnabled={false}
                handleExportClipboard={vi.fn()}
            />
        );

        await act(async () => {});
        await act(async () => {
            vi.advanceTimersByTime(5000);
        });
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(statusCalls).toBe(2);
    });

    it('aborts an active status request when unmounted', async () => {
        vi.useFakeTimers();
        let statusCalls = 0;
        let statusAborted = false;
        const mockFetch = vi.fn((url, options = {}) => {
            if (url === '/api/status') {
                statusCalls += 1;
                return new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        statusAborted = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(url === '/api/watchlist' ? [] : {})
            });
        });

        const { unmount } = render(
            <WatchlistManager
                authenticatedFetch={mockFetch}
                onBlock={vi.fn()}
                taobaoEnabled={false}
                goofishEnabled={false}
                handleExportClipboard={vi.fn()}
            />
        );

        await act(async () => {});
        unmount();
        await act(async () => {});
        vi.advanceTimersByTime(10000);

        expect(statusAborted).toBe(true);
        expect(statusCalls).toBe(1);
    });
});
