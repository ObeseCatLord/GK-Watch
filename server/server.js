const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const searchAggregator = require('./scrapers');
const Settings = require('./models/settings');
const db = require('./models/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // For Vite/React
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"], // Allow images from any HTTPS source
            connectSrc: ["'self'", "ws:", "wss:"], // For HMR WebSocket
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(express.json());

// Global Rate Limiter for API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

// Apply global rate limiter to all API routes
app.use('/api/', apiLimiter);

// Rate limiting for login endpoint
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});


// API Endpoint
const crypto = require('crypto');
const NtfyService = require('./utils/ntfyService');

const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// Session Management Statements
const sessionStmts = {
    insert: db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    delete: db.prepare('DELETE FROM sessions WHERE token = ?'),
    cleanup: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
};

// Periodically clean up expired sessions
setInterval(() => {
    const now = Date.now();
    try {
        const result = sessionStmts.cleanup.run(now);
        if (result.changes > 0) {
            console.log(`[Session] Cleaned up ${result.changes} expired sessions`);
        }
    } catch (e) {
        console.error('[Session] Cleanup failed:', e);
    }
}, 60 * 60 * 1000); // Check every hour

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    // Check if login is enabled in settings
    const settings = Settings.get();

    // If login is disabled OR no password is set, bypass auth
    if (!settings.loginEnabled || !settings.loginPassword) {
        return next();
    }

    const token = req.header('x-auth-token');

    if (!token) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }

    const session = sessionStmts.get.get(token);
    if (!session) {
        return res.status(401).json({ error: 'Token is invalid or expired' });
    }

    // Check session expiry
    if (Date.now() > session.expires_at) {
        sessionStmts.delete.run(token);
        return res.status(401).json({ error: 'Session expired. Please login again.' });
    }

    // Refresh session timestamp on activity (extend by timeout)
    // Only extend if it's older than 1 hour to reduce DB writes?
    // For now, let's extend if remaining time is < 23 hours (i.e. 1 hour passed)
    if (session.expires_at - Date.now() < SESSION_TIMEOUT - (60 * 60 * 1000)) {
         sessionStmts.extend.run(Date.now() + SESSION_TIMEOUT, token);
    }

    return next();
};


// Login Routes (with rate limiting)
app.post('/api/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    const settings = Settings.get();

    // If login is disabled, just return success with dummy token
    if (!settings.loginEnabled) {
        return res.json({ success: true, token: 'disabled-mode' });
    }

    if (!password) {
        return res.status(400).json({ error: 'Password required' });
    }

    // Timing-safe password comparison
    const storedPassword = settings.loginPassword || '';
    const inputPassword = password || '';

    // Pad to same length for timing-safe comparison
    const maxLen = Math.max(storedPassword.length, inputPassword.length);
    const paddedStored = storedPassword.padEnd(maxLen, '\0');
    const paddedInput = inputPassword.padEnd(maxLen, '\0');

    const isMatch = crypto.timingSafeEqual(
        Buffer.from(paddedStored, 'utf8'),
        Buffer.from(paddedInput, 'utf8')
    );

    if (isMatch && storedPassword.length === inputPassword.length) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + SESSION_TIMEOUT;
        sessionStmts.insert.run(token, expiresAt);
        return res.json({ success: true, token });
    } else {
        return res.status(401).json({ error: 'Invalid password' });
    }
});


app.post('/api/logout', (req, res) => {
    const token = req.header('x-auth-token');
    if (token) {
        sessionStmts.delete.run(token);
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

        // Handle negative filters (complex filters)
        // Supports array format (?filters[]=foo&filters[]=bar) or comma-separated string (?filters=foo,bar)
        let userFilters = [];
        if (req.query.filters) {
            if (Array.isArray(req.query.filters)) {
                userFilters = req.query.filters;
            } else if (typeof req.query.filters === 'string') {
                userFilters = req.query.filters.split(',');
            }
        }
        // Clean up filters
        userFilters = userFilters.map(f => f.trim()).filter(f => f.length > 0);

        // Pass global blacklist filters for scraper optimization.
        const globalFilters = Blacklist.getAll().map(i => i.term);

        // Combine user filters and global filters (deduplicated)
        const filters = [...new Set([...globalFilters, ...userFilters])];

        // Check for SSE request
        if (req.headers.accept === 'text/event-stream') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            // Nginx specific: Disable buffering to allow immediate flush of keep-alive packets
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            console.log('Starting SSE search stream...');

            // Keep connection alive with heartbeat every 5s (more frequent to prevent proxy timeouts)
            const keepAlive = setInterval(() => {
                res.write(': keep-alive\n\n');
            }, 5000);

            // Ensure we clear interval if client disconnects
            req.on('close', () => clearInterval(keepAlive));

            const onProgress = (data) => {
                // If we have results, filter them before sending
                if (data.type === 'result' && data.items) {
                    let filtered = BlockedItems.filterResults(data.items);
                    filtered = Blacklist.filterResults(filtered);
                    data.items = filtered;
                }
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            try {
                await searchAggregator.searchAll(query, enabledOverride, strict, filters, onProgress);
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } catch (err) {
                console.error('SSE Search error:', err);
                res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            } finally {
                clearInterval(keepAlive);
                res.end();
            }
            return;
        }

        // Legacy blocking behavior
        const results = await searchAggregator.searchAll(query, enabledOverride, strict, filters);
        let filteredResults = BlockedItems.filterResults(results);
        filteredResults = Blacklist.filterResults(filteredResults);
        res.json(filteredResults);
    } catch (error) {
        console.error('Search failed:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error during search' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal Server Error' })}\n\n`);
            res.end();
        }
    }
});

// Watchlist Routes
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Scheduler = require('./scheduler');

// Initialize Scheduler
Scheduler.start();

app.get('/api/watchlist', requireAuth, async (req, res) => {
    try {
        res.json(await Watchlist.getAll());
    } catch (err) {
        res.status(500).json({ error: 'Failed to get watchlist' });
    }
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
    try {
        const { term, terms } = req.body;
        if (!term && (!terms || terms.length === 0)) {
            return res.status(400).json({ error: 'Term or terms required' });
        }
        const item = await Watchlist.add(req.body);
        res.json(item);
    } catch (err) {
        res.status(500).json({ error: 'Failed to add to watchlist' });
    }
});

app.put('/api/watchlist/:id', requireAuth, async (req, res) => {
    try {
        const updated = await Watchlist.update(req.params.id, req.body);
        if (!updated) return res.status(404).json({ error: 'Item not found' });

        // If enabledSites changed, remove results from disabled sites
        if (req.body.enabledSites) {
            try {
                await Scheduler.pruneResults(req.params.id, req.body.enabledSites);
            } catch (err) {
                console.error('[Watchlist] Error cleaning up disabled results:', err);
            }
        }

        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update watchlist' });
    }
});


app.post('/api/watchlist/merge', requireAuth, async (req, res) => {
    try {
        const { ids, newName } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length < 2) {
            return res.status(400).json({ error: 'At least two IDs required for merge' });
        }
        const merged = await Watchlist.merge(ids, newName);
        if (!merged) return res.status(500).json({ error: 'Merge failed' });
        res.json(merged);
    } catch (err) {
        res.status(500).json({ error: 'Failed to merge watchlist items' });
    }
});

app.delete('/api/watchlist/:id', requireAuth, async (req, res) => {
    try {
        await Watchlist.remove(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove from watchlist' });
    }
});

app.post('/api/watchlist/reorder', requireAuth, async (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!orderedIds || !Array.isArray(orderedIds)) {
            return res.status(400).json({ error: 'orderedIds array required' });
        }
        const reordered = await Watchlist.reorder(orderedIds);
        res.json(reordered);
    } catch (err) {
        res.status(500).json({ error: 'Failed to reorder watchlist' });
    }
});

app.get('/api/results/:id', requireAuth, async (req, res) => {
    const results = await Scheduler.getResults(req.params.id);
    // Filter results on read as well, in case we just blocked something
    // Also filter out HIDDEN items (grace period preservation)
    let items = results ? results.items : [];
    items = items.filter(i => !i.hidden);
    const filtered = BlockedItems.filterResults(items);
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
app.get('/api/watchlist/newcounts', requireAuth, async (req, res) => {
    res.json(await Scheduler.getNewCounts());
});

// Toggle email notifications for a watchlist item
app.post('/api/watchlist/:id/toggle-email', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const item = await Watchlist.get(id);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const newState = item.emailNotify === false ? true : false;
        await Watchlist.update(id, { emailNotify: newState });
        res.json({ emailNotify: newState });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle email' });
    }
});

app.post('/api/watchlist/:id/toggle-priority', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const item = await Watchlist.get(id);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        // Default to false if undefined
        const newState = !item.priority;
        await Watchlist.update(id, { priority: newState });
        res.json({ priority: newState });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle priority' });
    }
});

// Toggle active status for a watchlist item
app.post('/api/watchlist/:id/toggle-active', requireAuth, async (req, res) => {
    try {
        const newState = await Watchlist.toggleActive(req.params.id);
        if (newState === null) {
            return res.status(404).json({ error: 'Watchlist item not found' });
        }
        res.json({ active: newState });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle active' });
    }
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

app.put('/api/blacklist', requireAuth, (req, res) => {
    const { terms } = req.body;
    if (!Array.isArray(terms)) {
        return res.status(400).json({ error: 'Terms array is required' });
    }
    const newList = Blacklist.replaceAll(terms);
    res.json(newList);
});

// Schedule Settings Routes
const ScheduleSettings = require('./models/schedule');

app.get('/api/schedule', requireAuth, (req, res) => {
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
app.get('/api/status', requireAuth, (req, res) => {

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

app.post('/api/settings', requireAuth, async (req, res) => {
    // Filter out computed fields that shouldn't be saved
    const { hasLoginPassword, hasSmtpPass, ...settingsToUpdate } = req.body;

    // Also filter out null values (redacted passwords sent back)
    const filtered = {};
    for (const [key, value] of Object.entries(settingsToUpdate)) {
        if (value !== null && value !== undefined) {
            filtered[key] = value;
        }
    }

    try {
        const updated = await Settings.update(filtered);
        res.json(updated);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
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
            5,
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
app.get('/api/taobao/status', requireAuth, (req, res) => {
    res.json({ hasCookies: taobaoScraper.hasValidCookies() });
});


const goofishScraper = require('./scrapers/goofish');
app.get('/api/goofish/status', requireAuth, (req, res) => {

    res.json({ hasCookies: goofishScraper.hasValidCookies() });
});

// Update Cookies
app.post('/api/cookies/:site', requireAuth, async (req, res) => {
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
        const filePath = path.join(__dirname, 'data', `${site}_cookies.json`);

        await fsp.writeFile(filePath, JSON.stringify(cookieJson, null, 2));
        console.log(`[API] Updated cookies for ${site}`);

        res.json({ success: true, message: 'Cookies saved successfully' });

    } catch (err) {
        console.error('[API] Error saving cookies:', err);
        res.status(500).json({ error: 'Failed to save cookies' });
    }
});

// Abort scheduled search
app.post('/api/abort-scheduled', requireAuth, (req, res) => {
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

    try {
        const list = await Watchlist.getAll();
        const activeItems = list.filter(i => i.active !== false);

        // Fire and forget - results tracked via Scheduler.progress
        Scheduler.runBatch(activeItems, 'manual').catch(err => {
            console.error('Error in manual batch run:', err);
        });

        res.json({ success: true, message: 'Batch run started', total: activeItems.length });
    } catch (err) {
        res.status(500).json({ error: 'Failed to run now' });
    }
});

// Manual Run - Single item
app.post('/api/run-single/:id', requireAuth, async (req, res) => {
    if (Scheduler.isRunning) {
        return res.status(409).json({ error: 'Search already running' });
    }

    try {
        const allItems = await Watchlist.getAll();
        const item = allItems.find(i => i.id === req.params.id);

        if (!item) {
            return res.status(404).json({ error: 'Watchlist item not found' });
        }

        console.log(`[Manual Single] Searching for: ${item.name}`);
        Scheduler.isRunning = true;

        const terms = item.terms || [item.term];
        const uniqueResultsMap = new Map();

        const settings = Settings.get();
        const globalFilters = Blacklist.getAll().map(i => i.term);
        // Unique merge of item filters and global filters
        const filters = [...new Set([...(item.filters || []), ...globalFilters])];

        const resultsArray = await Promise.all(terms.map(term =>
            searchAggregator.searchAll(term, item.enabledSites, item.strict !== false, filters)
        ));

        for (const results of resultsArray) {
            if (results && results.length > 0) {
                for (const res of results) {
                    if (!uniqueResultsMap.has(res.link)) {
                        uniqueResultsMap.set(res.link, res);
                    }
                }
            }
        }

        const uniqueResults = Array.from(uniqueResultsMap.values());

        const filtered = BlockedItems.filterResults(uniqueResults);
        const { newItems, totalCount } = Scheduler.saveResults(item.id, filtered, item.name);
        await Watchlist.updateLastRun(item.id, totalCount);
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

app.post('/api/settings/test-email', requireAuth, async (req, res) => {
    try {
        const result = await EmailService.sendTestEmail();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve static files from React app if they exist
const clientBuildPath = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
    app.get('*', (req, res) => {
        // Don't intercept API 404s
        if (req.path.startsWith('/api/')) {
             return res.status(404).json({ error: 'Not Found' });
        }
        const indexFile = path.join(clientBuildPath, 'index.html');
        if (fs.existsSync(indexFile)) {
            res.sendFile(indexFile);
        } else {
            res.status(404).send('Client build found but index.html missing.');
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
