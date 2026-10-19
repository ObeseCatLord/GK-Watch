import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import OptionsManager from './OptionsManager';

const response = (body, ok = true) => ({ ok, json: async () => body });
const initialSettings = {
    email: 'old@example.com', emailEnabled: true,
    smtpHost: 'old.example.com', smtpPort: '465', smtpUser: 'old-user',
    smtpPass: null, hasSmtpPass: true, loginPassword: null, hasLoginPassword: true,
    loginEnabled: false, baseUrl: 'https://example.com',
    ntfyEnabled: true, ntfyTopic: 'old-topic', ntfyServer: 'https://ntfy.sh'
};

function fixture({ rejectSave = false, delayFirstSave = false } = {}) {
    let stored = { ...initialSettings };
    const testsSent = [];
    let releaseSave;
    let saves = 0;
    const authenticatedFetch = vi.fn(async (url, options = {}) => {
        if (url === '/api/settings' && !options.method) return response({ ...stored });
        if (url === '/api/schedule') return response({ intervalMinutes: 60, enabledSlots: [] });
        if (url === '/api/settings' && options.method === 'POST') {
            const changes = JSON.parse(options.body);
            saves++;
            if (rejectSave) return response({ error: 'Server rejected these settings' }, false);
            if ('smtpPort' in changes && !Number.isInteger(changes.smtpPort)) {
                return response({ error: 'smtpPort must be an integer' }, false);
            }
            if (delayFirstSave && saves === 1) await new Promise(resolve => { releaseSave = resolve; });
            stored = { ...stored, ...changes };
            return response({ ...stored });
        }
        if (url === '/api/settings/test-email' || url === '/api/settings/test-ntfy') {
            testsSent.push({ ...stored });
            return response({ success: true });
        }
        return response({ success: true });
    });
    return { authenticatedFetch, testsSent, getStored: () => stored, releaseSave: () => releaseSave() };
}

async function openOptions(api) {
    const view = render(<OptionsManager authenticatedFetch={api.authenticatedFetch} />);
    await screen.findByDisplayValue('old@example.com');
    return view;
}

function change(view, name, value) {
    fireEvent.change(view.container.querySelector(`[name="${name}"]`), { target: { value } });
}

describe('notification settings saving', () => {
    beforeEach(() => {
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => vi.restoreAllMocks());

    test('autosaves address and server changes despite an unrelated legacy string port, and reloads them', async () => {
        const api = fixture();
        const view = await openOptions(api);
        change(view, 'email', 'new@example.com');
        change(view, 'smtpHost', 'new.example.com');
        change(view, 'smtpUser', 'new-user');
        await screen.findByText('✓ Settings saved');

        expect(api.getStored()).toMatchObject({ email: 'new@example.com', smtpHost: 'new.example.com', smtpUser: 'new-user' });
        const saves = api.authenticatedFetch.mock.calls.filter(([url, opts]) => url === '/api/settings' && opts?.method === 'POST');
        expect(JSON.parse(saves[0][1].body)).toEqual({ email: 'new@example.com', smtpHost: 'new.example.com', smtpUser: 'new-user' });
        view.unmount();
        render(<OptionsManager authenticatedFetch={api.authenticatedFetch} />);
        expect(await screen.findByDisplayValue('new@example.com')).toBeInTheDocument();
        expect(screen.getByDisplayValue('new.example.com')).toBeInTheDocument();
    });

    test('immediately testing email waits for new address, server and numeric port to save', async () => {
        const api = fixture({ delayFirstSave: true });
        const view = await openOptions(api);
        change(view, 'email', 'new@example.com');
        change(view, 'smtpHost', 'new.example.com');
        change(view, 'smtpPort', '587');
        fireEvent.click(screen.getByRole('button', { name: /Send Test Email/ }));
        await waitFor(() => expect(api.authenticatedFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'POST' })));
        expect(api.testsSent).toHaveLength(0);
        await act(async () => api.releaseSave());
        await waitFor(() => expect(api.testsSent).toHaveLength(1));
        expect(api.testsSent[0]).toMatchObject({ email: 'new@example.com', smtpHost: 'new.example.com', smtpPort: 587 });
    });

    test('immediately testing ntfy saves the new topic and server first', async () => {
        const api = fixture();
        const view = await openOptions(api);
        change(view, 'ntfyTopic', 'new-topic');
        change(view, 'ntfyServer', 'https://notifications.example.com');
        fireEvent.click(screen.getByRole('button', { name: /Send Test Notification/ }));
        await waitFor(() => expect(api.testsSent).toHaveLength(1));
        expect(api.testsSent[0]).toMatchObject({ ntfyTopic: 'new-topic', ntfyServer: 'https://notifications.example.com' });
    });

    test('shows rejected saves and does not send a test using old settings', async () => {
        const api = fixture({ rejectSave: true });
        const view = await openOptions(api);
        change(view, 'email', 'new@example.com');
        fireEvent.click(screen.getByRole('button', { name: /Send Test Email/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Server rejected these settings');
        expect(screen.queryByText('✓ Settings saved')).not.toBeInTheDocument();
        expect(api.testsSent).toHaveLength(0);
        expect(api.getStored().email).toBe('old@example.com');
    });

    test('shows autosave failures without requiring a test notification', async () => {
        const api = fixture({ rejectSave: true });
        const view = await openOptions(api);
        change(view, 'smtpHost', 'new.example.com');
        expect(await screen.findByRole('alert')).toHaveTextContent('Server rejected these settings');
        expect(screen.queryByText('✓ Settings saved')).not.toBeInTheDocument();
        expect(api.getStored().smtpHost).toBe('old.example.com');
    });

    test('saving the SMTP password also saves pending email edits without sending redacted secrets', async () => {
        const api = fixture();
        const view = await openOptions(api);
        change(view, 'email', 'new@example.com');
        fireEvent.change(screen.getByPlaceholderText('Set SMTP Password'), { target: { value: 'new-secret' } });
        const passwordInput = screen.getByPlaceholderText('Set SMTP Password');
        fireEvent.click(passwordInput.parentElement.querySelector('button'));
        await screen.findByText('SMTP Password Saved!');
        expect(api.getStored()).toMatchObject({ email: 'new@example.com', smtpPass: 'new-secret' });
        const payloads = api.authenticatedFetch.mock.calls.filter(([url, opts]) => url === '/api/settings' && opts?.method === 'POST')
            .map(([, opts]) => JSON.parse(opts.body));
        expect(payloads).toEqual([{ email: 'new@example.com' }, { smtpPass: 'new-secret' }]);
        expect(screen.getByDisplayValue('new@example.com')).toBeInTheDocument();
    });

    test('serializes overlapping saves and tests with the latest edits', async () => {
        const api = fixture({ delayFirstSave: true });
        const view = await openOptions(api);
        change(view, 'email', 'first@example.com');
        await waitFor(() => expect(api.authenticatedFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'POST' })));
        change(view, 'email', 'latest@example.com');
        fireEvent.click(screen.getByRole('button', { name: /Send Test Email/ }));
        expect(api.testsSent).toHaveLength(0);
        await act(async () => api.releaseSave());
        await waitFor(() => expect(api.testsSent).toHaveLength(1));
        expect(api.getStored().email).toBe('latest@example.com');
        expect(api.testsSent[0].email).toBe('latest@example.com');
    });
});
