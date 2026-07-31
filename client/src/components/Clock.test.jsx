import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import Clock from './Clock';

describe('Clock', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows running state when the scheduler is active', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ isRunning: true, minutesUntilNext: 0 })
        });

        render(<Clock authenticatedFetch={fetchMock} />);

        expect(await screen.findByText('Running')).toBeInTheDocument();
        expect(await screen.findByText('🔄')).toBeInTheDocument();
    });

    it('renders countdown state when scheduler is idle', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ isRunning: false, minutesUntilNext: 5 })
        });

        render(<Clock authenticatedFetch={fetchMock} />);

        expect(await screen.findByText('Next')).toBeInTheDocument();
        const countdownCell = screen.getByText('Next').parentElement;
        expect(countdownCell).toHaveTextContent(/\d{2}:\d{2}:\d{2}/);
    });

    it('cleans up polling and timer intervals on unmount', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ isRunning: false, minutesUntilNext: 15 })
        });

        const { unmount } = render(<Clock authenticatedFetch={fetchMock} />);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(30000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(61000);
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
