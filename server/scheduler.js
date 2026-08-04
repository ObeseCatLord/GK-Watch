const cron = require('node-cron');
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Blacklist = require('./models/blacklist');
const FavoriteItems = require('./models/favorite_items');
const ScheduleSettings = require('./models/schedule');
const Settings = require('./models/settings');
const EmailService = require('./emailService');
const NtfyService = require('./utils/ntfyService');
const Cleanup = require('./utils/cleanup');
const searchAggregator = require('./scrapers');
const db = require('./models/database');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAYPAY_SOLD_RETENTION_MS = DAY_MS;
const PAYPAY_GRACE_PERIOD_MS = 2 * DAY_MS;
const RESUME_FILE = path.join(__dirname, 'data/resume.json');
const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RESUME_FILE_BYTES = 1024 * 1024;
const MAX_BATCH_CONCURRENCY = 5;
const RESULT_SORT_COLUMNS = Object.freeze({
    firstSeen: 'first_seen',
    lastSeen: 'last_seen',
    title: 'title',
    source: 'source',
    price: 'price',
    isNew: 'is_new',
    favorite: '(EXISTS (SELECT 1 FROM favorite_items favorite_sort WHERE favorite_sort.url = results.link))'
});

function normalizeConcurrency(value) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return 3;
    return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.floor(parsed)));
}

function sourceKey(source) {
    const normalized = String(source || '').toLowerCase();
    if (normalized.includes('yahoo')) return 'yahoo';
    if (normalized.includes('suruga')) return 'suruga';
    if (normalized.includes('mercari')) return 'mercari';
    if (normalized.includes('paypay')) return 'paypay';
    if (normalized.includes('fril') || normalized.includes('rakuma')) return 'fril';
    if (normalized.includes('taobao')) return 'taobao';
    if (normalized.includes('goofish')) return 'goofish';
    if (normalized.includes('mandarake')) return 'mandarake';
    return normalized;
}

function createSourceOutcomeTracker() {
    const successful = new Set();
    const failed = new Set();

    return {
        onProgress(data) {
            const key = sourceKey(data?.source);
            if (!key) return;
            if (data.type === 'error') {
                failed.add(key);
            } else if (data.type === 'result' && data.partial === false) {
                if (Array.isArray(data.items) && data.items.some(item => item?.error)) failed.add(key);
                else successful.add(key);
            }
        },
        successfulSources() {
            return new Set([...successful].filter(key => !failed.has(key)));
        }
    };
}

function validateResumeState(state, now = Date.now()) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    if (!['manual', 'scheduled'].includes(state.type)) return null;
    if (!Array.isArray(state.items) || state.items.length === 0 || state.items.length > 10000) return null;
    if (state.items.some(id => typeof id !== 'string' || !id.trim()) || new Set(state.items).size !== state.items.length) return null;
    if (!Number.isSafeInteger(state.currentIndex) || state.currentIndex < 0 || state.currentIndex >= state.items.length) return null;
    if (!Number.isFinite(state.timestamp) || state.timestamp > now + 5 * 60 * 1000 || now - state.timestamp > MAX_RESUME_AGE_MS) return null;

    return {
        type: state.type,
        currentIndex: state.currentIndex,
        items: state.items,
        timestamp: state.timestamp
    };
}

function fsyncDirectory(directory) {
    // Directory fsync is not supported on every platform/filesystem.
    try {
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (err) {
        if (!['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(err.code)) throw err;
    }
}

function writeResumeState(state) {
    const directory = path.dirname(RESUME_FILE);
    const tempFile = path.join(directory, `.resume-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    let fileDescriptor;

    try {
        fs.mkdirSync(directory, { recursive: true });
        fileDescriptor = fs.openSync(tempFile, 'w', 0o600);
        fs.writeFileSync(fileDescriptor, JSON.stringify(state));
        fs.fsyncSync(fileDescriptor);
        fs.closeSync(fileDescriptor);
        fileDescriptor = null;
        fs.renameSync(tempFile, RESUME_FILE);
        fsyncDirectory(directory);
    } catch (err) {
        if (fileDescriptor !== undefined) {
            try { fs.closeSync(fileDescriptor); } catch (_) { /* best effort */ }
        }
        try { fs.unlinkSync(tempFile); } catch (_) { /* best effort */ }
        throw err;
    }
}

function removeResumeState() {
    try {
        const stat = fs.lstatSync(RESUME_FILE);
        if (!stat.isFile() && !stat.isSymbolicLink()) return false;
        fs.unlinkSync(RESUME_FILE);
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[Scheduler] Error removing resume state:', err.message);
        return false;
    }
}

function quarantineResumeState(reason) {
    try {
        const stat = fs.lstatSync(RESUME_FILE);
        if (!stat.isFile() && !stat.isSymbolicLink()) return false;
        const quarantined = `${RESUME_FILE}.invalid-${Date.now()}-${process.pid}`;
        fs.renameSync(RESUME_FILE, quarantined);
        console.warn(`[Scheduler] Quarantined invalid resume state (${reason}).`);
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[Scheduler] Error quarantining resume state:', err.message);
        return false;
    }
}

function isPayPaySource(source) {
    return String(source || '').toLowerCase().includes('paypay');
}

function parseTimeMs(value) {
    if (!value) return null;

    const timeMs = new Date(value).getTime();
    return Number.isFinite(timeMs) ? timeMs : null;
}

function getPayPaySoldAtMs(item, nowMs) {
    if (!item || !isPayPaySource(item.source)) return null;

    const endTimeMs = parseTimeMs(item.endTime || item.end_time);
    if (endTimeMs !== null && endTimeMs <= nowMs) return endTimeMs;

    if (item.isSold === true || item.sold === true || String(item.itemStatus || '').toUpperCase() === 'SOLD') {
        return parseTimeMs(item.soldAt) || parseTimeMs(item.firstSeen) || nowMs;
    }

    return null;
}

function isExpiredPayPaySold(item, nowMs) {
    const soldAtMs = getPayPaySoldAtMs(item, nowMs);
    return soldAtMs !== null && nowMs - soldAtMs >= PAYPAY_SOLD_RETENTION_MS;
}

function normalizePersistableResult(result) {
    if (!result || result.error) return null;

    const link = String(result.link || '').trim();
    if (!link) return null;

    return link === result.link ? result : { ...result, link };
}

function filterPersistableResults(results, context = '') {
    if (!Array.isArray(results) || results.length === 0) return [];

    const filtered = results
        .map(normalizePersistableResult)
        .filter(Boolean);

    const skipped = results.length - filtered.length;
    if (skipped > 0) {
        const label = context ? ` for ${context}` : '';
        console.log(`[Scheduler] Skipped ${skipped} non-persistable result(s)${label}.`);
    }

    return filtered;
}

// Prepared statements for results
const stmts = {
    // Results CRUD
    getResultsByWatchId: db.prepare(`
        SELECT title, link, image, price, bid_price as bidPrice, bin_price as binPrice, 
               end_time as endTime, source, first_seen as firstSeen, last_seen as lastSeen, 
               is_new as isNew, new_type as newType, hidden
        FROM results WHERE watch_id = ?
        ORDER BY is_new DESC, first_seen DESC
    `),
    getVisibleResultsByWatchId: db.prepare(`
        SELECT title, link, image, price, bid_price as bidPrice, bin_price as binPrice,
               end_time as endTime, source, first_seen as firstSeen, last_seen as lastSeen,
               is_new as isNew, new_type as newType, hidden
        FROM results
        WHERE watch_id = ?
          AND NOT EXISTS (SELECT 1 FROM blocked_items WHERE blocked_items.url = results.link)
        ORDER BY is_new DESC, first_seen DESC
    `),
    getPayPayExpiryCandidates: db.prepare(`
        SELECT link, source, end_time as endTime, first_seen as firstSeen
        FROM results
        WHERE watch_id = ? AND LOWER(source) LIKE '%paypay%' AND end_time IS NOT NULL
    `),
    findByLink: db.prepare('SELECT * FROM results WHERE watch_id = ? AND link = ?'),
    findByTitleSource: db.prepare('SELECT * FROM results WHERE watch_id = ? AND title = ? AND source = ?'),
    upsertResult: db.prepare(`
        INSERT INTO results (watch_id, title, link, image, price, bid_price, bin_price, end_time, source, first_seen, last_seen, is_new, new_type, hidden)
        VALUES (@watchId, @title, @link, @image, @price, @bidPrice, @binPrice, @endTime, @source, @firstSeen, @lastSeen, @isNew, @newType, @hidden)
        ON CONFLICT(watch_id, link) DO UPDATE SET
            title = @title, image = @image, price = @price, bid_price = @bidPrice, bin_price = @binPrice,
            end_time = @endTime, last_seen = @lastSeen, is_new = @isNew, new_type = @newType, hidden = @hidden
    `),
    deleteResultsByWatchId: db.prepare('DELETE FROM results WHERE watch_id = ?'),
    deleteResultByLink: db.prepare('DELETE FROM results WHERE watch_id = ? AND link = ?'),
    clearNewFlags: db.prepare("UPDATE results SET is_new = 0, new_type = 'new' WHERE watch_id = ?"),
    clearAllNewFlags: db.prepare("UPDATE results SET is_new = 0, new_type = 'new'"),
    countNonHidden: db.prepare(`
        SELECT COUNT(*) as count FROM results
        WHERE watch_id = ? AND hidden = 0
          AND NOT EXISTS (SELECT 1 FROM blocked_items WHERE blocked_items.url = results.link)
    `),
    countNew: db.prepare(`
        SELECT COUNT(*) as count FROM results
        WHERE watch_id = ? AND is_new = 1
          AND NOT EXISTS (SELECT 1 FROM blocked_items WHERE blocked_items.url = results.link)
    `),
    deleteBySource: db.prepare('DELETE FROM results WHERE watch_id = ? AND source LIKE ?'),

    // Prune results by source
    deleteDisabledSource: db.prepare('DELETE FROM results WHERE watch_id = ? AND LOWER(source) LIKE ?'),

    // Grace period cleanup - get items not in the current results set
    getExistingLinks: db.prepare('SELECT link FROM results WHERE watch_id = ?'),
    getExistingForGrace: db.prepare(`
        SELECT title, link, source, first_seen as firstSeen, last_seen as lastSeen, is_new as isNew, new_type as newType, hidden,
               image, price, bid_price as bidPrice, bin_price as binPrice, end_time as endTime
        FROM results WHERE watch_id = ? AND link NOT IN (SELECT value FROM json_each(?))
    `),
    deleteExpiredGrace: db.prepare('DELETE FROM results WHERE watch_id = ? AND link = ?'),
    hideResult: db.prepare("UPDATE results SET hidden = ?, is_new = 0, new_type = 'new' WHERE watch_id = ? AND link = ?"),

    // Results meta
    getMeta: db.prepare('SELECT * FROM results_meta WHERE watch_id = ?'),
    upsertMeta: db.prepare('INSERT OR REPLACE INTO results_meta (watch_id, updated_at, new_count) VALUES (?, ?, ?)'),
    clearMetaNewCount: db.prepare('UPDATE results_meta SET new_count = 0 WHERE watch_id = ?'),
    clearAllMetaNewCounts: db.prepare('UPDATE results_meta SET new_count = 0'),
    getAllMeta: db.prepare(`
        SELECT w.id as watch_id, COALESCE(rm.new_count, 0) as new_count 
        FROM watchlist w 
        LEFT JOIN results_meta rm ON w.id = rm.watch_id
    `),
};

const Scheduler = {
    isRunning: false,
    progress: null,
    shouldAbort: false,
    completionVersion: 0,
    createSourceOutcomeTracker,

    // No longer need results cache - SQLite is the source of truth
    // Keep loadResults/persistResults as no-ops for backward compatibility
    loadResults: () => { /* no-op, data is in SQLite */ },
    loadResultsAsync: async () => { /* no-op */ },
    persistResults: async () => { /* no-op, SQLite auto-persists */ },

    pruneResults: async (watchId, enabledSites) => {
        const pruneTransaction = db.transaction(() => {
            let removed = 0;
            const sourceMappings = [
                { key: 'mercari', pattern: '%mercari%' },
                { key: 'yahoo', pattern: '%yahoo%' },
                { key: 'paypay', pattern: '%paypay%' },
                { key: 'fril', pattern: '%fril%' },
                { key: 'fril', pattern: '%rakuma%' },
                { key: 'surugaya', pattern: '%suruga%' },
                { key: 'taobao', pattern: '%taobao%' },
                { key: 'goofish', pattern: '%goofish%' },
                { key: 'mandarake', pattern: '%mandarake%' },
            ];

            for (const { key, pattern } of sourceMappings) {
                if (enabledSites[key] === false) {
                    const result = stmts.deleteDisabledSource.run(watchId, pattern);
                    removed += result.changes;
                }
            }

            if (removed > 0) {
                // Update new count
                const newCount = stmts.countNew.get(watchId).count;
                stmts.upsertMeta.run(watchId, new Date().toISOString(), newCount);
                console.log(`[Watchlist] Cleaned up ${removed} disabled items for ${watchId}`);
            }
        });
        pruneTransaction();
    },

    abort: () => {
        if (Scheduler.isRunning) {
            Scheduler.shouldAbort = true;
            console.log('[Scheduler] Abort requested');
        }
    },

    start: () => {
        console.log('Scheduler started. Checking every 30 minutes based on JST schedule.');

        // Check for resume state on startup
        Scheduler.resume();

        cron.schedule('0,30 * * * *', async () => {
            if (Scheduler.isRunning) {
                console.log('[Scheduler] Search already running, skipping scheduled run.');
                return;
            }

            if (!ScheduleSettings.isScheduledNow()) {
                console.log('[Scheduler] Current hour not in schedule, skipping.');
                return;
            }

            try {
                Cleanup.runFullCleanup();
            } catch (err) {
                console.error('[Scheduler] Cleanup failed:', err.message);
            }

            console.log('Running scheduled searches...');
            const list = await Watchlist.getAll();
            const activeItems = list.filter(i => i.active !== false);

            await Scheduler.runBatch(activeItems, 'scheduled');
        });
    },

    resume: async () => {
        let fileStats;
        try {
            fileStats = fs.statSync(RESUME_FILE);
        } catch (err) {
            if (err.code !== 'ENOENT') console.error('[Scheduler] Error checking resume state:', err.message);
            return;
        }

        if (!fileStats.isFile() || fileStats.size > MAX_RESUME_FILE_BYTES) {
            quarantineResumeState('not a regular file or exceeds size limit');
            return;
        }

        let state;
        try {
            state = validateResumeState(JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')));
        } catch (err) {
            console.error('[Scheduler] Error reading resume state:', err.message);
        }

        if (!state) {
            quarantineResumeState('schema validation failed');
            return;
        }

        console.log(`Resuming ${state.type} search from index ${state.currentIndex}...`);
        const allItems = await Watchlist.getAll();
        const byId = new Map(allItems.map(item => [item.id, item]));
        // currentIndex points at the saved chunk. Rebuild a compact remaining
        // batch so watches deleted since the interruption cannot cause a skip.
        const itemsToRun = state.items.slice(state.currentIndex).map(id => byId.get(id)).filter(Boolean);

        if (itemsToRun.length > 0) {
            searchAggregator.reset();
            await Scheduler.runBatch(itemsToRun, state.type, 0);
        } else {
            removeResumeState();
        }
    },

    runBatch: async (items, type = 'manual', startIndex = 0) => {
        if (Scheduler.isRunning && startIndex === 0) return;

        items = Array.isArray(items) ? items : [];
        startIndex = Number.isSafeInteger(startIndex) ? Math.min(Math.max(startIndex, 0), items.length) : 0;

        Scheduler.isRunning = true;
        Scheduler.shouldAbort = false;
        Scheduler.progress = { current: startIndex, total: items.length, currentItem: '' };

        const allNewItems = {};

        console.log(`[Batch] Starting ${type} run. ${items.length} items. From index ${startIndex}.`);

        if (startIndex === 0) searchAggregator.reset();

        const itemIds = items.map(i => i.id);

        try {
            // Settings are persisted user data; normalize at point-of-use so a
            // zero, negative, NaN, or excessive value cannot stall iteration.
            const settings = Settings.get();
            const concurrency = normalizeConcurrency(settings && settings.concurrency);

            for (let idx = startIndex; idx < items.length; idx += concurrency) {
                if (Scheduler.shouldAbort) {
                    console.log('[Scheduler] Aborted by user');
                    removeResumeState();
                    break;
                }

                const chunk = items.slice(idx, idx + concurrency);
                console.log(`[Batch] Processing chunk ${Math.floor(idx / concurrency) + 1} (${chunk.length} items)...`);

                // Save resume state
                try {
                    writeResumeState({
                        type,
                        currentIndex: idx,
                        items: itemIds,
                        timestamp: Date.now()
                    });
                } catch (e) { console.error('Error saving resume state:', e); }

                await Promise.all(chunk.map(async (item, chunkOffset) => {
                    if (chunkOffset > 0) {
                        await new Promise(resolve => setTimeout(resolve, chunkOffset * 2000));
                    }

                    const currentItemIndex = idx + chunkOffset;
                    Scheduler.progress = {
                        current: currentItemIndex + 1,
                        total: items.length,
                        currentItem: item.name || item.term
                    };

                    const terms = item.terms || [item.term];
                    const uniqueResultsMap = new Map();
                    const sourceOutcomes = createSourceOutcomeTracker();

                    console.log(`[Batch] Processing: ${item.name}`);

                    await Promise.all(terms.map(async (term) => {
                        console.log(`[Batch] - Searching: ${term}`);
                        try {
                            const results = await searchAggregator.searchAll(
                                term,
                                item.enabledSites,
                                item.strict !== false,
                                item.filters || [],
                                sourceOutcomes.onProgress,
                                item.siteOptions || {}
                            );
                            if (results && results.length > 0) {
                                for (const res of results) {
                                    const persistable = normalizePersistableResult(res);
                                    if (!persistable) continue;

                                    if (!uniqueResultsMap.has(persistable.link)) {
                                        uniqueResultsMap.set(persistable.link, persistable);
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`[Batch] Error searching for ${term}:`, err);
                        }
                    }));

                    const uniqueResults = Array.from(uniqueResultsMap.values());

                    try {
                        BlockedItems.recordSeen(uniqueResults);
                        let filtered = Blacklist.filterResults(uniqueResults);

                        if (item.filters && item.filters.length > 0) {
                            const filterTerms = item.filters.map(f => f.toLowerCase());
                            filtered = filtered.filter(result => {
                                const titleLower = String(result.title || '').toLowerCase();
                                return !filterTerms.some(term => titleLower.includes(term));
                            });
                        }

                        const { newItems, totalCount, favoritePriceUpdates } = Scheduler.saveResults(
                            item.id,
                            filtered,
                            item.name,
                            { successfulSources: sourceOutcomes.successfulSources() }
                        );

                        const digestItemsByLink = new Map();
                        for (const newItem of newItems || []) {
                            digestItemsByLink.set(newItem.link, newItem);
                        }
                        for (const priceUpdate of favoritePriceUpdates || []) {
                            digestItemsByLink.set(priceUpdate.link, priceUpdate);
                        }
                        const digestItems = Array.from(digestItemsByLink.values());

                        if (digestItems.length > 0 && item.emailNotify !== false) {
                            allNewItems[item.name] = digestItems;
                        }

                        if (newItems && newItems.length > 0) {
                            if (item.priority === true) {
                                try {
                                    await NtfyService.sendPriorityAlert(item.name || item.term, newItems);
                                } catch (notificationError) {
                                    console.error(`[Batch] Priority notification failed for ${item.name}:`, notificationError.message);
                                }
                            }
                        }
                        Watchlist.updateLastRun(item.id, totalCount);
                    } catch (err) {
                        console.error(`[Batch] Error saving results for ${item.name}:`, err);
                    }
                }));

                // No need for persist intervals - SQLite auto-commits
            }

            // Send digest if completed
            if (!Scheduler.shouldAbort && Object.keys(allNewItems).length > 0 && type === 'scheduled') {
                try {
                    await EmailService.sendDigestEmail(allNewItems);
                } catch (notificationError) {
                    console.error('[Batch] Digest notification failed:', notificationError.message);
                }
            }

            if (!Scheduler.shouldAbort) {
                removeResumeState();
            }

        } catch (err) {
            console.error('[Scheduler] Error in runBatch:', err);
        } finally {
            Scheduler.isRunning = false;
            Scheduler.progress = null;
            Scheduler.shouldAbort = false;
            Scheduler.completionVersion += 1;
        }
    },

    saveResults: (watchId, newResults, term = '', searchStatus = null) => {
        const now = new Date().toISOString();
        const nowMs = Date.now();
        const persistableResults = filterPersistableResults(newResults, term || watchId);
        const blockedUrls = BlockedItems.getUrlSet();
        const successfulSources = searchStatus?.successfulSources instanceof Set
            ? searchStatus.successfulSources
            : null;
        const YAHOO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
        const SURUGAYA_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
        const MERCARI_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000;
        const TAOBAO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
        const GOOFISH_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
        const MANDARAKE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

        let newItems = [];
        let favoritePriceUpdates = [];

        // Run the entire save operation in a transaction for atomicity & performance
        const saveTransaction = db.transaction(() => {
            // Get existing items for this watch ID
            const existingItems = stmts.getResultsByWatchId.all(watchId);
            const existingByLink = new Map(existingItems.map(item => [item.link, item]));
            const favoritesByUrl = FavoriteItems.getByUrlMap();

            // Create map for duplicate detection by Title + Source
            const existingByTitleSource = new Map();
            existingItems.forEach(item => {
                if (!blockedUrls.has(item.link) && item.title && item.source) {
                    const key = `${item.title.trim()}|${item.source}`;
                    existingByTitleSource.set(key, item);
                }
            });

            // Track which items per source are in new results (by title)
            const newTitlesBySource = {
                yahoo: new Set(),
                suruga: new Set(),
                mercari: new Set(),
                paypay: new Set(),
                taobao: new Set(),
                goofish: new Set(),
                mandarake: new Set(),
            };

            persistableResults.forEach(result => {
                if (!result.title || blockedUrls.has(result.link)) return;
                const title = result.title.trim();
                const source = result.source ? result.source.toLowerCase() : '';

                if (source.includes('yahoo')) newTitlesBySource.yahoo.add(title);
                else if (source.includes('suruga')) newTitlesBySource.suruga.add(title);
                else if (source.includes('mercari')) newTitlesBySource.mercari.add(title);
                else if (source.includes('paypay')) newTitlesBySource.paypay.add(title);
                else if (source === 'taobao') newTitlesBySource.taobao.add(title);
                else if (source === 'goofish') newTitlesBySource.goofish.add(title);
                else if (source === 'mandarake') newTitlesBySource.mandarake.add(title);
            });

            // Process new results
            const processedLinks = new Set();

            for (const result of persistableResults) {
                const existing = existingByLink.get(result.link);
                const isBlocked = blockedUrls.has(result.link);
                const favorite = isBlocked ? null : favoritesByUrl.get(result.link);
                const source = result.source ? result.source.toLowerCase() : '';
                const isTimedSource = source.includes('yahoo') || source.includes('suruga') ||
                    source.includes('mercari') || source.includes('paypay') ||
                    source === 'taobao' || source === 'goofish' || source === 'mandarake';

                let duplicateInfo = null;
                if (!isBlocked && result.title && result.source) {
                    const titleStr = String(result.title).trim();
                    const duplicateKey = `${titleStr}|${result.source}`;
                    duplicateInfo = existingByTitleSource.get(duplicateKey);
                }

                if (isExpiredPayPaySold({
                    ...result,
                    source: result.source || existing?.source || duplicateInfo?.source,
                    firstSeen: existing?.firstSeen || duplicateInfo?.firstSeen
                }, nowMs)) {
                    if (existing) {
                        stmts.deleteExpiredGrace.run(watchId, existing.link);
                    }
                    if (duplicateInfo && duplicateInfo.link !== existing?.link) {
                        stmts.deleteExpiredGrace.run(watchId, duplicateInfo.link);
                    }
                    if (isBlocked) BlockedItems.confirmMissing(result.link, now);
                    processedLinks.add(result.link);
                    continue;
                }

                if (isBlocked) {
                    stmts.upsertResult.run({
                        watchId,
                        title: result.title || '',
                        link: result.link,
                        image: result.image || '',
                        price: result.price || '',
                        bidPrice: result.bidPrice || '',
                        binPrice: result.binPrice || '',
                        endTime: result.endTime || '',
                        source: result.source || '',
                        firstSeen: existing?.firstSeen || now,
                        lastSeen: isTimedSource ? now : (existing?.lastSeen || null),
                        isNew: 0,
                        newType: 'new',
                        hidden: 1
                    });
                    processedLinks.add(result.link);
                    continue;
                }

                let priceUpdate = null;
                if (favorite) {
                    priceUpdate = FavoriteItems.getPriceUpdateForResult(result, favorite);
                    if (priceUpdate) {
                        favoritePriceUpdates.push(priceUpdate);
                    }
                    FavoriteItems.updateSnapshotFromResult(result);
                }

                let firstSeen, lastSeen, isNew, newType, hidden;

                if (existing) {
                    firstSeen = existing.firstSeen;
                    lastSeen = isTimedSource ? now : existing.lastSeen;
                    isNew = existing.isNew;
                    newType = existing.newType || 'new';
                    hidden = 0;
                } else if (duplicateInfo) {
                    firstSeen = duplicateInfo.firstSeen;
                    lastSeen = isTimedSource ? now : duplicateInfo.lastSeen;
                    isNew = duplicateInfo.isNew;
                    newType = duplicateInfo.newType || 'new';
                    hidden = 0;
                } else {
                    firstSeen = now;
                    lastSeen = isTimedSource ? now : null;
                    isNew = 1;
                    newType = 'new';
                    hidden = 0;
                    newItems.push(result);
                }

                if (priceUpdate) {
                    isNew = 1;
                    newType = 'updated';
                }

                stmts.upsertResult.run({
                    watchId,
                    title: result.title || '',
                    link: result.link,
                    image: result.image || '',
                    price: result.price || '',
                    bidPrice: result.bidPrice || '',
                    binPrice: result.binPrice || '',
                    endTime: result.endTime || '',
                    source: result.source || '',
                    firstSeen,
                    lastSeen,
                    isNew,
                    newType,
                    hidden
                });

                processedLinks.add(result.link);
            }

            // Grace period logic for items not in current results
            for (const item of existingItems) {
                if (processedLinks.has(item.link)) continue;

                const source = item.source ? item.source.toLowerCase() : '';
                let preserve = false;
                let hidden = 1; // Default to hidden

                if (isExpiredPayPaySold(item, nowMs)) {
                    stmts.deleteExpiredGrace.run(watchId, item.link);
                    if (blockedUrls.has(item.link)) BlockedItems.confirmMissing(item.link, now);
                    continue;
                }

                if (successfulSources && !successfulSources.has(sourceKey(source))) {
                    continue;
                }

                const lastSeenTime = item.lastSeen ? new Date(item.lastSeen).getTime() :
                    item.firstSeen ? new Date(item.firstSeen).getTime() : 0;
                const ageMs = nowMs - lastSeenTime;

                if (source.includes('yahoo')) {
                    if (ageMs < YAHOO_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.yahoo.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source.includes('suruga')) {
                    if (item.title && item.title.startsWith('Search Suruga-ya for')) continue;
                    if (ageMs < SURUGAYA_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.suruga.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source.includes('mercari')) {
                    if (ageMs < MERCARI_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.mercari.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source.includes('paypay')) {
                    if (ageMs < PAYPAY_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.paypay.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source === 'taobao') {
                    if (ageMs < TAOBAO_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.taobao.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source === 'goofish') {
                    if (ageMs < GOOFISH_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.goofish.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                } else if (source === 'mandarake') {
                    if (ageMs < MANDARAKE_GRACE_PERIOD_MS) {
                        if (!item.title || !newTitlesBySource.mandarake.has(item.title.trim())) {
                            preserve = true;
                        }
                    }
                }

                if (preserve) {
                    // Update hidden/isNew status for preserved items
                    stmts.hideResult.run(hidden, watchId, item.link);
                } else {
                    // Remove expired items
                    stmts.deleteExpiredGrace.run(watchId, item.link);
                    if (blockedUrls.has(item.link)) BlockedItems.confirmMissing(item.link, now);
                }
            }

            if (newItems.length > 0) {
                console.log(`[Scheduler] Found ${newItems.length} new item(s) for ${term || watchId}`);
            }

            // Update metadata
            const newCount = stmts.countNew.get(watchId).count;
            stmts.upsertMeta.run(watchId, now, newCount);

            // Get total non-hidden count
            const totalCount = stmts.countNonHidden.get(watchId).count;

            return { newItems, totalCount, favoritePriceUpdates };
        });

        return saveTransaction();
    },

    clearNewFlags: (watchId) => {
        const clearTransaction = db.transaction(() => {
            stmts.clearNewFlags.run(watchId);
            stmts.clearMetaNewCount.run(watchId);
        });
        clearTransaction();
    },

    getResults: async (watchId, options) => {
        let meta = stmts.getMeta.get(watchId);

        // Convert integer booleans to JS booleans for API compatibility
        const formatItems = resultItems => resultItems.map(item => ({
            ...item,
            isNew: item.isNew === 1,
            newType: item.newType || 'new',
            isUpdated: item.isNew === 1 && item.newType === 'updated',
            hidden: item.hidden === 1
        }));

        // Preserve the legacy full-result response when callers do not request
        // server-side pagination/filtering.
        if (!options || typeof options !== 'object' || Object.keys(options).length === 0) {
            const nowMs = Date.now();
            const expiredPayPaySoldItems = stmts.getPayPayExpiryCandidates.all(watchId)
                .filter(item => isExpiredPayPaySold(item, nowMs));
            if (expiredPayPaySoldItems.length > 0) {
                const cleanupTransaction = db.transaction(() => {
                    for (const item of expiredPayPaySoldItems) {
                        stmts.deleteExpiredGrace.run(watchId, item.link);
                        BlockedItems.confirmMissing(item.link);
                    }

                    const newCount = stmts.countNew.get(watchId).count;
                    stmts.upsertMeta.run(watchId, new Date().toISOString(), newCount);
                });
                cleanupTransaction();
                meta = stmts.getMeta.get(watchId);
            }

            const items = stmts.getVisibleResultsByWatchId.all(watchId);
            if (!meta && items.length === 0) return null;
            return {
                updatedAt: meta?.updated_at || null,
                newCount: meta?.new_count || 0,
                items: formatItems(items)
            };
        }

        const page = Number.isSafeInteger(options.page) && options.page > 0 ? options.page : 1;
        const pageSize = Number.isSafeInteger(options.pageSize)
            ? Math.min(Math.max(options.pageSize, 1), 100)
            : 50;
        const sortColumn = RESULT_SORT_COLUMNS[options.sortBy] || RESULT_SORT_COLUMNS.firstSeen;
        const sortDirection = String(options.sortDirection || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const where = [
            'watch_id = ?',
            'NOT EXISTS (SELECT 1 FROM blocked_items blocked WHERE blocked.url = results.link)',
            "NOT EXISTS (SELECT 1 FROM blacklist blocked_term WHERE TRIM(blocked_term.term) != '' AND INSTR(LOWER(COALESCE(results.title, '')), LOWER(blocked_term.term)) > 0)",
            "NOT (LOWER(source) LIKE '%paypay%' AND end_time IS NOT NULL AND julianday(end_time) IS NOT NULL AND julianday(end_time) <= julianday('now', '-1 day'))"
        ];
        const params = [watchId];
        const sourceWhereSql = `${where.join(' AND ')} AND hidden = 0 AND source IS NOT NULL AND source != ''`;
        const sourceParams = [...params];

        if (typeof options.source === 'string' && options.source.trim()) {
            where.push('source = ? COLLATE NOCASE');
            params.push(options.source.trim());
        }
        if (typeof options.search === 'string' && options.search.trim()) {
            where.push('(title LIKE ? ESCAPE \'\\\' OR link LIKE ? ESCAPE \'\\\')');
            const escapedSearch = `%${options.search.trim().replace(/[\\%_]/g, '\\$&')}%`;
            params.push(escapedSearch, escapedSearch);
        }
        if (options.hidden === true || options.hidden === false) {
            where.push('hidden = ?');
            params.push(options.hidden ? 1 : 0);
        }

        const whereSql = where.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM results WHERE ${whereSql}`).get(...params).count;
        const offset = (page - 1) * pageSize;
        const pagedItems = db.prepare(`
            SELECT title, link, image, price, bid_price as bidPrice, bin_price as binPrice,
                   end_time as endTime, source, first_seen as firstSeen, last_seen as lastSeen,
                   is_new as isNew, new_type as newType, hidden
            FROM results
            WHERE ${whereSql}
            ORDER BY ${sortColumn} ${sortDirection}, link ASC
            LIMIT ? OFFSET ?
        `).all(...params, pageSize, offset);
        const sources = db.prepare(`
            SELECT DISTINCT source FROM results
            WHERE ${sourceWhereSql}
            ORDER BY source COLLATE NOCASE
        `).all(...sourceParams).map(row => row.source);

        return {
            updatedAt: meta?.updated_at || null,
            newCount: meta?.new_count || 0,
            items: formatItems(pagedItems),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
            sources
        };
    },

    getNewCounts: async () => {
        const rows = stmts.getAllMeta.all();
        const counts = {};
        for (const row of rows) {
            counts[row.watch_id] = row.new_count || 0;
        }
        return counts;
    },

    markAllSeen: () => {
        const markTransaction = db.transaction(() => {
            stmts.clearAllNewFlags.run();
            stmts.clearAllMetaNewCounts.run();
        });
        markTransaction();
        return true;
    }
};

module.exports = Scheduler;
