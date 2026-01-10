const cron = require('node-cron');
const Watchlist = require('./models/watchlist');
const BlockedItems = require('./models/blocked_items');
const Blacklist = require('./models/blacklist');
const ScheduleSettings = require('./models/schedule');
const EmailService = require('./emailService');
const NtfyService = require('./utils/ntfyService');
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

            console.log('Running scheduled searches...');
            const list = Watchlist.getAll();
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
                const allItems = Watchlist.getAll();
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

        try {
            for (let idx = startIndex; idx < items.length; idx++) {
                if (Scheduler.shouldAbort) {
                    console.log('[Scheduler] Aborted by user');
                    // Delete resume file on abort
                    if (fs.existsSync(RESUME_FILE)) fs.unlinkSync(RESUME_FILE);
                    break;
                }

                const item = items[idx];
                Scheduler.progress = {
                    current: idx + 1,
                    total: items.length,
                    currentItem: item.name || item.term
                };

                // Save state BEFORE processing (so we resume at this item if we crash during it? 
                // Or AFTER? if we crash during, we want to retry it. So BEFORE is better.)
                try {
                    fs.writeFileSync(RESUME_FILE, JSON.stringify({
                        type,
                        currentIndex: idx,
                        items: items.map(i => i.id),
                        timestamp: Date.now()
                    }));
                } catch (e) { console.error('Error saving resume state:', e); }

                // Search Logic (Refactored from previous loop)
                const terms = item.terms || [item.term];
                let allTermResults = [];
                let payPayErrorOccurred = false;

                console.log(`[Batch] Processing: ${item.name}`);

                for (const term of terms) {
                    console.log(`[Batch] - Searching: ${term}`);
                    try {
                        const results = await searchAggregator.searchAll(term);
                        if (searchAggregator.isPayPayFailed && searchAggregator.isPayPayFailed()) {
                            payPayErrorOccurred = true;
                        }
                        if (results && results.length > 0) {
                            allTermResults = [...allTermResults, ...results];
                        }
                    } catch (err) {
                        console.error(`[Batch] Error searching for ${term}:`, err);
                    }
                }

                // Deduplicate logic
                const uniqueResults = [];
                const seenLinks = new Set();
                for (const res of allTermResults) {
                    if (!seenLinks.has(res.link)) {
                        seenLinks.add(res.link);
                        uniqueResults.push(res);
                    }
                }

                try {
                    let filtered = BlockedItems.filterResults(uniqueResults);
                    filtered = Blacklist.filterResults(filtered);

                    // Apply per-watch filter terms
                    if (item.filters && item.filters.length > 0) {
                        const filterTerms = item.filters.map(f => f.toLowerCase());
                        filtered = filtered.filter(result => {
                            const titleLower = result.title.toLowerCase();
                            return !filterTerms.some(term => titleLower.includes(term));
                        });
                    }

                    const newItems = Scheduler.saveResults(item.id, filtered, item.name, payPayErrorOccurred);

                    if (newItems && newItems.length > 0) {
                        if (item.emailNotify !== false) {
                            allNewItems[item.name] = newItems;
                        }
                        if (item.priority === true) {
                            // Trigger Ntfy Priority Alert IMMEDIATELY
                            await NtfyService.sendPriorityAlert(item.name || item.term, newItems);
                        }
                    }
                    Watchlist.updateLastRun(item.id);
                } catch (err) {
                    console.error(`[Batch] Error saving results for ${item.name}:`, err);
                }
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

    saveResults: (watchId, newResults, term = '', payPayError = false) => {
        let allResults = {};
        let newItems = [];
        const now = new Date().toISOString();

        try {
            if (fs.existsSync(RESULTS_FILE)) {
                allResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('Error reading results file:', e);
        }

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

        // Process new results - preserve firstSeen for existing, add for new
        const processedResults = newResults.map(result => {
            const existing = existingByLink.get(result.link);

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
                    isNew: false
                };
            } else if (duplicateInfo) {
                // Same Name + Same Source exists = Treated as NOT NEW
                return {
                    ...result,
                    firstSeen: duplicateInfo.firstSeen, // Inherit timestamp
                    isNew: false
                };
            } else {
                // New item
                newItems.push(result);
                return {
                    ...result,
                    firstSeen: now,
                    isNew: true
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

        // PayPay Failsafe: If no PayPay items in new results, preserve existing PayPay items
        // This prevents items being marked as "new" when the flaky scraper works again
        const hasPayPayInNew = processedResults.some(item =>
            item.source && item.source.toLowerCase().includes('paypay')
        );
        const existingPayPayItems = existingItems.filter(item =>
            item.source && item.source.toLowerCase().includes('paypay')
        );

        let finalResults = processedResults;
        if (!hasPayPayInNew && existingPayPayItems.length > 0) {
            console.log(`[Scheduler] PayPay failsafe: Preserving ${existingPayPayItems.length} existing PayPay items for ${term || watchId}`);
            // Mark them as not new and add to results
            const preservedPayPay = existingPayPayItems.map(item => ({
                ...item,
                isNew: false
            }));
            finalResults = [...processedResults, ...preservedPayPay];
        }

        // Save results with newCount
        allResults[watchId] = {
            updatedAt: now,
            newCount: newItems.length,
            items: finalResults
        };

        fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));

        return newItems; // Return new items for email notification
    },

    clearNewFlags: (watchId) => {
        try {
            if (fs.existsSync(RESULTS_FILE)) {
                const allResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
                if (allResults[watchId]) {
                    // Clear isNew flags and reset newCount
                    allResults[watchId].items = allResults[watchId].items.map(item => ({
                        ...item,
                        isNew: false
                    }));
                    allResults[watchId].newCount = 0;
                    fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
                }
            }
        } catch (e) {
            console.error('Error clearing new flags:', e);
        }
    },

    getResults: (watchId) => {
        try {
            if (fs.existsSync(RESULTS_FILE)) {
                const allResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
                return allResults[watchId] || null;
            }
        } catch (e) {
            return null;
        }
        return null;
    },

    getNewCounts: () => {
        try {
            if (fs.existsSync(RESULTS_FILE)) {
                const allResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
                const counts = {};
                for (const [id, data] of Object.entries(allResults)) {
                    counts[id] = data.newCount || 0;
                }
                return counts;
            }
        } catch (e) {
            return {};
        }
        return {};
    },

    markAllSeen: () => {
        try {
            if (fs.existsSync(RESULTS_FILE)) {
                const allResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
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
                    fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
                }
                return true;
            }
        } catch (e) {
            console.error('Error marking all seen:', e);
            return false;
        }
        return false;
    }
};

module.exports = Scheduler;
