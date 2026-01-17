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
        // Use JSON body payload to support Unicode (emojis) in headers/title
        const url = serverUrl;

        // Ensure priority is an integer
        let p = priority;
        if (typeof p === 'string') {
            const lower = p.toLowerCase();
            const map = {
                'max': 5,
                'urgent': 5,
                'high': 4,
                'default': 3,
                'low': 2,
                'min': 1
            };
            if (map[lower]) {
                p = map[lower];
            } else {
                const parsed = parseInt(p, 10);
                if (!isNaN(parsed)) {
                    p = parsed;
                }
                // If parsing fails and not in map, p remains as is (or could default to 3)
            }
        }

        console.log(`[Ntfy] Sending notification to ${url} (topic: ${topic}): ${title} (priority: ${p})`);

        try {
            const body = {
                topic: topic,
                message: message,
                title: title,
                priority: p,
                tags: tags
            };

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'Content-Type': 'application/json'
                }
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
        return await NtfyService.send(title, message, 5, ['rotating_light', 'warning']);
    }
};

module.exports = NtfyService;
