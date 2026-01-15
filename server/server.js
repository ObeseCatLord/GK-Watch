const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const searchAggregator = require('./scrapers');
const Settings = require('./models/settings');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Endpoint
const crypto = require('crypto');
const NtfyService = require('./utils/ntfyService');

// Simple in-memory session store
// Map<token, { timestamp }>
const activeSessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    // Check if login is enabled in settings
    const settings = Settings.get();

    // If login is disabled OR no password is set, bypass auth
    if (!settings.loginEnabled || !settings.loginPassword) {
        return next();
    }

    const token = req.header('x-auth-token');

    // Always allow localhost/loopback without token if standard auth is bypassed? 
    // No, strictly require token if loginEnabled is true.

    if (!token) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }

    if (!activeSessions.has(token)) {
        return res.status(401).json({ error: 'Token is invalid or expired' });
    }

    // Refresh timestamp? (Optional)
    return next();
};

// Login Routes
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const settings = Settings.get();

    // If login is disabled, just return success with dummy token
    if (!settings.loginEnabled) {
        return res.json({ success: true, token: 'disabled-mode' });
    }

    if (!password) {
        return res.status(400).json({ error: 'Password required' });
    }

    if (password === settings.loginPassword) {
        const token = crypto.randomBytes(32).toString('hex');
        activeSessions.set(token, { timestamp: Date.now() });
        return res.json({ success: true, token });
    } else {
        return res.status(401).json({ error: 'Invalid password' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.header('x-auth-token');
    if (token) {
        activeSessions.delete(token);
    }
    res.json({ success: true });
});

app.get('/api/search', requireAuth, async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    try {
        console.log(`Received search request for: ${query}`);

        // Handle site filtering (e.g. ?sites=taobao)
        let enabledOverride = null;
        if (req.query.sites) {
            const requestedSites = req.query.sites.split(',').map(s => s.trim().toLowerCase());
            // Create exclusive map - everything false unless requested
            enabledOverride = {
                mercari: false,
                yahoo: false,
                paypay: false,
                fril: false,
                surugaya: false,
                taobao: false,
                goofish: false
            };
            requestedSites.forEach(site => {
                if (enabledOverride.hasOwnProperty(site)) {
                    enabledOverride[site] = true;
                }
            });
            console.log('Site override:', enabledOverride);
        }


        const strict = req.query.strict !== 'false'; // Default true
        // Live search doesn't support complex filters array yet (only query string), so pass empty []
        // Optional: Could parse filters from query if added later.
        const results = await searchAggregator.searchAll(query, enabledOverride, strict, []);
        const filteredResults = BlockedItems.filterResults(results);
        res.json(filteredResults);
    } catch (error) {
        console.error('Search failed:', error);
        res.status(500).json({ error: 'Internal server error during search' });
    }
});

// Watchlist Routes
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Scheduler = require('./scheduler');

// Initialize Scheduler
Scheduler.start();

// Initialize Scheduler
Scheduler.start();

app.get('/api/watchlist', requireAuth, (req, res) => {
    res.json(Watchlist.getAll());
});

app.post('/api/watchlist', requireAuth, (req, res) => {
    const { term, terms } = req.body;
    if (!term && (!terms || terms.length === 0)) {
        return res.status(400).json({ error: 'Term or terms required' });
    }
    const item = Watchlist.add(req.body);
    res.json(item);
});

app.put('/api/watchlist/:id', requireAuth, (req, res) => {
    const updated = Watchlist.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    // If enabledSites changed, remove results from disabled sites
    if (req.body.enabledSites) {
        try {
            const RESULTS_FILE = path.join(__dirname, 'data/results.json');
            if (fs.existsSync(RESULTS_FILE)) {
                const resultsData = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
                const id = req.params.id;

                if (resultsData[id] && resultsData[id].items) {
                    const enabled = req.body.enabledSites;
                    const beforeCount = resultsData[id].items.length;

                    resultsData[id].items = resultsData[id].items.filter(item => {
                        const source = (item.source || '').toLowerCase();
                        if (source.includes('mercari') && enabled.mercari === false) return false;
                        if (source.includes('yahoo') && enabled.yahoo === false) return false;
                        if (source.includes('paypay') && enabled.paypay === false) return false;
                        if ((source.includes('fril') || source.includes('rakuma')) && enabled.fril === false) return false;
                        if (source.includes('suruga') && enabled.surugaya === false) return false;
                        if (source.includes('taobao') && enabled.taobao === false) return false;
                        if (source.includes('goofish') && enabled.goofish === false) return false;
                        return true;
                    });

                    if (resultsData[id].items.length !== beforeCount) {
                        resultsData[id].newCount = Math.max(0, resultsData[id].newCount - (beforeCount - resultsData[id].items.length)); // Rough adjustment
                        // Better: just recount or leave newCount? newCount tracks "unseen".
                        // If we remove items, newCount might need adjustment if removed items were "new".
                        // Safest is to just clamp it or reset if empty.
                        if (resultsData[id].items.length === 0) resultsData[id].newCount = 0;

                        fs.writeFileSync(RESULTS_FILE, JSON.stringify(resultsData, null, 2));
                        console.log(`[Watchlist] Cleaned up ${beforeCount - resultsData[id].items.length} disabled items for ${id}`);
                    }
                }
            }
        } catch (err) {
            console.error('[Watchlist] Error cleaning up disabled results:', err);
        }
    }

    res.json(updated);
});

app.post('/api/watchlist/merge', requireAuth, (req, res) => {
    const { ids, newName } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length < 2) {
        return res.status(400).json({ error: 'At least two IDs required for merge' });
    }
    const merged = Watchlist.merge(ids, newName);
    if (!merged) return res.status(500).json({ error: 'Merge failed' });
    res.json(merged);
});

app.delete('/api/watchlist/:id', requireAuth, (req, res) => {
    Watchlist.remove(req.params.id);
    res.json({ success: true });
});

app.post('/api/watchlist/reorder', requireAuth, (req, res) => {
    const { orderedIds } = req.body;
    if (!orderedIds || !Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds array required' });
    }
    const reordered = Watchlist.reorder(orderedIds);
    res.json(reordered);
});

app.get('/api/results/:id', requireAuth, (req, res) => {
    const results = Scheduler.getResults(req.params.id);
    // Filter results on read as well, in case we just blocked something
    const filtered = BlockedItems.filterResults(results ? results.items : []);
    res.json({ ...results, items: filtered } || { items: [] });
});

// Mark results as seen (clear new flags)
app.post('/api/results/:id/seen', requireAuth, (req, res) => {
    Scheduler.clearNewFlags(req.params.id);
    res.json({ success: true });
});

// Mark ALL results as seen
app.post('/api/results/mark-all-seen', requireAuth, (req, res) => {
    Scheduler.markAllSeen();
    res.json({ success: true });
});

// Get new counts for all watchlist items
app.get('/api/watchlist/newcounts', requireAuth, (req, res) => {
    res.json(Scheduler.getNewCounts());
});

// Toggle email notifications for a watchlist item
app.post('/api/watchlist/:id/toggle-email', requireAuth, (req, res) => {
    const { id } = req.params;
    const item = Watchlist.get(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const newState = item.emailNotify === false ? true : false;
    Watchlist.update(id, { emailNotify: newState });
    res.json({ emailNotify: newState });
});

app.post('/api/watchlist/:id/toggle-priority', requireAuth, (req, res) => {
    const { id } = req.params;
    const item = Watchlist.get(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Default to false if undefined
    const newState = !item.priority;
    Watchlist.update(id, { priority: newState });
    res.json({ priority: newState });
});

// Toggle active status for a watchlist item
app.post('/api/watchlist/:id/toggle-active', requireAuth, (req, res) => {
    const newState = Watchlist.toggleActive(req.params.id);
    if (newState === null) {
        return res.status(404).json({ error: 'Watchlist item not found' });
    }
    res.json({ active: newState });
});

// Blocked Items Routes
app.get('/api/blocked', requireAuth, (req, res) => {
    res.json(BlockedItems.getAll());
});

app.post('/api/blocked', requireAuth, (req, res) => {
    const { url, title, image } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const item = BlockedItems.add(url, title, image);
    res.json(item);
});

app.delete('/api/blocked/:id', requireAuth, (req, res) => {
    BlockedItems.remove(req.params.id);
    res.json({ success: true });
});

// Blacklist (term-based filtering) Routes
const Blacklist = require('./models/blacklist');

app.get('/api/blacklist', requireAuth, (req, res) => {
    res.json(Blacklist.getAll());
});

app.post('/api/blacklist', requireAuth, (req, res) => {
    const { term } = req.body;
    if (!term || !term.trim()) return res.status(400).json({ error: 'Term is required' });
    const item = Blacklist.add(term);
    if (!item) return res.status(409).json({ error: 'Term already exists' });
    res.json(item);
});

app.delete('/api/blacklist/:id', requireAuth, (req, res) => {
    Blacklist.remove(req.params.id);
    res.json({ success: true });
});

// Schedule Settings Routes
const ScheduleSettings = require('./models/schedule');

app.get('/api/schedule', (req, res) => {
    const settings = ScheduleSettings.get();
    // Add CST equivalents for frontend display
    const hoursWithCst = settings.enabledHours.map(jstHour => ({
        jst: jstHour,
        cst: ScheduleSettings.jstToCst(jstHour)
    }));
    res.json({ enabledHours: settings.enabledHours, hoursWithCst });
});

app.post('/api/schedule', requireAuth, (req, res) => {
    const { enabledHours } = req.body;
    if (!Array.isArray(enabledHours)) {
        return res.status(400).json({ error: 'enabledHours must be an array' });
    }
    const settings = ScheduleSettings.setEnabledHours(enabledHours);
    res.json({ success: true, enabledHours: settings.enabledHours });
});

// Check scheduler status
app.get('/api/status', (req, res) => {
    const settings = ScheduleSettings.get();
    const enabledHours = settings.enabledHours || [];

    // Calculate next scheduled time
    let nextScheduled = null;
    let minutesUntilNext = null;

    if (enabledHours.length > 0) {
        const now = new Date();
        const currentJstHour = (now.getUTCHours() + 9) % 24;
        const currentMinute = now.getUTCMinutes();

        // Find next enabled hour
        const sortedHours = [...enabledHours].sort((a, b) => a - b);

        // Find if there's an upcoming hour today (after current JST hour, or current hour if before :00)
        let nextHour = sortedHours.find(h => h > currentJstHour || (h === currentJstHour && currentMinute === 0));

        if (!nextHour && nextHour !== 0) {
            // Wrap to next day
            nextHour = sortedHours[0];
        }

        // Calculate minutes until next run
        if (nextHour > currentJstHour) {
            minutesUntilNext = (nextHour - currentJstHour) * 60 - currentMinute;
        } else if (nextHour === currentJstHour && currentMinute === 0) {
            minutesUntilNext = 0;
        } else {
            // Next day
            minutesUntilNext = (24 - currentJstHour + nextHour) * 60 - currentMinute;
        }

        nextScheduled = `${nextHour}:00 JST`;
    }

    res.json({
        isRunning: Scheduler.isRunning,
        progress: Scheduler.progress,
        nextScheduled,
        minutesUntilNext
    });
});

// Check if login is required (unauthenticated endpoint)
app.get('/api/auth-status', (req, res) => {
    const settings = Settings.get();
    res.json({
        loginRequired: settings.loginEnabled && !!settings.loginPassword
    });
});

// Settings Routes
app.get('/api/settings', requireAuth, (req, res) => {
    const settings = Settings.get();

    // Security: HIDE sensitive fields
    const safeSettings = {
        ...settings,
        loginPassword: null, // redacted
        smtpPass: null,      // redacted
        hasLoginPassword: !!settings.loginPassword,
        hasSmtpPass: !!settings.smtpPass
    };

    res.json(safeSettings);
});

app.post('/api/settings', requireAuth, (req, res) => {
    // Filter out computed fields that shouldn't be saved
    const { hasLoginPassword, hasSmtpPass, ...settingsToUpdate } = req.body;

    // Also filter out null values (redacted passwords sent back)
    const filtered = {};
    for (const [key, value] of Object.entries(settingsToUpdate)) {
        if (value !== null && value !== undefined) {
            filtered[key] = value;
        }
    }

    const updated = Settings.update(filtered);
    res.json(updated);
});

// Test Ntfy Notification
app.post('/api/settings/test-ntfy', requireAuth, async (req, res) => {
    // Check if enabled first to give specific error
    const settings = Settings.get();
    if (!settings.ntfyEnabled) {
        return res.status(500).json({ error: 'Failed to send Ntfy notification: Ntfy notifications not enabled' });
    }

    try {
        const success = await NtfyService.send(
            'GK Watcher Test',
            'Test Notification from GK Watcher! 🚀',
            '5',
            ['warning', 'skull']
        );

        if (!success) {
            return res.status(500).json({ error: 'Failed to send Ntfy notification' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Ntfy test failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Taobao Status Check
const taobaoScraper = require('./scrapers/taobao');
app.get('/api/taobao/status', (req, res) => {
    res.json({ hasCookies: taobaoScraper.hasValidCookies() });
});

const goofishScraper = require('./scrapers/goofish');
app.get('/api/goofish/status', (req, res) => {
    res.json({ hasCookies: goofishScraper.hasValidCookies() });
});

// Update Cookies
app.post('/api/cookies/:site', requireAuth, (req, res) => {
    try {
        const { site } = req.params;
        const { cookies } = req.body;

        if (!['taobao', 'goofish'].includes(site)) {
            return res.status(400).json({ error: 'Invalid site' });
        }

        if (!cookies) {
            return res.status(400).json({ error: 'No cookies provided' });
        }

        let cookieJson;
        try {
            // Parse if string, otherwise use as is
            cookieJson = typeof cookies === 'string' ? JSON.parse(cookies) : cookies;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON format' });
        }

        if (!Array.isArray(cookieJson)) {
            return res.status(400).json({ error: 'Cookies must be an array' });
        }

        // Write to file
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, 'data', `${site}_cookies.json`);

        fs.writeFileSync(filePath, JSON.stringify(cookieJson, null, 2));
        console.log(`[API] Updated cookies for ${site}`);

        res.json({ success: true, message: 'Cookies saved successfully' });

    } catch (err) {
        console.error('[API] Error saving cookies:', err);
        res.status(500).json({ error: 'Failed to save cookies' });
    }
});

// Abort scheduled search
app.post('/api/abort-scheduled', (req, res) => {
    Scheduler.abort();
    res.json({ success: true });
});

// Cleanup utility for managing disk space
const Cleanup = require('./utils/cleanup');

// Run cleanup manually (log rotation + expired results)
app.post('/api/cleanup', requireAuth, (req, res) => {
    try {
        const stats = Cleanup.runFullCleanup();
        res.json({
            success: true,
            message: 'Cleanup completed',
            stats
        });
    } catch (err) {
        console.error('[API] Cleanup failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get/update cleanup configuration
app.get('/api/cleanup/config', requireAuth, (req, res) => {
    res.json(Cleanup.getConfig());
});

app.post('/api/cleanup/config', requireAuth, (req, res) => {
    const updated = Cleanup.updateConfig(req.body);
    res.json({ success: true, config: updated });
});

// Manual Run - Trigger all watchlist searches now
app.post('/api/run-now', requireAuth, async (req, res) => {
    if (Scheduler.isRunning) {
        return res.status(409).json({ error: 'Search already running' });
    }

    console.log('[Manual] Running all watchlist searches (Batch)...');

    // Refresh scheduler's cache of global blacklist before running
    // Scheduler handles this internally usually, but for manual run we might need to be sure?
    // Actually Scheduler.runBatch uses its own logic. Let's check Scheduler.

    const list = Watchlist.getAll();
    const activeItems = list.filter(i => i.active !== false);

    // Fire and forget - results tracked via Scheduler.progress
    Scheduler.runBatch(activeItems, 'manual').catch(err => {
        console.error('Error in manual batch run:', err);
    });

    res.json({ success: true, message: 'Batch run started', total: activeItems.length });
});

// Manual Run - Single item
app.post('/api/run-single/:id', requireAuth, async (req, res) => {
    if (Scheduler.isRunning) {
        return res.status(409).json({ error: 'Search already running' });
    }

    const item = Watchlist.getAll().find(i => i.id === req.params.id);
    if (!item) {
        return res.status(404).json({ error: 'Watchlist item not found' });
    }

    console.log(`[Manual Single] Searching for: ${item.name}`);
    Scheduler.isRunning = true;

    try {
        const terms = item.terms || [item.term];
        let allTermResults = [];

        const settings = Settings.get();
        const globalFilters = Blacklist.getAll().map(i => i.term);
        // Unique merge of item filters and global filters
        const filters = [...new Set([...(item.filters || []), ...globalFilters])];

        for (const term of terms) {
            const results = await searchAggregator.searchAll(term, item.enabledSites, item.strict !== false, filters);
            if (results && results.length > 0) {
                allTermResults = [...allTermResults, ...results];
            }
        }

        // Deduplicate
        const uniqueResults = [];
        const seenLinks = new Set();
        for (const res of allTermResults) {
            if (!seenLinks.has(res.link)) {
                seenLinks.add(res.link);
                uniqueResults.push(res);
            }
        }

        const filtered = BlockedItems.filterResults(uniqueResults);
        const newItems = Scheduler.saveResults(item.id, filtered, item.name);
        Watchlist.updateLastRun(item.id);
        res.json({ success: true, resultCount: filtered.length, newCount: newItems.length });
    } catch (err) {
        console.error(`[Manual Single] Error:`, err);
        res.status(500).json({ error: err.message });
    } finally {
        Scheduler.isRunning = false;
    }
});


// Test email endpoint
const EmailService = require('./emailService');

app.post('/api/settings/test-email', async (req, res) => {
    try {
        const result = await EmailService.sendTestEmail();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

