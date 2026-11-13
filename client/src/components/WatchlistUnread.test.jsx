import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WatchlistManager from './WatchlistManager';

const makeItem = (title, flags = {}) => ({
    title, link: `https://example.test/${encodeURIComponent(title)}`,
    source: 'Mercari', price: '100', ...flags
});

const createApi = ({ paginated = true, deferSeen = false } = {}) => {
    let items = [
        makeItem('Seen item'),
        makeItem('Updated favorite', { isNew: true, isUpdated: true, newType: 'updated', isFavorite: true }),
        ...Array.from({ length: 24 }, (_, i) => makeItem(`New item ${i + 1}`, { isNew: true }))
    ];
    let completeSeen;
    let completionVersion = 0;
    const response = data => Promise.resolve({ ok: true, json: async () => data });
    const fetch = vi.fn((url, options = {}) => {
        if (url === '/api/watchlist') return response([
            { id: 'a', name: 'First watch', term: 'first' },
            { id: 'b', name: 'Other watch', term: 'other' }
        ]);
        if (url === '/api/watchlist/newcounts') return response({ a: items.filter(i => i.isNew).length });
        if (url === '/api/status') return response({ isRunning: false, completionVersion });
        if (url === '/api/results/a/seen' && options.method === 'POST') {
            const finish = () => {
                items = items.map(item => ({ ...item, isNew: false, isUpdated: false, newType: 'new' }));
                return { ok: true, json: async () => ({ success: true }) };
            };
            if (deferSeen) return new Promise(resolve => { completeSeen = () => resolve(finish()); });
            return Promise.resolve(finish());
        }
        if (url.startsWith('/api/results/')) {
            const request = new URL(url, 'https://example.test');
            const page = Number(request.searchParams.get('page') || 1);
            const results = request.pathname === '/api/results/a' ? items : [makeItem('Other result')];
            return response(paginated ? {
                items: results.slice((page - 1) * 24, page * 24), total: results.length,
                page, pageSize: 24, totalPages: Math.ceil(results.length / 24), sources: ['Mercari']
            } : results);
        }
        return response({});
    });
    return {
        fetch, finishSeen: () => completeSeen(), completeSearch: () => { completionVersion += 1; },
        resultCalls: () => fetch.mock.calls.filter(([url]) => url.startsWith('/api/results/a?'))
    };
};

describe('watch unread lifecycle', () => {
    it('keeps highlights through pagination, filters and sorting, then clears them when switching watches', async () => {
        const api = createApi();
        render(<WatchlistManager authenticatedFetch={api.fetch} />);
        fireEvent.click(await screen.findByText('First watch'));
        expect((await screen.findByText('New item 1')).closest('a')).toHaveClass('is-new');
        expect(screen.getByText('Updated favorite').closest('a')).toHaveClass('is-updated');

        const beforeRefresh = api.resultCalls().length;
        api.completeSearch();
        fireEvent(document, new Event('visibilitychange'));
        await waitFor(() => expect(api.resultCalls().length).toBeGreaterThan(beforeRefresh));
        fireEvent.click(screen.getByText('First watch'));
        await screen.findByText('Updated favorite');

        fireEvent.click(screen.getByText('Next →'));
        expect((await screen.findByText('New item 24')).closest('a')).toHaveClass('is-new');
        fireEvent.click(screen.getByText('← Prev'));
        await screen.findByText('Updated favorite');
        fireEvent.change(screen.getByPlaceholderText('Filter results by title...'), { target: { value: 'item' } });
        await waitFor(() => expect(api.fetch.mock.calls.some(([url]) => url.includes('filter=item'))).toBe(true));
        fireEvent.change(screen.getByDisplayValue('Sort: Time Scraped'), { target: { value: 'name' } });
        await waitFor(() => expect(api.fetch.mock.calls.some(([url]) => url.includes('sort=title'))).toBe(true));
        expect(screen.getByText('New item 1').closest('a')).toHaveClass('is-new');
        expect(api.fetch.mock.calls.some(([url]) => url.endsWith('/seen'))).toBe(false);

        fireEvent.click(screen.getByText('Other watch'));
        await screen.findByText('Other result');
        expect(api.fetch).toHaveBeenCalledWith('/api/results/a/seen', { method: 'POST' });
        fireEvent.click(screen.getByText('First watch'));
        expect((await screen.findByText('New item 1')).closest('a')).not.toHaveClass('is-new');
        expect(screen.getByText('Updated favorite').closest('a')).not.toHaveClass('is-updated');
        const lastRequest = api.resultCalls().at(-1)[0];
        expect(lastRequest).not.toContain('filter=');
    });

    it('waits for a pending acknowledgement before quickly reopening the watch', async () => {
        const api = createApi({ deferSeen: true });
        render(<WatchlistManager authenticatedFetch={api.fetch} />);
        fireEvent.click(await screen.findByText('First watch'));
        await screen.findByText('New item 1');
        fireEvent.click(screen.getByText('Other watch'));
        await screen.findByText('Other result');
        const before = api.resultCalls().length;
        fireEvent.click(screen.getByText('First watch'));
        expect(api.resultCalls()).toHaveLength(before);
        await act(async () => api.finishSeen());
        expect((await screen.findByText('New item 1')).closest('a')).not.toHaveClass('is-new');
    });

    it('ignores late results from a watch that was left before it loaded', async () => {
        const api = createApi();
        const original = api.fetch.getMockImplementation();
        let resolveFirst;
        api.fetch.mockImplementation((url, options) => url.startsWith('/api/results/a?')
            ? new Promise(resolve => { resolveFirst = resolve; }) : original(url, options));
        render(<WatchlistManager authenticatedFetch={api.fetch} />);
        fireEvent.click(await screen.findByText('First watch'));
        await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
        fireEvent.click(screen.getByText('Other watch'));
        await screen.findByText('Other result');
        await act(async () => resolveFirst({ ok: true, json: async () => [makeItem('Late result', { isNew: true })] }));
        expect(screen.queryByText('Late result')).not.toBeInTheDocument();
        expect(screen.getByText('Other result')).toBeInTheDocument();
        expect(api.fetch).not.toHaveBeenCalledWith('/api/results/a/seen', expect.anything());
    });

    it('keeps a watch unread when its acknowledgement fails', async () => {
        const api = createApi();
        const original = api.fetch.getMockImplementation();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        api.fetch.mockImplementation((url, options) => url === '/api/results/a/seen'
            ? Promise.resolve({ ok: false, status: 500 }) : original(url, options));
        try {
            render(<WatchlistManager authenticatedFetch={api.fetch} />);
            fireEvent.click(await screen.findByText('First watch'));
            await screen.findByText('New item 1');
            fireEvent.click(screen.getByText('Other watch'));
            await screen.findByText('Other result');
            fireEvent.click(screen.getByText('First watch'));
            expect((await screen.findByText('New item 1')).closest('a')).toHaveClass('is-new');
            expect(screen.getByText('25 NEW')).toBeInTheDocument();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('promotes unread price updates before client-side pagination and sorting', async () => {
        const api = createApi({ paginated: false });
        const { container } = render(<WatchlistManager authenticatedFetch={api.fetch} />);
        fireEvent.click(await screen.findByText('First watch'));
        await screen.findByText('Updated favorite');
        expect(container.querySelector('.result-card')).toHaveClass('is-updated');
        fireEvent.change(screen.getByDisplayValue('Sort: Time Scraped'), { target: { value: 'name' } });
        const cards = [...container.querySelectorAll('.result-card')];
        expect(cards.every(card => card.classList.contains('is-new'))).toBe(true);
        expect(screen.queryByText('Seen item')).not.toBeInTheDocument();
    });
});
