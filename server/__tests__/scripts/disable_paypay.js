const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, 'server/data/settings.json');

try {
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        // Disable PayPay due to 500 errors/blocking
        if (settings.enabledSites) {
            settings.enabledSites.paypay = false;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('SUCCESS: Disabled PayPay in settings.json');
    } else {
        console.error('ERROR: settings.json not found');
    }
} catch (err) {
    console.error('ERROR:', err);
}
