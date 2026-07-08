const db = require('./database');

// Prepared statements
const getSetting = db.prepare('SELECT value FROM schedule WHERE key = ?');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO schedule (key, value) VALUES (?, ?)');

const DEFAULT_SCHEDULE = {
    enabledHours: [],
    enabledSlots: [],
    intervalMinutes: 60,
    timezone: 'JST'
};

let cachedSchedule = null;

function normalizeInterval(intervalMinutes) {
    return Number(intervalMinutes) === 30 ? 30 : 60;
}

function normalizeHour(hour) {
    const parsed = Number(hour);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return null;
    return parsed;
}

function normalizeSlot(slot, intervalMinutes = 30) {
    const parsed = Number(slot);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed >= 24 * 60) return null;
    if (parsed % intervalMinutes !== 0) return null;
    return parsed;
}

function normalizeHours(hours) {
    if (!Array.isArray(hours)) return [];
    return [...new Set(hours.map(normalizeHour).filter(hour => hour !== null))]
        .sort((a, b) => a - b);
}

function hoursToSlots(hours) {
    return normalizeHours(hours).map(hour => hour * 60);
}

function normalizeSlots(slots, intervalMinutes) {
    if (!Array.isArray(slots)) return [];
    return [...new Set(slots.map(slot => normalizeSlot(slot, intervalMinutes)).filter(slot => slot !== null))]
        .sort((a, b) => a - b);
}

function slotsToHours(slots) {
    return normalizeSlots(slots, 30)
        .filter(slot => slot % 60 === 0)
        .map(slot => slot / 60);
}

function getJstSlot(date = new Date()) {
    const jstHour = (date.getUTCHours() + 9) % 24;
    return jstHour * 60 + date.getUTCMinutes();
}

function formatSlot(slot) {
    const normalized = normalizeSlot(slot, 30);
    if (normalized === null) return '';
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    return `${hour}:${String(minute).padStart(2, '0')}`;
}

const ScheduleSettings = {
    get: () => {
        if (cachedSchedule) return { ...cachedSchedule };

        try {
            const schedule = { ...DEFAULT_SCHEDULE };
            const intervalRow = getSetting.get('intervalMinutes');
            if (intervalRow) schedule.intervalMinutes = normalizeInterval(JSON.parse(intervalRow.value));

            const slotsRow = getSetting.get('enabledSlots');
            if (slotsRow) {
                schedule.enabledSlots = normalizeSlots(JSON.parse(slotsRow.value), schedule.intervalMinutes);
            }

            const hoursRow = getSetting.get('enabledHours');
            if (hoursRow) schedule.enabledHours = normalizeHours(JSON.parse(hoursRow.value));
            if (!slotsRow && hoursRow) schedule.enabledSlots = hoursToSlots(schedule.enabledHours);
            if (!hoursRow) schedule.enabledHours = slotsToHours(schedule.enabledSlots);

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
        settings.intervalMinutes = 60;
        settings.enabledHours = normalizeHours(hours);
        settings.enabledSlots = hoursToSlots(settings.enabledHours);
        upsertSetting.run('intervalMinutes', JSON.stringify(settings.intervalMinutes));
        upsertSetting.run('enabledHours', JSON.stringify(settings.enabledHours));
        upsertSetting.run('enabledSlots', JSON.stringify(settings.enabledSlots));
        cachedSchedule = settings;
        return { ...settings };
    },

    setSchedule: ({ enabledSlots, enabledHours, intervalMinutes } = {}) => {
        const settings = ScheduleSettings.get();
        settings.intervalMinutes = normalizeInterval(intervalMinutes ?? settings.intervalMinutes);
        const sourceSlots = Array.isArray(enabledSlots) ? enabledSlots : hoursToSlots(enabledHours);
        settings.enabledSlots = normalizeSlots(sourceSlots, settings.intervalMinutes);
        settings.enabledHours = slotsToHours(settings.enabledSlots);

        upsertSetting.run('intervalMinutes', JSON.stringify(settings.intervalMinutes));
        upsertSetting.run('enabledHours', JSON.stringify(settings.enabledHours));
        upsertSetting.run('enabledSlots', JSON.stringify(settings.enabledSlots));
        cachedSchedule = settings;
        return { ...settings };
    },

    /**
     * Check if the current JST timeslot is scheduled for execution.
     */
    isScheduledNow: (date = new Date()) => {
        const settings = ScheduleSettings.get();
        if (!settings.enabledSlots || settings.enabledSlots.length === 0) return false;

        const jstSlot = getJstSlot(date);
        if (jstSlot % settings.intervalMinutes !== 0) return false;
        return settings.enabledSlots.includes(jstSlot);
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

    formatSlot,

    _resetCache: () => {
        cachedSchedule = null;
    }
};

module.exports = ScheduleSettings;
