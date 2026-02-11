const db = require('./database');

// Prepared statements
const getSetting = db.prepare('SELECT value FROM schedule WHERE key = ?');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO schedule (key, value) VALUES (?, ?)');

const DEFAULT_SCHEDULE = {
    enabledHours: [],
    timezone: 'JST'
};

let cachedSchedule = null;

const ScheduleSettings = {
    get: () => {
        if (cachedSchedule) return { ...cachedSchedule };

        try {
            const schedule = { ...DEFAULT_SCHEDULE };
            const hoursRow = getSetting.get('enabledHours');
            if (hoursRow) schedule.enabledHours = JSON.parse(hoursRow.value);

            const tzRow = getSetting.get('timezone');
            if (tzRow) schedule.timezone = JSON.parse(tzRow.value);

            cachedSchedule = schedule;
            return { ...schedule };
        } catch (err) {
            console.error('Error reading schedule:', err);
            cachedSchedule = { ...DEFAULT_SCHEDULE };
            return { ...DEFAULT_SCHEDULE };
        }
    },

    setEnabledHours: (hours) => {
        const settings = ScheduleSettings.get();
        settings.enabledHours = hours;
        upsertSetting.run('enabledHours', JSON.stringify(hours));
        cachedSchedule = settings;
        return { ...settings };
    },

    /**
     * Check if the current hour is scheduled for execution.
     */
    isScheduledNow: () => {
        const settings = ScheduleSettings.get();
        if (!settings.enabledHours || settings.enabledHours.length === 0) return false;
        const now = new Date();
        // Current JST hour
        const jstHour = (now.getUTCHours() + 9) % 24;
        return settings.enabledHours.includes(jstHour);
    },

    /**
     * Convert JST hour to CST
     */
    jstToCst: (jstHour) => {
        // JST = UTC+9, CST = UTC-6
        // Difference = -15 hours
        let cstHour = (jstHour - 15) % 24;
        if (cstHour < 0) cstHour += 24;
        return cstHour;
    }
};

module.exports = ScheduleSettings;
