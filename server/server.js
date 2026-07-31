// Files created by this process (keys, cookies, sessions/logs) default to owner-only.
process.umask(0o077);

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const helmet = require('helmet');
let compression = null;
try { compression = require('compression'); } catch (_) { console.warn('[Server] compression is not installed; response compression is disabled until it is added.'); }
const searchAggregator = require('./scrapers');
const Settings = require('./models/settings');
const db = require('./models/database');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const COOKIE_FILES = ['taobao_cookies.json', 'goofish_cookies.json', 'mandarake_cookies.json'];
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(DATA_DIR, 0o700);
for (const cookieFile of COOKIE_FILES) {
    const cookiePath = path.join(DATA_DIR, cookieFile);
    if (fs.existsSync(cookiePath)) fs.chmodSync(cookiePath, 0o600);
}
const isProduction = process.env.NODE_ENV === 'production';

// Only trust a directly connected loopback reverse proxy. The first untrusted
// address from X-Forwarded-For remains the client key used by rate limiting.
app.set('trust proxy', (address, index) => index === 0 && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'));

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-eval'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"], // Allow images from any HTTPS source
            connectSrc: isProduction ? ["'self'"] : ["'self'", "ws:", "wss:"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false
}));

if (compression) {
    app.use(compression({ filter: (req, res) => req.headers.accept !== 'text/event-stream' && compression.filter(req, res) }));
}
app.use(express.json());



// API Endpoint
const rateLimit = require('express-rate-limit');
const configuredApiRateLimit = Number(process.env.GKWATCH_API_RATE_LIMIT);
const apiRateLimitMax = Number.isInteger(configuredApiRateLimit) && configuredApiRateLimit >= 10 && configuredApiRateLimit <= 100000
    ? configuredApiRateLimit
    : 1000;

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: apiRateLimitMax,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again later.' }
});

const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // Limit each IP to 10 login attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts, please try again after 5 minutes.' }
});

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);
// Apply strict limit to login
app.use('/api/login', loginLimiter);
const crypto = require('crypto');
const NtfyService = require('./utils/ntfyService');

const SESSION_TIMEOUT = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'gkwatch_session';

// Session Management Statements
const sessionStmts = {
    insert: db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    delete: db.prepare('DELETE FROM sessions WHERE token = ?'),
    cleanup: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    deleteAll: db.prepare('DELETE FROM sessions')
};

const digestSessionToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isSessionToken = (token) => typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);

// Existing rows contain raw bearer tokens. Invalidate them exactly once so a
// database read cannot yield a usable session after this upgrade.
db.transaction(() => {
    const marker = db.prepare("SELECT value FROM settings WHERE key = '__session_digest_v1'").get();
    if (!marker) {
        sessionStmts.deleteAll.run();
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('__session_digest_v1', 'true')").run();
    }
})();

function cookieToken(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
        try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch (_) { return null; }
    }
    return null;
}

function sessionForToken(token) {
    if (!isSessionToken(token)) return null;
    const tokenDigest = digestSessionToken(token);
    const session = sessionStmts.get.get(tokenDigest);
    if (!session) return null;
    if (Date.now() > session.expires_at) {
        sessionStmts.delete.run(tokenDigest);
        return null;
    }
    return session;
}

function sameOriginRequest(req) {
    const origin = req.get('origin');
    if (!origin) return false;
    try {
        const parsed = new URL(origin);
        return parsed.protocol === `${req.protocol}:` && parsed.host === req.get('host');
    } catch (_) {
        return false;
    }
}

// Periodically clean up expired sessions
// Periodically clean up expired sessions
if (require.main === module) {
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
}

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    // Check if login is enabled in settings
    const settings = Settings.get();

    // If login is disabled OR no password is set, bypass auth
    if (!settings.loginEnabled) {
        return next();
    }

    if (!settings.loginPassword) {
        return res.status(503).json({ error: 'Authentication configuration is unavailable' });
    }

    const cookie = cookieToken(req);
    const token = cookie || req.header('x-auth-token');

    if (!isSessionToken(token)) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }
    const session = sessionForToken(token);
    if (!session) return res.status(401).json({ error: 'Token is invalid or expired' });

    if (cookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOriginRequest(req)) {
        return res.status(403).json({ error: 'Cross-origin request denied' });
    }

    return next();
};


// Login Routes
app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    const settings = Settings.get();

    // If login is disabled, just return success with dummy token
    if (!settings.loginEnabled) {
        return res.json({ success: true, token: 'disabled-mode' });
    }

    if (typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Password required' });
    }

    if (await Settings.verifyLoginPassword(password)) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + SESSION_TIMEOUT;
        sessionStmts.cleanup.run(Date.now());
        sessionStmts.insert.run(digestSessionToken(token), expiresAt);
        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'strict',
            path: '/',
            maxAge: SESSION_TIMEOUT
        });
        return res.json({ success: true, ...(process.env.NODE_ENV === 'test' ? { token } : {}) });
    } else {
        return res.status(401).json({ error: 'Invalid password' });
    }
});


app.post('/api/logout', (req, res) => {
    const token = cookieToken(req) || req.header('x-auth-token');
    if (isSessionToken(token)) {
        sessionStmts.delete.run(digestSessionToken(token));
    }
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' });
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
                goofish: false,
                mandarake: false
            };
            requestedSites.forEach(site => {
                if (enabledOverride.hasOwnProperty(site)) {
                    enabledOverride[site] = true;
                }
            });
            console.log('Site override:', enabledOverride);
        }

        const strict = req.query.strict !== 'false'; // Default true
        const siteOptions = {};
        if (req.query.mandarakeMode === 'garageKit') {
            siteOptions.mandarake = { mode: 'garageKit' };
        } else if (req.query.mandarakeMode === 'full') {
            siteOptions.mandarake = { mode: 'full' };
        }

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

            const abortController = new AbortController();
            let clientDisconnected = false;
            const onRequestClose = () => {
                clientDisconnected = true;
                abortController.abort();
                clearInterval(keepAlive);
            };

            // Keep connection alive with heartbeat every 5s (more frequent to prevent proxy timeouts)
            const keepAlive = setInterval(() => {
                if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
                    res.write(': keep-alive\n\n');
                }
            }, 5000);

            // A disconnected client must not retain queued or streaming scraper work.
            req.on('aborted', onRequestClose);
            res.on('close', onRequestClose);

            const onProgress = (data) => {
                if (clientDisconnected || abortController.signal.aborted || res.writableEnded || res.destroyed) return;
                // If we have results, filter them before sending
                if (data.type === 'result' && data.items) {
                    let filtered = BlockedItems.filterResults(data.items);
                    filtered = Blacklist.filterResults(filtered);
                    data.items = FavoriteItems.annotateResults(filtered);
                }
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            try {
                await searchAggregator.searchAll(query, enabledOverride, strict, filters, onProgress, siteOptions, abortController.signal);
                if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                }
            } catch (err) {
                if (!abortController.signal.aborted) {
                    console.error('SSE Search error:', err);
                    if (!res.writableEnded && !res.destroyed) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
                    }
                }
            } finally {
                clearInterval(keepAlive);
                req.removeListener('aborted', onRequestClose);
                res.removeListener('close', onRequestClose);
                if (!res.writableEnded && !res.destroyed) res.end();
            }
            return;
        }

        // Legacy blocking behavior
        const results = await searchAggregator.searchAll(query, enabledOverride, strict, filters, null, siteOptions);
        let filteredResults = BlockedItems.filterResults(results);
        filteredResults = Blacklist.filterResults(filteredResults);
        res.json(FavoriteItems.annotateResults(filteredResults));
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
const FavoriteItems = require('./models/favorite_items');
const Scheduler = require('./scheduler');

// Initialize Scheduler
if (require.main === module) {
    Scheduler.start();
}

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
    const query = req.query || {};
    const queryKeys = ['page', 'pageSize', 'sort', 'order', 'filter', 'source'];
    const hasQueryOptions = queryKeys.some(key => query[key] !== undefined);
    const parsePositiveInteger = (value, name, max) => {
        if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
        return Number(value);
    };
    let options;
    try {
        if (hasQueryOptions) {
            const sortValues = new Set(['firstSeen', 'lastSeen', 'price', 'title', 'source', 'favorite']);
            const orderValues = new Set(['asc', 'desc']);
            if (query.sort !== undefined && !sortValues.has(query.sort)) throw new Error('sort is invalid');
            if (query.order !== undefined && !orderValues.has(String(query.order).toLowerCase())) throw new Error('order must be asc or desc');
            if (query.filter !== undefined && (typeof query.filter !== 'string' || query.filter.length > 200 || /[\u0000-\u001f\u007f]/.test(query.filter))) throw new Error('filter is invalid');
            if (query.source !== undefined && (typeof query.source !== 'string' || query.source.length > 100 || /[\u0000-\u001f\u007f]/.test(query.source))) throw new Error('source is invalid');
            options = {
                page: query.page === undefined ? 1 : parsePositiveInteger(query.page, 'page', 100000),
                pageSize: query.pageSize === undefined ? 50 : parsePositiveInteger(query.pageSize, 'pageSize', 100),
                sortBy: query.sort || 'firstSeen',
                sortDirection: String(query.order || 'desc').toLowerCase(),
                search: typeof query.filter === 'string' ? query.filter.trim() : '',
                source: typeof query.source === 'string' ? query.source.trim() : '',
                hidden: false
            };
        }
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
    const results = await Scheduler.getResults(req.params.id, options);
    // Filter results on read as well, in case we just blocked something
    // Also filter out HIDDEN items (grace period preservation)
    let items = results ? results.items : [];
    items = items.filter(i => !i.hidden);
    const filtered = BlockedItems.filterResults(items);
    const annotated = FavoriteItems.annotateResults(filtered);
    if (!hasQueryOptions) return res.json(results ? { ...results, items: annotated } : { items: [] });
    const total = Number.isInteger(results?.total) ? results.total : annotated.length;
    const page = Number.isInteger(results?.page) ? results.page : options.page;
    const pageSize = Number.isInteger(results?.pageSize) ? results.pageSize : options.pageSize;
    return res.json({ ...(results || {}), items: annotated, total, page, pageSize, totalPages: Number.isInteger(results?.totalPages) ? results.totalPages : Math.ceil(total / pageSize) });

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

app.post('/api/blocked/clear-missing', requireAuth, (req, res) => {
    const removed = BlockedItems.clearMissingFromResults();
    res.json({ success: true, removed });
});

app.delete('/api/blocked/:id', requireAuth, (req, res) => {
    BlockedItems.remove(req.params.id);
    res.json({ success: true });
});

// Favorite Items Routes
app.get('/api/favorites', requireAuth, (req, res) => {
    res.json(FavoriteItems.getAll());
});

app.post('/api/favorites', requireAuth, (req, res) => {
    const { url, link, title, image, price, source, bidPrice, binPrice } = req.body || {};
    const itemUrl = url || link;
    if (!itemUrl) return res.status(400).json({ error: 'URL is required' });
    res.json(FavoriteItems.add(itemUrl, title, image, price, source, bidPrice, binPrice));
});

app.post('/api/favorites/toggle', requireAuth, (req, res) => {
    const item = req.body || {};
    if (!item.url && !item.link) return res.status(400).json({ error: 'URL is required' });
    res.json(FavoriteItems.toggle(item));
});

app.post('/api/favorites/clear-missing', requireAuth, (req, res) => {
    const removed = FavoriteItems.clearMissingFromResults();
    res.json({ success: true, removed });
});

app.delete('/api/favorites/:id', requireAuth, (req, res) => {
    FavoriteItems.remove(req.params.id);
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
    const slotsWithCst = (settings.enabledSlots || []).map(jstSlot => {
        const cstSlot = (jstSlot - (15 * 60) + (24 * 60)) % (24 * 60);
        return {
            jstSlot,
            jst: ScheduleSettings.formatSlot(jstSlot),
            cst: ScheduleSettings.formatSlot(cstSlot)
        };
    });

    res.json({
        enabledHours: settings.enabledHours,
        enabledSlots: settings.enabledSlots,
        disabledHalfHourSlots: settings.disabledHalfHourSlots,
        intervalMinutes: settings.intervalMinutes,
        hoursWithCst,
        slotsWithCst
    });
});


app.post('/api/schedule', requireAuth, (req, res) => {
    const { enabledHours, enabledSlots, disabledHalfHourSlots, intervalMinutes } = req.body;
    if (intervalMinutes !== undefined && ![30, 60].includes(Number(intervalMinutes))) {
        return res.status(400).json({ error: 'intervalMinutes must be 30 or 60' });
    }
    if (enabledSlots !== undefined && !Array.isArray(enabledSlots)) {
        return res.status(400).json({ error: 'enabledSlots must be an array' });
    }
    if (disabledHalfHourSlots !== undefined && !Array.isArray(disabledHalfHourSlots)) {
        return res.status(400).json({ error: 'disabledHalfHourSlots must be an array' });
    }
    if (enabledSlots === undefined && !Array.isArray(enabledHours)) {
        return res.status(400).json({ error: 'enabledHours must be an array' });
    }
    const settings = ScheduleSettings.setSchedule({ enabledHours, enabledSlots, disabledHalfHourSlots, intervalMinutes });
    res.json({
        success: true,
        enabledHours: settings.enabledHours,
        enabledSlots: settings.enabledSlots,
        disabledHalfHourSlots: settings.disabledHalfHourSlots,
        intervalMinutes: settings.intervalMinutes
    });
});

// Check scheduler status
app.get('/api/status', requireAuth, (req, res) => {

    const settings = ScheduleSettings.get();
    const enabledSlots = (settings.enabledSlots || [])
        .filter(slot => slot % (settings.intervalMinutes || 60) === 0);

    // Calculate next scheduled time
    let nextScheduled = null;
    let minutesUntilNext = null;

    if (enabledSlots.length > 0) {
        const now = new Date();
        const currentJstSlot = (((now.getUTCHours() + 9) % 24) * 60) + now.getUTCMinutes();

        // Find next enabled slot
        const sortedSlots = [...enabledSlots].sort((a, b) => a - b);
        let nextSlot = sortedSlots.find(slot => slot >= currentJstSlot);

        if (nextSlot === undefined) {
            // Wrap to next day
            nextSlot = sortedSlots[0];
        }

        // Calculate minutes until next run
        minutesUntilNext = nextSlot >= currentJstSlot
            ? nextSlot - currentJstSlot
            : (24 * 60) - currentJstSlot + nextSlot;

        nextScheduled = `${ScheduleSettings.formatSlot(nextSlot)} JST`;
    }

    res.json({
        isRunning: Scheduler.isRunning,
        progress: Scheduler.progress,
        completionVersion: Scheduler.completionVersion,
        nextScheduled,
        minutesUntilNext,
        admission: searchAggregator.getAdmissionStats?.()
    });
});

// Check if login is required (unauthenticated endpoint)
app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        return res.json({ status: 'ok' });
    } catch (_) {
        return res.status(503).json({ status: 'unhealthy' });
    }
});

app.get('/api/auth-status', (req, res) => {
    const settings = Settings.get();
    res.json({
        loginRequired: settings.loginEnabled,
        authenticated: !settings.loginEnabled || !!sessionForToken(cookieToken(req) || req.header('x-auth-token'))
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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Settings payload must be an object' });
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
        res.status(400).json({ error: err.message });
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

const mandarakeScraper = require('./scrapers/mandarake');
app.get('/api/mandarake/status', requireAuth, (req, res) => {
    res.json({ hasCookies: mandarakeScraper.hasValidCookies() });
});

// Update Cookies
app.post('/api/cookies/:site', requireAuth, async (req, res) => {
    try {
        const { site } = req.params;
        const { cookies } = req.body;

        if (!['taobao', 'goofish', 'mandarake'].includes(site)) {
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
        const filePath = path.join(DATA_DIR, `${site}_cookies.json`);

        await fsp.writeFile(filePath, JSON.stringify(cookieJson, null, 2), { mode: 0o600 });
        await fsp.chmod(filePath, 0o600);
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
        const confirmed = req.body?.confirm === true;
        const stats = Cleanup.runFullCleanup({ dryRun: !confirmed });
        res.json({
            success: true,
            requiresConfirmation: !confirmed,
            message: confirmed ? 'Cleanup completed' : 'Cleanup preview completed',
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
    const limits = {
        maxLogSizeBytes: [64 * 1024, 100 * 1024 * 1024],
        logLinesToKeep: [10, 100000],
        resultsMaxAgeDays: [1, 365]
    };
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Cleanup configuration must be an object' });
    for (const [key, value] of Object.entries(req.body)) {
        const range = limits[key];
        if (!range || !Number.isInteger(value) || value < range[0] || value > range[1]) {
            return res.status(400).json({ error: `Invalid cleanup configuration: ${key}` });
        }
    }
    try {
        const updated = Cleanup.updateConfig(req.body);
        return res.json({ success: true, config: updated });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid cleanup configuration' });
    }
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

    let searchStarted = false;
    try {
        const allItems = await Watchlist.getAll();
        const item = allItems.find(i => i.id === req.params.id);

        if (!item) {
            return res.status(404).json({ error: 'Watchlist item not found' });
        }

        console.log(`[Manual Single] Searching for: ${item.name}`);
        Scheduler.isRunning = true;
        searchStarted = true;

        const terms = item.terms || [item.term];
        const uniqueResultsMap = new Map();

        const settings = Settings.get();
        const globalFilters = Blacklist.getAll().map(i => i.term);
        // Unique merge of item filters and global filters
        const filters = [...new Set([...(item.filters || []), ...globalFilters])];

        const resultsArray = await Promise.all(terms.map(term =>
            searchAggregator.searchAll(term, item.enabledSites, item.strict !== false, filters, null, item.siteOptions || {})
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
        if (searchStarted) {
            Scheduler.isRunning = false;
            Scheduler.completionVersion += 1;
        }
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
    const assetsPath = path.join(clientBuildPath, 'assets');
    if (fs.existsSync(assetsPath)) {
        app.use('/assets', express.static(assetsPath, {
            maxAge: 365 * 24 * 60 * 60 * 1000,
            immutable: true,
            setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }));
    }
    app.use(express.static(clientBuildPath, {
        maxAge: 0,
        setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
    }));
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;

module.exports = app;
