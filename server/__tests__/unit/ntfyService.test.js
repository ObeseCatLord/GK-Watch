process.env.NTFY_ALLOWED_ORIGINS = [
    'https://ntfy.sh',
    'https://mixed-check.example',
    'https://lookup-fail.example',
    'https://mapped-v6.example',
    'https://ula.example',
    'https://link-local.example'
].join(',');

jest.mock('dns', () => ({
    promises: { lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) }
}));

jest.mock('../../models/settings', () => ({
    get: jest.fn(() => ({
        ntfyEnabled: true,
        ntfyTopic: 'test-topic',
        ntfyServer: 'https://ntfy.sh'
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

    test('rejects private ntfy destinations before sending', async () => {
        const Settings = require('../../models/settings');
        Settings.get.mockReturnValueOnce({ ntfyEnabled: true, ntfyTopic: 'test-topic', ntfyServer: 'https://127.0.0.1/notify' });
        await expect(NtfyService.send('Title', 'Message')).resolves.toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('rejects a public but unapproved ntfy origin', async () => {
        const Settings = require('../../models/settings');
        Settings.get.mockReturnValueOnce({ ntfyEnabled: true, ntfyTopic: 'test-topic', ntfyServer: 'https://example.com/notify' });
        await expect(NtfyService.send('Title', 'Message')).resolves.toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test.each([
        [
            'blocks mixed safe and private DNS records',
            'https://mixed-check.example/notify',
            [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]
        ],
        [
            'blocks DNS lookup failures',
            'https://lookup-fail.example/notify',
            new Error('temporary failure')
        ],
        [
            'blocks mapped IPv6 loopback addresses',
            'https://mapped-v6.example/notify',
            [{ address: '::ffff:127.0.0.1', family: 6 }]
        ],
        [
            'blocks ULA IPv6 addresses',
            'https://ula.example/notify',
            [{ address: 'fd12:3456:789a::1', family: 6 }]
        ],
        [
            'blocks link-local IPv6 addresses',
            'https://link-local.example/notify',
            [{ address: 'fe80::1234', family: 6 }]
        ]
    ])('%s', async (_, server, recordsOrError) => {
        const dns = require('dns');
        const Settings = require('../../models/settings');
        Settings.get.mockReturnValueOnce({ ntfyEnabled: true, ntfyTopic: 'test-topic', ntfyServer: server });

        if (recordsOrError instanceof Error) {
            dns.promises.lookup.mockRejectedValue(recordsOrError);
        } else {
            dns.promises.lookup.mockResolvedValue(recordsOrError);
        }

        await expect(NtfyService.send('Title', 'Message')).resolves.toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
