const cron = require('node-cron');
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Blacklist = require('./models/blacklist');
const ScheduleSettings = require('./models/schedule');
const Settings = require('./models/settings');
const EmailService = require('./emailService');
const NtfyService = require('./utils/ntfyService');
const Cleanup = require('./utils/cleanup');
const searchAggregator = require('./scrapers');
const db = require('./models/database');
const fs = require('fs');
const path = require('path');

// Prepared statements for results
const stmts = {
    // Results CRUD
    getResultsByWatchId: db.prepare(`
        SELECT title, link, image, price, bid_price as bidPrice, bin_price as binPrice, 
               end_time as endTime, source, first_seen as firstSeen, last_seen as lastSeen, 
               is_new as isNew, hidden
        FROM results WHERE watch_id = ?
        ORDER BY is_new DESC, first_seen DESC
    `),
    findByLink: db.prepare('SELECT * FROM results WHERE watch_id = ? AND link = ?'),
    findByTitleSource: db.prepare('SELECT * FROM results WHERE watch_id = ? AND title = ? AND source = ?'),
    upsertResult: db.prepare(`
        INSERT INTO results (watch_id, title, link, image, price, bid_price, bin_price, end_time, source, first_seen, last_seen, is_new, hidden)
        VALUES (@watchId, @title, @link, @image, @price, @bidPrice, @binPrice, @endTime, @source, @firstSeen, @lastSeen, @isNew, @hidden)
        ON CONFLICT(watch_id, link) DO UPDATE SET
            title = @title, image = @image, price = @price, bid_price = @bidPrice, bin_price = @binPrice,
            end_time = @endTime, last_seen = @lastSeen, is_new = @isNew, hidden = @hidden
    `),
    deleteResultsByWatchId: db.prepare('DELETE FROM results WHERE watch_id = ?'),
    deleteResultByLink: db.prepare('DELETE FROM results WHERE watch_id = ? AND link = ?'),
    clearNewFlags: db.prepare('UPDATE results SET is_new = 0 WHERE watch_id = ?'),
    clearAllNewFlags: db.prepare('UPDATE results SET is_new = 0'),
    countNonHidden: db.prepare('SELECT COUNT(*) as count FROM results WHERE watch_id = ? AND hidden = 0'),
    countNew: db.prepare('SELECT COUNT(*) as count FROM results WHERE watch_id = ? AND is_new = 1'),
    deleteBySource: db.prepare('DELETE FROM results WHERE watch_id = ? AND source LIKE ?'),

    // Prune results by source
    deleteDisabledSource: db.prepare('DELETE FROM results WHERE watch_id = ? AND LOWER(source) LIKE ?'),

    // Grace period cleanup - get items not in the current results set
    getExistingLinks: db.prepare('SELECT link FROM results WHERE watch_id = ?'),
    getExistingForGrace: db.prepare(`
        SELECT title, link, source, first_seen as firstSeen, last_seen as lastSeen, is_new as isNew, hidden, 
               image, price, bid_price as bidPrice, bin_price as binPrice, end_time as endTime
        FROM results WHERE watch_id = ? AND link NOT IN (SELECT value FROM json_each(?))
    `),
    deleteExpiredGrace: db.prepare('DELETE FROM results WHERE watch_id = ? AND link = ?'),
    hideResult: db.prepare('UPDATE results SET hidden = ?, is_new = 0 WHERE watch_id = ? AND link = ?'),

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
        console.log('Scheduler started. Checking every hour based on JST schedule.');

        // Check for resume state on startup
        Scheduler.resume();

        cron.schedule('0 * * * *', async () => {
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
        const RESUME_FILE = path.join(__dirname, 'data/resume.json');
        if (fs.existsSync(RESUME_FILE)) {
            try {
                const state = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
                if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) {
                    console.log('Resume state too old, discarding.');
                    fs.unlinkSync(RESUME_FILE);
                    return;
                }

                console.log(`Resuming ${state.type} search from index ${state.currentIndex}...`);

                const allItems = await Watchlist.getAll();
                const itemsToRun = state.items.map(id => allItems.find(i => i.id === id)).filter(Boolean);

                if (itemsToRun.length > 0) {
                    searchAggregator.reset();
                    await Scheduler.runBatch(itemsToRun, state.type, state.currentIndex);
                } else {
                    fs.unlinkSync(RESUME_FILE);
                }
            } catch (e) {
                console.error('Error resuming:', e);
            }
        }
    },

    runBatch: async (items, type = 'manual', startIndex = 0) => {
        if (Scheduler.isRunning && startIndex === 0) return;

        Scheduler.isRunning = true;
        Scheduler.shouldAbort = false;
        Scheduler.progress = { current: startIndex, total: items.length, currentItem: '' };

        const RESUME_FILE = path.join(__dirname, 'data/resume.json');
        const allNewItems = {};

        console.log(`[Batch] Starting ${type} run. ${items.length} items. From index ${startIndex}.`);

        if (startIndex === 0) searchAggregator.reset();

        const itemIds = items.map(i => i.id);

        try {
            const CONCURRENCY = Settings.get().concurrency || 3;

            for (let idx = startIndex; idx < items.length; idx += CONCURRENCY) {
                if (Scheduler.shouldAbort) {
                    console.log('[Scheduler] Aborted by user');
                    if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);
                    break;
                }

                const chunk = items.slice(idx, idx + CONCURRENCY);
                console.log(`[Batch] Processing chunk ${Math.floor(idx / CONCURRENCY) + 1} (${chunk.length} items)...`);

                // Save resume state
                try {
                    fs.writeFileSync(RESUME_FILE, JSON.stringify({
                        type,
                        currentIndex: idx,
                        items: itemIds,
                        timestamp: Date.now()
                    }));
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
                    let payPayErrorOccurred = false;

                    console.log(`[Batch] Processing: ${item.name}`);

                    await Promise.all(terms.map(async (term) => {
                        console.log(`[Batch] - Searching: ${term}`);
                        try {
                            const results = await searchAggregator.searchAll(term, item.enabledSites, item.strict !== false, item.filters || []);
                            if (searchAggregator.isPayPayFailed && searchAggregator.isPayPayFailed()) {
                                payPayErrorOccurred = true;
                            }
                            if (results && results.length > 0) {
                                for (const res of results) {
                                    if (!uniqueResultsMap.has(res.link)) {
                                        uniqueResultsMap.set(res.link, res);
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`[Batch] Error searching for ${term}:`, err);
                        }
                    }));

                    const uniqueResults = Array.from(uniqueResultsMap.values());

                    try {
                        let filtered = BlockedItems.filterResults(uniqueResults);
                        filtered = Blacklist.filterResults(filtered);

                        if (item.filters && item.filters.length > 0) {
                            const filterTerms = item.filters.map(f => f.toLowerCase());
                            filtered = filtered.filter(result => {
                                const titleLower = result.title.toLowerCase();
                                return !filterTerms.some(term => titleLower.includes(term));
                            });
                        }

                        const { newItems, totalCount } = Scheduler.saveResults(item.id, filtered, item.name, payPayErrorOccurred);

                        if (newItems && newItems.length > 0) {
                            if (item.emailNotify !== false) {
                                allNewItems[item.name] = newItems;
                            }
                            if (item.priority === true) {
                                await NtfyService.sendPriorityAlert(item.name || item.term, newItems);
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
                await EmailService.sendDigestEmail(allNewItems);
            }

            if (!Scheduler.shouldAbort && fs.existsSync(RESUME_FILE)) {
                fs.unlinkSync(RESUME_FILE);
            }

        } catch (err) {
            console.error('[Scheduler] Error in runBatch:', err);
        } finally {
            Scheduler.isRunning = false;
            Scheduler.progress = null;
            Scheduler.shouldAbort = false;
        }
    },

    saveResults: (watchId, newResults, term = '', payPayError = false) => {
        const now = new Date().toISOString();
        const nowMs = Date.now();
        const YAHOO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
        const SURUGAYA_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
        const MERCARI_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000;
        const PAYPAY_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000;
        const TAOBAO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
        const GOOFISH_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

        let newItems = [];

        // Run the entire save operation in a transaction for atomicity & performance
        const saveTransaction = db.transaction(() => {
            // Get existing items for this watch ID
            const existingItems = stmts.getResultsByWatchId.all(watchId);
            const existingByLink = new Map(existingItems.map(item => [item.link, item]));

            // Create map for duplicate detection by Title + Source
            const existingByTitleSource = new Map();
            existingItems.forEach(item => {
                if (item.title && item.source) {
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
            };

            newResults.forEach(result => {
                if (!result.title) return;
                const title = result.title.trim();
                const source = result.source ? result.source.toLowerCase() : '';

                if (source.includes('yahoo')) newTitlesBySource.yahoo.add(title);
                else if (source.includes('suruga')) newTitlesBySource.suruga.add(title);
                else if (source.includes('mercari')) newTitlesBySource.mercari.add(title);
                else if (source.includes('paypay')) newTitlesBySource.paypay.add(title);
                else if (source === 'taobao') newTitlesBySource.taobao.add(title);
                else if (source === 'goofish') newTitlesBySource.goofish.add(title);
            });

            // Process new results
            const processedLinks = new Set();

            for (const result of newResults) {
                const existing = existingByLink.get(result.link);
                const source = result.source ? result.source.toLowerCase() : '';
                const isTimedSource = source.includes('yahoo') || source.includes('suruga') ||
                    source.includes('mercari') || source.includes('paypay') ||
                    source === 'taobao' || source === 'goofish';

                let duplicateInfo = null;
                if (result.title && result.source) {
                    const titleStr = String(result.title).trim();
                    const duplicateKey = `${titleStr}|${result.source}`;
                    duplicateInfo = existingByTitleSource.get(duplicateKey);
                }

                let firstSeen, lastSeen, isNew, hidden;

                if (existing) {
                    firstSeen = existing.firstSeen;
                    lastSeen = isTimedSource ? now : existing.lastSeen;
                    isNew = existing.isNew;
                    hidden = 0;
                } else if (duplicateInfo) {
                    firstSeen = duplicateInfo.firstSeen;
                    lastSeen = isTimedSource ? now : duplicateInfo.lastSeen;
                    isNew = duplicateInfo.isNew;
                    hidden = 0;
                } else {
                    firstSeen = now;
                    lastSeen = isTimedSource ? now : null;
                    isNew = 1;
                    hidden = 0;
                    newItems.push(result);
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
                }

                if (preserve) {
                    // Update hidden/isNew status for preserved items
                    stmts.hideResult.run(hidden, watchId, item.link);
                } else {
                    // Remove expired items
                    stmts.deleteExpiredGrace.run(watchId, item.link);
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

            return { newItems, totalCount };
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

    getResults: async (watchId) => {
        const meta = stmts.getMeta.get(watchId);
        const items = stmts.getResultsByWatchId.all(watchId);

        if (!meta && items.length === 0) return null;

        // Convert integer booleans to JS booleans for API compatibility
        const formattedItems = items.map(item => ({
            ...item,
            isNew: item.isNew === 1,
            hidden: item.hidden === 1
        }));

        return {
            updatedAt: meta?.updated_at || null,
            newCount: meta?.new_count || 0,
            items: formattedItems
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
