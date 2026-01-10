const Settings = require('../models/settings');

const NtfyService = {
    send: async (title, message, priority = 'default', tags = []) => {
        const settings = Settings.get();

        if (!settings.ntfyEnabled || !settings.ntfyTopic) {
            console.log('[Ntfy] Skipping notification: Ntfy disabled or topic missing.');
            return false;
        }

        const serverUrl = settings.ntfyServer || 'https://ntfy.sh';
        const topic = settings.ntfyTopic;
        const url = `${serverUrl}/${topic}`;

        console.log(`[Ntfy] Sending notification to ${url}: ${title}`);

        try {
            const headers = {
                'Title': title,
                'Priority': priority
            };

            if (tags.length > 0) {
                headers['Tags'] = tags.join(',');
            }

            const response = await fetch(url, {
                method: 'POST',
                body: message,
                headers: headers
            });

            if (!response.ok) {
                throw new Error(`Ntfy returned status ${response.status}`);
            }

            return true;
        } catch (error) {
            console.error('Ntfy send failed:', error);
            return false;
        }
    },

    sendPriorityAlert: async (watchName, newItems) => {
        const count = newItems.length;
        const title = `🚨 PRIORITY MATCH: ${watchName}`;
        const message = `Found ${count} new item(s) for "${watchName}"!\n` +
            newItems.slice(0, 3).map(i => `• ${i.title} (${i.price})`).join('\n') +
            (count > 3 ? `\n...and ${count - 3} more` : '');

        // Priority 5 (Max) triggers "Emergency" alerts usually (wakes up user)
        // Tags: 'rotating_light' (siren)
        return await NtfyService.send(title, message, '5', ['rotating_light', 'warning']);
    }
};

module.exports = NtfyService;
