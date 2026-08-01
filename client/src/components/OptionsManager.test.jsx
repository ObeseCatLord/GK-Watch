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
