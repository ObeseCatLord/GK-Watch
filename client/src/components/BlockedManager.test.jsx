import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BlockedManager from './BlockedManager';

describe('BlockedManager', () => {
    const authenticatedFetch = vi.fn();

    beforeEach(() => {
        vi.restoreAllMocks();
        authenticatedFetch.mockReset();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
    });

    it('clears blocked items missing from stored results and refreshes the list', async () => {
        let blockedReads = 0;
        authenticatedFetch.mockImplementation((url, options = {}) => {
            if (url === '/api/blocked' && !options.method) {
                blockedReads += 1;
                return Promise.resolve({
                    ok: true,
                    json: async () => blockedReads === 1
                        ? [{ id: 'blocked-1', url: 'https://example.test/missing', title: 'Missing Item', isMissing: true }]
                        : []
                });
            }
            if (url === '/api/blocked/clear-missing' && options.method === 'POST') {
                return Promise.resolve({ ok: true, json: async () => ({ success: true, removed: 1 }) });
            }
            if (url === '/api/favorites') {
                return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url === '/api/blacklist') {
                return Promise.resolve({ ok: true, json: async () => [] });
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        render(<BlockedManager authenticatedFetch={authenticatedFetch} />);

        fireEvent.click(screen.getByRole('tab', { name: 'Blocked Items' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Clear Missing' }));

        await waitFor(() => {
            expect(authenticatedFetch).toHaveBeenCalledWith('/api/blocked/clear-missing', { method: 'POST' });
            expect(screen.getByText('Cleared 1 item.')).toBeInTheDocument();
        });
        expect(window.confirm).toHaveBeenCalledWith(
            'Unblock items confirmed missing by tracked watch searches?'
        );
        expect(await screen.findByText('No blocked items.')).toBeInTheDocument();
    });

    it('reports a failed cleanup without clearing the displayed list', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        authenticatedFetch.mockImplementation((url, options = {}) => {
            if (url === '/api/blocked' && !options.method) {
                return Promise.resolve({
                    ok: true,
                    json: async () => [
                        { id: 'blocked-1', url: 'https://example.test/still-blocked', title: 'Still Blocked', isMissing: true }
                    ]
                });
            }
            if (url === '/api/blocked/clear-missing' && options.method === 'POST') {
                return Promise.resolve({
                    ok: false,
                    status: 500,
                    json: async () => ({ error: 'Cleanup failed' })
                });
            }
            if (url === '/api/favorites' || url === '/api/blacklist') {
                return Promise.resolve({ ok: true, json: async () => [] });
            }
            return Promise.resolve({ ok: true, json: async () => ({}) });
        });

        render(<BlockedManager authenticatedFetch={authenticatedFetch} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Blocked Items' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Clear Missing' }));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Could not clear missing items.');
        });
        expect(screen.getByText('Still Blocked')).toBeInTheDocument();
        expect(authenticatedFetch.mock.calls.filter(([url]) => url === '/api/blocked')).toHaveLength(1);
    });
});
