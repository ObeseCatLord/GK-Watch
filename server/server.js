const express = require('express');
const cors = require('cors');
const path = require('path');
const searchAggregator = require('./scrapers');
const Settings = require('./models/settings');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Endpoint
const crypto = require('crypto');

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
        const results = await searchAggregator.searchAll(query);
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
    const newState = Watchlist.toggleEmailNotify(req.params.id);
    if (newState === null) {
        return res.status(404).json({ error: 'Watchlist item not found' });
    }
    res.json({ emailNotify: newState });
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
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const item = BlockedItems.add(url, title);
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
    const settings = Settings.get();

    if (!settings.ntfyTopic) {
        return res.status(400).json({ error: 'Ntfy Topic is required' });
    }

    const serverUrl = settings.ntfyServer || 'https://ntfy.sh';
    const topic = settings.ntfyTopic;
    const url = `${serverUrl}/${topic}`;

    console.log(`[Ntfy] Sending test notification to ${url}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            body: 'Test Notification from GK Watcher! 🚀',
            headers: {
                'Title': 'GK Watcher Test',
                'Priority': '5',
                'Tags': 'warning,skull'
            }
        });

        if (!response.ok) {
            throw new Error(`Ntfy returned status ${response.status}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ntfy test failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// Abort scheduled search
app.post('/api/abort-scheduled', (req, res) => {
    Scheduler.abort();
    res.json({ success: true });
});

// Manual Run - Trigger all watchlist searches now
app.post('/api/run-now', requireAuth, async (req, res) => {
    if (Scheduler.isRunning) {
        return res.status(409).json({ error: 'Search already running' });
    }

    console.log('[Manual] Running all watchlist searches (Batch)...');

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

        for (const term of terms) {
            const results = await searchAggregator.searchAll(term);
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

