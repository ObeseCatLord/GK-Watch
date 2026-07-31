jest.mock('../../models/settings', () => ({
    get: jest.fn(() => ({
        ntfyEnabled: true,
        ntfyTopic: 'test-topic',
        ntfyServer: 'https://ntfy.example'
    }))
}));

const NtfyService = require('../../utils/ntfyService');

describe('NtfyService priority alerts', () => {
    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('links the notification and actions to store listings', async () => {
        await NtfyService.sendPriorityAlert('Touhou', [
            { title: 'First kit', price: '¥1,000', link: 'https://store.example/item/1' },
            { title: 'Second kit', price: '¥2,000', link: 'https://store.example/item/2' }
        ]);

        const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(payload.click).toBe('https://store.example/item/1');
        expect(payload.actions).toEqual([
            expect.objectContaining({ action: 'view', label: 'Open 1', url: 'https://store.example/item/1' }),
            expect.objectContaining({ action: 'view', label: 'Open 2', url: 'https://store.example/item/2' })
        ]);
    });

    test('omits links when no item has a valid web URL', async () => {
        await NtfyService.sendPriorityAlert('Touhou', [
            { title: 'Unknown kit', price: '¥1,000', link: 'not-a-url' }
        ]);

        const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(payload).not.toHaveProperty('click');
        expect(payload).not.toHaveProperty('actions');
    });
});
