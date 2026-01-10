const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

// Default: run at midnight JST (15:00 CST previous day)
const DEFAULT_SCHEDULE = {
    enabledHours: [0, 6, 12, 18], // JST hours (0-23)
    timezone: 'JST'
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure schedule file exists
if (!fs.existsSync(SCHEDULE_FILE)) {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULE, null, 2));
}

const ScheduleSettings = {
    get: () => {
        try {
            const data = fs.readFileSync(SCHEDULE_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('Error reading schedule:', err);
            return DEFAULT_SCHEDULE;
        }
    },

    setEnabledHours: (hours) => {
        const settings = ScheduleSettings.get();
        settings.enabledHours = hours;
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(settings, null, 2));
        return settings;
    },

    // Check if current JST hour is in enabled list
    isCurrentHourEnabled: () => {
        const settings = ScheduleSettings.get();
        // Get current JST hour (UTC+9)
        const now = new Date();
        const jstHour = (now.getUTCHours() + 9) % 24;
        return settings.enabledHours.includes(jstHour);
    },

    // Convert JST hour to CST (CST = UTC-6, so JST - 15 hours, or +9 hours from next day)
    jstToCst: (jstHour) => {
        // JST is UTC+9, CST is UTC-6, difference is 15 hours
        let cstHour = (jstHour - 15) % 24;
        if (cstHour < 0) cstHour += 24;
        return cstHour;
    }
};

module.exports = ScheduleSettings;
