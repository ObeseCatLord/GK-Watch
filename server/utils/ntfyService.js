const dns = require('dns').promises;
const net = require('net');
const { Agent } = require('undici');
const Settings = require('../models/settings');

const REQUEST_TIMEOUT_MS = 5000;
const ALLOWED_ORIGINS = new Set([
    'https://ntfy.sh',
    ...(process.env.NTFY_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
].map(value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.origin : null;
    } catch (_) { return null; }
}).filter(Boolean));

function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const octets = address.split('.').map(Number);
        return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
            (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
            (octets[0] === 169 && octets[1] === 254) ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168) ||
            (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
    }
    if (family === 6) {
        const normalized = address.toLowerCase();
        if (normalized.startsWith('::ffff:')) return isBlockedAddress(normalized.slice(7));
        return normalized === '::' || normalized === '::1' || normalized.startsWith('fe80:') ||
            normalized.startsWith('fc') || normalized.startsWith('fd');
    }
    return true;
}

async function validateDestination(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Ntfy server must be a valid HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error('Ntfy server must be an HTTPS URL without credentials or fragments');
    }
    if (!ALLOWED_ORIGINS.has(url.origin)) {
        throw new Error('Ntfy server origin is not allowlisted');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) throw new Error('Ntfy server resolves to a blocked network address');
        return { url: url.toString(), address: hostname, family: net.isIP(hostname) };
    }
    let records;
    try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
    catch (_) { throw new Error('Unable to resolve Ntfy server'); }
    if (!records.length || records.some(record => isBlockedAddress(record.address))) {
        throw new Error('Ntfy server resolves to a blocked network address');
    }
    const selected = records.find(record => record.family === 4) || records[0];
    return { url: url.toString(), address: selected.address, family: selected.family };
}

function createPinnedLookup(destination) {
    return (_hostname, options, callback) => {
        const record = { address: destination.address, family: destination.family };
        if (options?.all) {
            callback(null, [record]);
            return;
        }
        callback(null, record.address, record.family);
    };
}

function validWebUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
    } catch (_) { return null; }
}

const NtfyService = {
    validateDestination,

    send: async (title, message, priority = 'default', tags = [], options = {}) => {
        const settings = Settings.get();
        if (!settings.ntfyEnabled || !settings.ntfyTopic) return false;

        try {
            const destination = await validateDestination(settings.ntfyServer || 'https://ntfy.sh');
            const priorities = { max: 5, urgent: 5, high: 4, default: 3, low: 2, min: 1 };
            let normalizedPriority = typeof priority === 'string' ? (priorities[priority.toLowerCase()] || Number(priority)) : priority;
            if (!Number.isInteger(normalizedPriority) || normalizedPriority < 1 || normalizedPriority > 5) normalizedPriority = 3;
            const click = validWebUrl(options.click);
            const actions = Array.isArray(options.actions) ? options.actions
                .map(action => ({ ...action, url: validWebUrl(action?.url) }))
                .filter(action => action.url && action.action === 'view')
                .slice(0, 3) : [];
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            const dispatcher = new Agent({
                connect: {
                    lookup: createPinnedLookup(destination)
                }
            });
            try {
                const response = await fetch(destination.url, {
                    method: 'POST', redirect: 'error', signal: controller.signal,
                    dispatcher,
                    body: JSON.stringify({ topic: String(settings.ntfyTopic).slice(0, 128), message: String(message).slice(0, 4096), title: String(title).slice(0, 256), priority: normalizedPriority, tags: Array.isArray(tags) ? tags.slice(0, 5) : [], ...(click ? { click } : {}), ...(actions.length ? { actions } : {}) }),
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!response.ok) throw new Error(`Ntfy returned status ${response.status}`);
                return true;
            } finally {
                clearTimeout(timeout);
                await dispatcher.close();
            }
        } catch (error) {
            const causeCode = error.cause?.code;
            console.error('[Ntfy] Send failed:', causeCode ? `${error.message} (${causeCode})` : error.message);
            return false;
        }
    },

    sendPriorityAlert: async (watchName, newItems) => {
        const count = newItems.length;
        const title = `🚨 PRIORITY MATCH: ${watchName}`;
        const message = `Found ${count} new item(s) for "${watchName}"!\n` + newItems.slice(0, 3).map(i => `• ${i.title} (${i.price})`).join('\n') + (count > 3 ? `\n...and ${count - 3} more` : '');
        const linkedItems = newItems.map(item => ({ ...item, link: validWebUrl(item.link) })).filter(item => item.link).slice(0, 3);
        const actions = linkedItems.map((item, index) => ({ action: 'view', label: linkedItems.length === 1 ? 'Open listing' : `Open ${index + 1}`, url: item.link, clear: true }));
        return NtfyService.send(title, message, 5, ['rotating_light', 'warning'], { click: linkedItems[0]?.link, actions });
    },

    _createPinnedLookup: createPinnedLookup
};

module.exports = NtfyService;
