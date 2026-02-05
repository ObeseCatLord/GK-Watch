const cron = require('node-cron');
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Blacklist = require('./models/blacklist');
const ScheduleSettings = require('./models/schedule');
const EmailService = require('./emailService');
const NtfyService = require('./utils/ntfyService');
const Cleanup = require('./utils/cleanup');
const searchAggregator = require('./scrapers');
const fs = require('fs');
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'data/results.json');

// Ensure results file exists
if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({}, null, 2));
}

const Scheduler = {
    isRunning: false,
    progress: null,  // { current: number, total: number, currentItem: string }
    shouldAbort: false,
    resultsCache: null, // In-memory cache for results.json

    // Load results into cache (lazy load)
    loadResults: () => {
        if (Scheduler.resultsCache === null) {
            try {
                if (fs.existsSync(RESULTS_FILE)) {
                    Scheduler.resultsCache = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
                } else {
                    Scheduler.resultsCache = {};
                }
            } catch (e) {
                console.error('Error loading results cache:', e);
                Scheduler.resultsCache = {};
            }
        }
        return Scheduler.resultsCache;
    },

    // Async load results into cache
    loadResultsAsync: async () => {
        if (Scheduler.resultsCache === null) {
            try {
                const data = await fs.promises.readFile(RESULTS_FILE, 'utf8');
                Scheduler.resultsCache = JSON.parse(data);
            } catch (e) {
                // If file doesn't exist, return empty object
                if (e.code !== 'ENOENT') {
                    console.error('Error loading results cache (async):', e);
                }
                Scheduler.resultsCache = {};
            }
        }
        return Scheduler.resultsCache;
    },

    // Persist cache to disk
    persistResults: async () => {
        if (Scheduler.resultsCache === null) return;
        try {
            // Using async write to avoid blocking event loop
            await fs.promises.writeFile(RESULTS_FILE, JSON.stringify(Scheduler.resultsCache, null, 2));
        } catch (e) {
            console.error('Error persisting results:', e);
        }
    },

    // Prune results for a watchId (remove disabled sites)
    pruneResults: async (watchId, enabledSites) => {
        Scheduler.loadResults();
        const allResults = Scheduler.resultsCache;

        if (allResults[watchId] && allResults[watchId].items) {
            const beforeCount = allResults[watchId].items.length;

            allResults[watchId].items = allResults[watchId].items.filter(item => {
                const source = (item.source || '').toLowerCase();
                if (source.includes('mercari') && enabledSites.mercari === false) return false;
                if (source.includes('yahoo') && enabledSites.yahoo === false) return false;
                if (source.includes('paypay') && enabledSites.paypay === false) return false;
                if ((source.includes('fril') || source.includes('rakuma')) && enabledSites.fril === false) return false;
                if (source.includes('suruga') && enabledSites.surugaya === false) return false;
                if (source.includes('taobao') && enabledSites.taobao === false) return false;
                if (source.includes('goofish') && enabledSites.goofish === false) return false;
                return true;
            });

            if (allResults[watchId].items.length !== beforeCount) {
                // Update count if reduced
                allResults[watchId].newCount = Math.max(0, allResults[watchId].newCount - (beforeCount - allResults[watchId].items.length));
                if (allResults[watchId].items.length === 0) allResults[watchId].newCount = 0;

                await Scheduler.persistResults();
                console.log(`[Watchlist] Cleaned up ${beforeCount - allResults[watchId].items.length} disabled items for ${watchId}`);
            }
        }
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

        // Schedule task to run every hour, but only execute if current JST hour is enabled
        cron.schedule('0 * * * *', async () => {
            if (Scheduler.isRunning) {
                console.log('[Scheduler] Search already running, skipping scheduled run.');
                return;
            }

            if (!ScheduleSettings.isCurrentHourEnabled()) {
                console.log('[Scheduler] Current hour not in schedule, skipping.');
                return;
            }

            // Run cleanup before scheduled searches (log rotation + expired results)
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
                // Check if stale (older than 24h?)
                if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) {
                    console.log('Resume state too old, discarding.');
                    fs.unlinkSync(RESUME_FILE);
                    return;
                }

                console.log(`Resuming ${state.type} search from index ${state.currentIndex}...`);

                // Reconstruct items list
                const allItems = await Watchlist.getAll();
                const itemsToRun = state.items.map(id => allItems.find(i => i.id === id)).filter(Boolean);

                if (itemsToRun.length > 0) {
                    // Reset scrapers before resuming to permit fresh start
                    searchAggregator.reset();
                    await Scheduler.runBatch(itemsToRun, state.type, state.currentIndex);
                } else {
                    fs.unlinkSync(RESUME_FILE);
                }
            } catch (e) {
                console.error('Error resuming:', e);
                // fs.unlinkSync(RESUME_FILE); // Maybe safer to keep for inspection? Or delete to prevent crash loop.
            }
        }
    },

    runBatch: async (items, type = 'manual', startIndex = 0) => {
        if (Scheduler.isRunning && startIndex === 0) return; // Prevent double run unless resuming internal

        Scheduler.isRunning = true;
        Scheduler.shouldAbort = false;
        Scheduler.progress = { current: startIndex, total: items.length, currentItem: '' };

        const RESUME_FILE = path.join(__dirname, 'data/resume.json');
        const allNewItems = {};

        console.log(`[Batch] Starting ${type} run. ${items.length} items. From index ${startIndex}.`);

        // Reset scrapers if starting fresh (startIndex 0 handled by caller usually, but safe to do here if 0)
        if (startIndex === 0) searchAggregator.reset();

        // Pre-calculate item IDs for resume state to avoid O(N) in loop
        const itemIds = items.map(i => i.id);

        try {
            const CONCURRENCY = 3;
            let itemsSinceLastPersist = 0;
            const PERSIST_INTERVAL = 30; // Save every 30 items

            for (let idx = startIndex; idx < items.length; idx += CONCURRENCY) {
                if (Scheduler.shouldAbort) {
                    console.log('[Scheduler] Aborted by user');
                    // Delete resume file on abort
                    if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);

                    // Persist any pending changes before aborting
                    if (itemsSinceLastPersist > 0) {
                        await Scheduler.persistResults();
                    }
                    break;
                }

                // Process chunk
                const chunk = items.slice(idx, idx + CONCURRENCY);
                console.log(`[Batch] Processing chunk ${Math.floor(idx / CONCURRENCY) + 1} (${chunk.length} items)...`);

                // Save resume state at start of chunk
                try {
                    fs.writeFileSync(RESUME_FILE, JSON.stringify({
                        type,
                        currentIndex: idx,
                        items: itemIds,
                        timestamp: Date.now()
                    }));
                } catch (e) { console.error('Error saving resume state:', e); }

                // Run chunk in parallel with staggering
                await Promise.all(chunk.map(async (item, chunkOffset) => {
                    // Stagger start to prevent CPU/Memory spikes on browser launch (ARM optimization)
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

                    for (const term of terms) {
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
                    }

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

                        // Save to memory only (persist=false), wait for chunk end to persist
                        const { newItems, totalCount } = Scheduler.saveResults(item.id, filtered, item.name, payPayErrorOccurred, false);

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

                // Track unpersisted count
                itemsSinceLastPersist += chunk.length;

                // Persist results to disk ONLY if interval reached
                if (itemsSinceLastPersist >= PERSIST_INTERVAL) {
                    await Scheduler.persistResults();
                    itemsSinceLastPersist = 0;
                }
            }

            // Persist remaining items at the end
            if (itemsSinceLastPersist > 0) {
                await Scheduler.persistResults();
            }

            // Send digest if completed successfully (and not aborted) - ONLY for scheduled runs
            if (!Scheduler.shouldAbort && Object.keys(allNewItems).length > 0 && type === 'scheduled') {
                await EmailService.sendDigestEmail(allNewItems);
            }

            // Cleanup resume file on success
            if (!Scheduler.shouldAbort && fs.existsSync(RESUME_FILE)) {
                fs.unlinkSync(RESUME_FILE);
            }

        } catch (err) {
            console.error('[Scheduler] Error in runBatch:', err);
            // Resume file remains for restart
        } finally {
            Scheduler.isRunning = false;
            Scheduler.progress = null;
            Scheduler.shouldAbort = false;
        }
    },

    saveResults: (watchId, newResults, term = '', payPayError = false, persist = true) => {
        // Ensure cache is loaded
        const allResults = Scheduler.loadResults();

        let newItems = [];
        const now = new Date().toISOString();
        const nowMs = Date.now();
        const YAHOO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds
        const SURUGAYA_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
        const MERCARI_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
        const PAYPAY_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
        const TAOBAO_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds
        const GOOFISH_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds

        // Get existing items with their firstSeen timestamps
        const existingItems = allResults[watchId]?.items || [];
        const existingByLink = new Map(existingItems.map(item => [item.link, item]));

        // Create map for duplicate detection by Title + Source
        const existingByTitleSource = new Map();
        existingItems.forEach(item => {
            if (item.title && item.source) {
                const key = `${item.title.trim()}|${item.source}`;
                existingByTitleSource.set(key, item);
            }
        });

        // Track which Yahoo items are in the new results (by title)
        const newYahooTitles = new Set();
        const newSurugayaTitles = new Set();
        const newMercariTitles = new Set();
        const newPayPayTitles = new Set();
        const newTaobaoTitles = new Set();
        const newGoofishTitles = new Set();

        newResults.forEach(result => {
            if (!result.title) return;
            const title = result.title.trim();
            const source = result.source ? result.source.toLowerCase() : '';

            if (source.includes('yahoo')) {
                newYahooTitles.add(title);
            } else if (source.includes('suruga')) {
                newSurugayaTitles.add(title);
            } else if (source.includes('mercari')) {
                newMercariTitles.add(title);
            } else if (source.includes('paypay')) {
                newPayPayTitles.add(title);
            } else if (source === 'taobao') {
                newTaobaoTitles.add(title);
            } else if (source === 'goofish') {
                newGoofishTitles.add(title);
            }
        });

        // Process new results - preserve firstSeen for existing, add for new
        // Also add lastSeen for Yahoo and Suruga-ya items
        const processedResults = newResults.map(result => {
            const existing = existingByLink.get(result.link);
            const isYahoo = result.source && result.source.toLowerCase().includes('yahoo');
            const isSurugaya = result.source && result.source.toLowerCase().includes('suruga');
            const isMercari = result.source && result.source.toLowerCase().includes('mercari');
            const isPayPay = result.source && result.source.toLowerCase().includes('paypay');
            const isTaobao = result.source && result.source.toLowerCase() === 'taobao';
            const isGoofish = result.source && result.source.toLowerCase() === 'goofish';

            let duplicateInfo = null;
            if (result.title && result.source) {
                const titleStr = String(result.title).trim();
                const duplicateKey = `${titleStr}|${result.source}`;
                duplicateInfo = existingByTitleSource.get(duplicateKey);
            }

            if (existing) {
                // Preserve firstSeen and mark as not new
                return {
                    ...result,
                    firstSeen: existing.firstSeen,
                    lastSeen: (isYahoo || isSurugaya || isMercari || isPayPay || isTaobao || isGoofish) ? now : existing.lastSeen,
                    isNew: false,
                    hidden: false // Clear hidden flag - item is visible again
                };
            } else if (duplicateInfo) {
                // Same Name + Same Source exists = Treated as NOT NEW
                return {
                    ...result,
                    firstSeen: duplicateInfo.firstSeen, // Inherit timestamp
                    lastSeen: (isYahoo || isSurugaya || isMercari || isPayPay || isTaobao || isGoofish) ? now : duplicateInfo.lastSeen,
                    isNew: false,
                    hidden: false // Clear hidden flag - item is visible again
                };
            } else {
                // New item
                newItems.push(result);
                return {
                    ...result,
                    firstSeen: now,
                    lastSeen: (isYahoo || isSurugaya || isMercari || isPayPay || isTaobao || isGoofish) ? now : undefined,
                    isNew: true,
                    hidden: false
                };
            }
        });

        if (newItems.length > 0) {
            console.log(`[Scheduler] Found ${newItems.length} new item(s) for ${term || watchId}`);
        }

        // Sort: new items first (by firstSeen desc), then existing items (by firstSeen desc)
        processedResults.sort((a, b) => {
            // New items come first
            if (a.isNew && !b.isNew) return -1;
            if (!a.isNew && b.isNew) return 1;
            // Then sort by firstSeen (most recent first)
            return new Date(b.firstSeen) - new Date(a.firstSeen);
        });

        let finalResults = processedResults;

        // Unified Grace Period Logic (Optimized)
        // Instead of multiple passes, iterate existing items once and check against preservation rules

        const processedLinks = new Set(processedResults.map(r => r.link));
        const preservedItems = [];

        for (const item of existingItems) {
            // If item is already in processedResults (updated), skip preservation check
            if (processedLinks.has(item.link)) continue;

            const source = item.source ? item.source.toLowerCase() : '';
            let preserve = false;
            let hidden = true; // Default to hidden unless specified (Suruga-ya)

            const lastSeenTime = item.lastSeen ? new Date(item.lastSeen).getTime() :
                item.firstSeen ? new Date(item.firstSeen).getTime() : 0;
            const ageMs = nowMs - lastSeenTime;

            if (source.includes('yahoo')) {
                if (ageMs < YAHOO_GRACE_PERIOD_MS) {
                    // Skip if title exists in new results
                    if (!item.title || !newYahooTitles.has(item.title.trim())) {
                        preserve = true;
                    }
                }
            } else if (source.includes('suruga')) {
                // Exclude placeholder
                if (item.title && item.title.startsWith('Search Suruga-ya for')) continue;

                if (ageMs < SURUGAYA_GRACE_PERIOD_MS) {
                    if (!item.title || !newSurugayaTitles.has(item.title.trim())) {
                        preserve = true;
                        hidden = false; // Suruga-ya items remain visible
                    }
                }
            } else if (source.includes('mercari')) {
                if (ageMs < MERCARI_GRACE_PERIOD_MS) {
                    if (!item.title || !newMercariTitles.has(item.title.trim())) {
                        preserve = true;
                    }
                }
            } else if (source.includes('paypay')) {
                if (ageMs < PAYPAY_GRACE_PERIOD_MS) {
                    if (!item.title || !newPayPayTitles.has(item.title.trim())) {
                        preserve = true;
                    }
                }
            } else if (source === 'taobao') {
                if (ageMs < TAOBAO_GRACE_PERIOD_MS) {
                    if (!item.title || !newTaobaoTitles.has(item.title.trim())) {
                        preserve = true;
                    }
                }
            } else if (source === 'goofish') {
                if (ageMs < GOOFISH_GRACE_PERIOD_MS) {
                    if (!item.title || !newGoofishTitles.has(item.title.trim())) {
                        preserve = true;
                    }
                }
            }

            if (preserve) {
                preservedItems.push({
                    ...item,
                    isNew: false,
                    hidden: hidden
                });
            }
        }

        if (preservedItems.length > 0) {
            console.log(`[Scheduler] Grace period: Preserved ${preservedItems.length} items total for ${term || watchId}`);
        }

        finalResults = [...processedResults, ...preservedItems];

        // Save results with newCount
        allResults[watchId] = {
            updatedAt: now,
            newCount: newItems.length,
            items: finalResults
        };

        if (persist) {
            try {
                fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
            } catch (e) {
                console.error('Error writing results file:', e);
            }
        }

        return { newItems, totalCount: finalResults.filter(r => !r.hidden).length };
    },

    clearNewFlags: (watchId) => {
        const allResults = Scheduler.loadResults();
        if (allResults[watchId]) {
            // Clear isNew flags and reset newCount
            allResults[watchId].items = allResults[watchId].items.map(item => ({
                ...item,
                isNew: false
            }));
            allResults[watchId].newCount = 0;

            try {
                fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
            } catch (e) {
                console.error('Error clearing new flags:', e);
            }
        }
    },

    getResults: async (watchId) => {
        const allResults = await Scheduler.loadResultsAsync();
        return allResults[watchId] || null;
    },

    getNewCounts: async () => {
        const allResults = await Scheduler.loadResultsAsync();
        const counts = {};
        for (const [id, data] of Object.entries(allResults)) {
            counts[id] = data.newCount || 0;
        }
        return counts;
    },

    markAllSeen: () => {
        const allResults = Scheduler.loadResults();
        let updated = false;

        for (const id in allResults) {
            if (allResults[id].newCount > 0) {
                allResults[id].newCount = 0;
                allResults[id].items = allResults[id].items.map(item => ({
                    ...item,
                    isNew: false
                }));
                updated = true;
            }
        }

        if (updated) {
            try {
                fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
            } catch (e) {
                console.error('Error marking all seen:', e);
                return false;
            }
        }
        return true;
    }
};

module.exports = Scheduler;
