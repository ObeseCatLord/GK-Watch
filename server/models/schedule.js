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
        // JST is UTC+9
        // CST is UTC-6
        // Difference is -15 hours
        let cst = jstHour - 15;
        if (cst < 0) cst += 24;
        return cst;
    },

    _resetCache: () => {
        cachedSchedule = null;
    }
};

module.exports = ScheduleSettings;
