
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../App';
import React from 'react';

// Mock child components to isolate App logic
vi.mock('../components/ResultCard', () => ({ default: () => <div>ResultCard</div> }));
vi.mock('../components/WatchlistManager', () => ({
    default: ({ authenticatedFetch }) => (
        <div>
            WatchlistManager
            <button
                type="button"
                onClick={() => authenticatedFetch('/api/results/watch-1/seen', { method: 'POST' }).catch(() => {})}
            >
                Open watch with new items
            </button>
        </div>
    )
}));
vi.mock('../components/BlockedManager', () => ({ default: () => <div>BlockedManager</div> }));
vi.mock('../components/OptionsManager', () => ({ default: () => <div>OptionsManager</div> }));
vi.mock('../components/Clock', () => ({ default: () => <div>Clock</div> }));

describe('App Regression Test', () => {
    let originalConsoleError;

    beforeAll(() => {
        originalConsoleError = console.error;
        // Suppress expected console errors during test (e.g. "Failed to load search history")
        console.error = vi.fn();

        globalThis.fetch = vi.fn();
    });

    beforeEach(() => {
        globalThis.fetch.mockReset();
        globalThis.fetch.mockImplementation(() => Promise.resolve({
            ok: true,
            status: 200,
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

    it('aborts the previous live stream when a new search starts', async () => {
        const searchSignals = [];
        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn()
        });
        globalThis.fetch.mockImplementation((url, options = {}) => {
            if (url === '/api/auth-status') {
                return Promise.resolve({ ok: true, json: async () => ({ loginRequired: false, authenticated: true }) });
            }
            if (String(url).startsWith('/api/search')) {
                searchSignals.push(options.signal);
                if (searchSignals.length > 1) {
                    return Promise.resolve({
                        ok: true,
                        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
                    });
                }
                return Promise.resolve({
                    ok: true,
                    body: {
                        getReader: () => ({
                            read: () => new Promise((resolve, reject) => {
                                options.signal.addEventListener('abort', () => {
                                    reject(new DOMException('Aborted', 'AbortError'));
                                }, { once: true });
                            })
                        })
                    }
                });
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        render(<App />);
        await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
        fireEvent.click(screen.getByText('Live Search'));

        const input = await screen.findByPlaceholderText(/Search for resin crack/);
        fireEvent.change(input, { target: { value: 'first search' } });
        fireEvent.submit(input.closest('form'));
        await waitFor(() => expect(searchSignals).toHaveLength(1));

        fireEvent.change(input, { target: { value: 'second search' } });
        fireEvent.submit(input.closest('form'));

        await waitFor(() => expect(searchSignals).toHaveLength(2));
        expect(searchSignals[0].aborted).toBe(true);
        expect(searchSignals[1].aborted).toBe(false);
        vi.unstubAllGlobals();
    });

    it('keeps the current session and view when a write is forbidden', async () => {
        globalThis.fetch.mockImplementation((url) => {
            if (url === '/api/auth-status') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ loginRequired: true, authenticated: true })
                });
            }
            if (url === '/api/results/watch-1/seen') {
                return Promise.resolve({
                    ok: false,
                    status: 403,
                    json: async () => ({ error: 'Cross-origin request denied' })
                });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open watch with new items' }));

        await waitFor(() => {
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/api/results/watch-1/seen',
                expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
            );
        });
        expect(screen.getByText('WatchlistManager')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
    });

    it('shows the login screen when an authenticated request returns 401', async () => {
        globalThis.fetch.mockImplementation((url) => {
            if (url === '/api/auth-status') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ loginRequired: true, authenticated: true })
                });
            }
            if (url === '/api/results/watch-1/seen') {
                return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open watch with new items' }));

        expect(await screen.findByPlaceholderText('Password')).toBeInTheDocument();
    });

    it.each(['/api/taobao/status', '/api/goofish/status'])(
        'does not clear the session when the startup probe %s is forbidden',
        async (forbiddenUrl) => {
            globalThis.fetch.mockImplementation((url) => {
                if (url === '/api/auth-status') {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({ loginRequired: true, authenticated: true })
                    });
                }
                if (url === forbiddenUrl) {
                    return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
                }
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });

            render(<App />);

            expect(await screen.findByText('WatchlistManager')).toBeInTheDocument();
            expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
        }
    );
});
