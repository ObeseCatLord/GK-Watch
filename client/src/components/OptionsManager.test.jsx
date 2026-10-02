import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import OptionsManager from './OptionsManager';

const jsonResponse = (body, ok = true) => Promise.resolve({
    ok,
    json: () => Promise.resolve(body)
});

describe('OptionsManager Yahoo cookies', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('offers optional Yahoo cookie upload without requiring a cookie status check', async () => {
        const authenticatedFetch = vi.fn((url, options = {}) => {
            if (url === '/api/settings' && !options.method) {
                return jsonResponse({
                    email: '',
                    emailEnabled: false,
                    baseUrl: 'http://localhost:5173',
                    smtpHost: '',
                    smtpPort: 587,
                    smtpUser: '',
                    loginEnabled: false,
                    enabledSites: { yahoo: true },
                    strictFiltering: { yahoo: true },
                    allowYahooInternationalShipping: false
                });
            }
            if (url === '/api/schedule') {
                return jsonResponse({ intervalMinutes: 60, enabledSlots: [] });
            }
            if (url === '/api/cookies/yahoo') {
                return jsonResponse({ success: true });
            }
            return jsonResponse({ success: true });
        });

        render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        const heading = await screen.findByRole('heading', { name: 'Yahoo Auctions' });
        const card = heading.closest('.site-card');
        expect(card).not.toBeNull();
        expect(within(card).getByRole('checkbox', { name: 'Enable Search' })).toBeChecked();

        fireEvent.click(within(card).getByRole('button', { name: /Update Cookies/ }));
        expect(within(card).getByPlaceholderText('Paste JSON here')).toBeInTheDocument();

        const cookieJson = JSON.stringify([
            { name: 'A', value: 'test-value', domain: '.yahoo.co.jp' }
        ]);
        fireEvent.change(within(card).getByPlaceholderText('Paste JSON here'), {
            target: { value: cookieJson }
        });
        fireEvent.click(within(card).getByRole('button', { name: 'Save Cookies' }));

        await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
            '/api/cookies/yahoo',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ cookies: cookieJson })
            })
        ));
        expect(authenticatedFetch).not.toHaveBeenCalledWith('/api/yahoo/status');
    });
});

const scheduleResponse = (schedule) => ({
    intervalMinutes: schedule.intervalMinutes,
    enabledSlots: schedule.enabledSlots,
    disabledHalfHourSlots: schedule.disabledHalfHourSlots
});

const createScheduleFetch = (initialSchedule) => {
    let schedule = initialSchedule;
    const authenticatedFetch = vi.fn((url, options = {}) => {
        if (url === '/api/settings' && !options.method) {
            return jsonResponse({
                email: '',
                emailEnabled: false,
                baseUrl: 'http://localhost:5173',
                smtpHost: '',
                smtpPort: 587,
                smtpUser: '',
                loginEnabled: false
            });
        }
        if (url === '/api/schedule' && !options.method) {
            return jsonResponse(scheduleResponse(schedule));
        }
        if (url === '/api/schedule' && options.method === 'POST') {
            schedule = JSON.parse(options.body);
            return jsonResponse({ success: true });
        }
        return jsonResponse({ success: true });
    });

    return { authenticatedFetch, getSchedule: () => schedule };
};

const getLastScheduleSave = (authenticatedFetch) => {
    const saves = authenticatedFetch.mock.calls.filter(([url, options]) => (
        url === '/api/schedule' && options?.method === 'POST'
    ));
    return JSON.parse(saves[saves.length - 1][1].body);
};

const waitForScheduleLoad = async (authenticatedFetch) => {
    await waitFor(() => {
        expect(authenticatedFetch).toHaveBeenCalledWith('/api/schedule');
        expect(screen.getByTitle(/^JST 1:00 \//)).toHaveClass('active');
    });
};

const formatJstSlot = (slot) => `${Math.floor(slot / 60)}:${String(slot % 60).padStart(2, '0')}`;

describe('OptionsManager schedule intervals', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('saves a 20-minute interval and keeps a toggled intermediate slot disabled', async () => {
        const { authenticatedFetch } = createScheduleFetch({
            intervalMinutes: 60,
            enabledSlots: [60],
            disabledHalfHourSlots: []
        });
        render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        fireEvent.click(screen.getByRole('button', { name: '20 min' }));

        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toEqual({
            intervalMinutes: 20,
            enabledSlots: [60, 80, 100],
            disabledHalfHourSlots: []
        }));

        fireEvent.click(screen.getByTitle(/^JST 1:20 \//));
        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toEqual({
            intervalMinutes: 20,
            enabledSlots: [60, 100],
            disabledHalfHourSlots: []
        }));
    });

    test('populates 15-minute slots without restoring a saved disabled half-hour', async () => {
        const { authenticatedFetch } = createScheduleFetch({
            intervalMinutes: 60,
            enabledSlots: [60],
            disabledHalfHourSlots: [90]
        });
        render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        fireEvent.click(screen.getByRole('button', { name: '15 min' }));

        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toEqual({
            intervalMinutes: 15,
            enabledSlots: [60, 75, 105],
            disabledHalfHourSlots: [90]
        }));
    });

    test.each([
        [20, [60, 80, 100]],
        [15, [60, 75, 90, 105]]
    ])('reloads saved %i-minute intermediate slots with the matching interval selected', async (interval, expectedSlots) => {
        const { authenticatedFetch, getSchedule } = createScheduleFetch({
            intervalMinutes: 60,
            enabledSlots: [60],
            disabledHalfHourSlots: []
        });
        const view = render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        fireEvent.click(screen.getByRole('button', { name: `${interval} min` }));
        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toEqual({
            intervalMinutes: interval,
            enabledSlots: expectedSlots,
            disabledHalfHourSlots: []
        }));

        view.unmount();
        render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        expect(getSchedule().enabledSlots).toEqual(expectedSlots);
        expect(screen.getByRole('button', { name: `${interval} min` })).toHaveClass('active');
        for (const slot of expectedSlots.slice(1)) {
            expect(screen.getByTitle(new RegExp(`^JST ${formatJstSlot(slot)} /`))).toHaveClass('active');
        }
    });

    test('reloads saved 30-minute preferences, including disabled half-hour slots', async () => {
        const { authenticatedFetch, getSchedule } = createScheduleFetch({
            intervalMinutes: 60,
            enabledSlots: [60],
            disabledHalfHourSlots: []
        });
        const view = render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        fireEvent.click(screen.getByRole('button', { name: '30 min' }));
        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toMatchObject({
            intervalMinutes: 30,
            enabledSlots: [60, 90]
        }));

        fireEvent.click(screen.getByTitle(/^JST 1:30 \//));
        await waitFor(() => expect(getLastScheduleSave(authenticatedFetch)).toEqual({
            intervalMinutes: 30,
            enabledSlots: [60],
            disabledHalfHourSlots: [90]
        }));

        view.unmount();
        render(<OptionsManager authenticatedFetch={authenticatedFetch} />);

        await waitForScheduleLoad(authenticatedFetch);
        expect(getSchedule()).toEqual({
            intervalMinutes: 30,
            enabledSlots: [60],
            disabledHalfHourSlots: [90]
        });
        expect(screen.getByTitle(/^JST 1:30 \//)).not.toHaveClass('active');
    });
});
