const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, 'server/data/settings.json');

try {
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        // Re-enable PayPay
        if (!settings.enabledSites) settings.enabledSites = {};
        settings.enabledSites.paypay = true;

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('SUCCESS: Re-enabled PayPay in settings.json');
    } else {
        console.error('ERROR: settings.json not found');
    }
} catch (err) {
    console.error('ERROR:', err);
}
