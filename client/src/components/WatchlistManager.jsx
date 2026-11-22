import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import ScanIndicator from './ScanIndicator';
import ResultCard from './ResultCard';
import {
    buildExportHtml,
    downloadExportHtml,
    hasServerPaginationResponse,
    makeExportFilename
} from '../utils/exportHelpers';

const shallowEqual = (left, right) => {
    if (left === right) return true;
    if (!left || !right) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
};

const ITEMS_PER_PAGE = 25;

const DEFAULT_ENABLED_SITES = {
    mercari: true,
    yahoo: true,
    paypay: true,
    fril: true,
    surugaya: true,
    taobao: false,
    goofish: false,
    mandarake: true
};

const DEFAULT_SITE_OPTIONS = {
    mandarake: { mode: 'garageKit' }
};

const SITE_LABELS = {
    mercari: 'Mercari',
    yahoo: 'Yahoo',
    paypay: 'PayPay',
    fril: 'Fril',
    surugaya: 'Suruga-ya',
    taobao: 'Taobao',
    goofish: 'Goofish',
    mandarake: 'Mandarake'
};

const WatchlistManager = ({ authenticatedFetch, onBlock, onFavoriteToggle, taobaoEnabled, goofishEnabled, handleExportClipboard }) => {
    const [watchlist, setWatchlist] = useState([]);
    const [newTerm, setNewTerm] = useState('');
    const [selectedResults, setSelectedResults] = useState(null);
    const [selectedTerm, setSelectedTerm] = useState('');
    const [selectedId, setSelectedId] = useState(null);

    const [newCounts, setNewCounts] = useState({});
    const [currentPage, setCurrentPage] = useState(1);
    const [resultFilter, setResultFilter] = useState('');
    const [emailSettings, setEmailSettings] = useState({});
    const [prioritySettings, setPrioritySettings] = useState({});
    const [activeSettings, setActiveSettings] = useState({});
    const [draggedItem, setDraggedItem] = useState(null);
    const [isGlobalRunning, setIsGlobalRunning] = useState(false);

    // Search queue for sequential single searches
    const [searchQueue, setSearchQueue] = useState([]);  // Array of {id, name}

    const [currentQueueItem, setCurrentQueueItem] = useState(null);  // Currently processing item
    const isProcessingRef = React.useRef(false);
    const [sourceFilter, setSourceFilter] = useState('All');
    const [availableSources, setAvailableSources] = useState([]);
    const [sortBy, setSortBy] = useState('time'); // 'time', 'favorite', 'name', 'priceHigh', 'priceLow'
    const [selectedResultsMeta, setSelectedResultsMeta] = useState({
        total: 0,
        page: 1,
        pageSize: ITEMS_PER_PAGE,
        totalPages: 1,
        useServerPagination: false
    });
    const viewedWatchRef = React.useRef(null);
    const pendingSeenRequestsRef = React.useRef(new Map());
    const resultsRequestVersionRef = React.useRef(0);
    const lastResultsRequest = React.useRef('');
    const [resultMode, setResultMode] = useState('scroll');
    const [resultsLoading, setResultsLoading] = useState(false);
    const [resultsLoadError, setResultsLoadError] = useState(null);
    const nextPageTriggerRef = React.useRef(null);
    const resultsLoadingRef = React.useRef(false);
    const [schedulerProgress, setSchedulerProgress] = useState(null);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const resultsPanelRef = React.useRef(null);
    const watchDrawerRef = React.useRef(null);
    const watchDrawerButtonRef = React.useRef(null);
    const WatchRail = mobileSidebarOpen ? 'dialog' : 'aside';

    const closeWatchDrawer = React.useCallback((focusResults = false) => {
        watchDrawerRef.current?.close();
        setMobileSidebarOpen(false);
        (focusResults ? resultsPanelRef : watchDrawerButtonRef).current?.focus();
    }, []);

    useEffect(() => {
        if (!mobileSidebarOpen) return;
        const desktop = window.matchMedia('(min-width: 701px)');
        const handleResize = (event) => { if (event.matches) closeWatchDrawer(); };
        desktop.addEventListener('change', handleResize);
        return () => desktop.removeEventListener('change', handleResize);
    }, [closeWatchDrawer, mobileSidebarOpen]);


    // Track previous running state to detect completion
    const wasRunningRef = React.useRef(false);
    const completionVersionRef = React.useRef(0);
    const watchStatusRef = React.useRef({ version: 0, updates: {} });

    // Multi-term / Merge / Edit State
    const [isMerging, setIsMerging] = useState(false);
    const [checkedItems, setCheckedItems] = useState(new Set());
    const [editingItem, setEditingItem] = useState(null);
    const [editName, setEditName] = useState('');
    const [editTerms, setEditTerms] = useState('');
    const [editFilters, setEditFilters] = useState('');
    const [editEnabledSites, setEditEnabledSites] = useState({});
    const [editSiteOptions, setEditSiteOptions] = useState(DEFAULT_SITE_OPTIONS);
    const [editStrict, setEditStrict] = useState(true);
    const [newStrict, setNewStrict] = useState(true);
    const [globalSettings, setGlobalSettings] = useState({}); // Renamed to avoid collision with 'activeSettings' maybe? No, 'settings' is fine but distinct from local settings maps.


    const fetchGlobalSettings = React.useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/settings');
            const data = await res.json();
            setGlobalSettings(data || {});
        } catch (err) {
            console.error('Error fetching global settings:', err);
        }
    }, [authenticatedFetch]);

    const fetchWatchlist = React.useCallback(async ({ statusOnly = false } = {}) => {
        try {
            const res = await authenticatedFetch('/api/watchlist');

            if (res.status === 429) {
                console.warn('Rate limit exceeded. Retaining existing watchlist.');
                // Optionally trigger a toast notification here
                return;
            }

            if (!res.ok) {
                console.error(`Failed to fetch watchlist: ${res.status}`);
                return;
            }

            const data = await res.json();
            if (Array.isArray(data)) {
                if (statusOnly) {
                    const savedWatches = new Map(data.map(item => [item.id, item]));
                    setWatchlist(previous => previous.map(item => {
                        const saved = savedWatches.get(item.id);
                        return saved ? { ...item, lastRun: saved.lastRun, lastResultCount: saved.lastResultCount } : item;
                    }));
                    return;
                }
                setWatchlist(data);
                // Build email/priority settings map
                const emailMap = {};
                const priorityMap = {};
                const activeMap = {};
                data.forEach(item => {
                    emailMap[item.id] = item.emailNotify !== false;
                    priorityMap[item.id] = item.priority === true;
                    activeMap[item.id] = item.active !== false;
                });
                setEmailSettings(emailMap);
                setPrioritySettings(priorityMap);
                setActiveSettings(activeMap);
            } else {
                console.error('Watchlist data is not an array:', data);
                // Do not clear watchlist if data is invalid/undefined to be safe?
                // Actually if it returns explicit non-array structure it might be an error object, so safer to keep old data.
            }
        } catch (err) {
            console.error('Error fetching watchlist:', err);
            // Do NOT setWatchlist([]) here.
        }
    }, [authenticatedFetch]);

    const fetchNewCounts = React.useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/watchlist/newcounts');
            const data = await res.json();
            setNewCounts(data || {});
        } catch (err) {
            console.error('Error fetching new counts:', err);
        }
    }, [authenticatedFetch]);

    const getSortParams = React.useCallback((sort = 'time') => {
        if (sort === 'name') return { sort: 'title', order: 'asc' };
        if (sort === 'favorite') return { sort: 'favorite', order: 'desc' };
        if (sort === 'priceHigh') return { sort: 'price', order: 'desc' };
        if (sort === 'priceLow') return { sort: 'price', order: 'asc' };
        return { sort: 'firstSeen', order: 'desc' };
    }, []);

    const acknowledgeWatch = React.useCallback((watch) => {
        if (!watch?.loaded) return;
        const { id } = watch;
        if (pendingSeenRequestsRef.current.has(id)) return;

        const request = (async () => {
            try {
                const res = await authenticatedFetch(`/api/results/${id}/seen`, { method: 'POST' });
                if (!res.ok) throw new Error(`Failed to mark watch as seen: ${res.status}`);
                setNewCounts(prev => ({ ...prev, [id]: 0 }));
            } catch (err) {
                console.error('Error marking watch as seen:', err);
            } finally {
                pendingSeenRequestsRef.current.delete(id);
            }
        })();
        pendingSeenRequestsRef.current.set(id, request);
    }, [authenticatedFetch]);

    // Leaving the watchlist for another app view also acknowledges the open watch.
    useEffect(() => () => {
        acknowledgeWatch(viewedWatchRef.current);
        viewedWatchRef.current = null;
        resultsRequestVersionRef.current += 1;
    }, [acknowledgeWatch]);

    const fetchWatchResults = React.useCallback(async (id, page = 1, {
        filter = resultFilter, source = sourceFilter, append = false, throughPage = page
    } = {}) => {
        if (append && resultsLoadingRef.current) return;
        const requestVersion = ++resultsRequestVersionRef.current;
        resultsLoadingRef.current = true;
        setResultsLoading(true);
        setResultsLoadError(null);

        try {
            // A quick return to a watch must wait for its previous acknowledgement.
            await pendingSeenRequestsRef.current.get(id);
            const params = new URLSearchParams();
            params.set('pageSize', String(ITEMS_PER_PAGE));
            const { sort, order } = getSortParams(sortBy);
            params.set('sort', sort);
            params.set('order', order);

            const normalizedFilter = filter.trim();
            if (normalizedFilter) {
                params.set('filter', normalizedFilter);
            }

            if (source !== 'All') {
                params.set('source', source);
            }

            const loadPage = async (number) => {
                const query = new URLSearchParams({ page: String(number || 1) });
                for (const [key, value] of params) query.set(key, value);
                const res = await authenticatedFetch(`/api/results/${id}?${query.toString()}`);
                if (!res.ok) throw new Error(`Failed to fetch results: ${res.status}`);
                return res.json();
            };
            const isCurrent = () => viewedWatchRef.current?.id === id && resultsRequestVersionRef.current === requestVersion;
            const data = await loadPage(page);
            if (!isCurrent()) return;
            if (hasServerPaginationResponse(data)) {
                const pages = [data];
                const lastPage = Math.min(throughPage, data.totalPages);
                for (let first = page + 1; first <= lastPage; first += 4) {
                    const batch = await Promise.all(Array.from(
                        { length: Math.min(4, lastPage - first + 1) }, (_, offset) => loadPage(first + offset)
                    ));
                    if (!isCurrent()) return;
                    pages.push(...batch);
                }
                viewedWatchRef.current.loaded = true;
                const serverMeta = {
                    total: Number(data.total) || 0,
                    page: Number(pages.at(-1).page) || 1,
                    pageSize: Number(data.pageSize) || ITEMS_PER_PAGE,
                    totalPages: Number(data.totalPages) || 1,
                    useServerPagination: true
                };
                setSelectedResultsMeta(serverMeta);
                const items = pages.flatMap(result => (Array.isArray(result.items) ? result.items : [])
                    .map(item => ({ ...item, watchResultPage: Number(result.page) || 1 })));
                setSelectedResults(previous => {
                    if (!append || !previous) return items;

                    const seen = new Set(previous.map(item => item.link || item.url).filter(Boolean));
                    const newItems = items.filter(item => {
                        const link = item.link || item.url;
                        if (!link) return true;
                        if (seen.has(link)) return false;
                        seen.add(link);
                        return true;
                    });

                    return [...previous, ...newItems];
                });
                setAvailableSources(Array.isArray(data.sources) ? data.sources : []);
                if (!append) {
                    const selectedPage = Number(data.page) || 1;
                    lastResultsRequest.current = `${id}|${selectedPage}|${sortBy}|${filter}|${source}`;
                    setCurrentPage(selectedPage);
                }
                return;
            }

            const fallbackItems = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
            const fallbackPage = Math.min(throughPage, Math.max(1, Math.ceil(fallbackItems.length / ITEMS_PER_PAGE)));
            viewedWatchRef.current.loaded = true;
            setSelectedResultsMeta({
                total: fallbackItems.length,
                page: fallbackPage,
                pageSize: ITEMS_PER_PAGE,
                totalPages: Math.max(1, Math.ceil(fallbackItems.length / ITEMS_PER_PAGE)),
                useServerPagination: false
            });
            setSelectedResults(fallbackItems);
            setAvailableSources([...new Set(fallbackItems.map(item => item.source).filter(Boolean))].sort());
            setCurrentPage(fallbackPage);

        } catch (err) {
            if (resultsRequestVersionRef.current === requestVersion) setResultsLoadError({ page, append, throughPage });
            console.error('Error fetching stored results', err);
        } finally {
            if (resultsRequestVersionRef.current === requestVersion) {
                resultsLoadingRef.current = false;
                setResultsLoading(false);
            }
        }
    }, [authenticatedFetch, getSortParams, resultFilter, sourceFilter, sortBy]);

    const viewResults = React.useCallback(async (id, term) => {
        if (viewedWatchRef.current?.id !== id) {
            acknowledgeWatch(viewedWatchRef.current);
            viewedWatchRef.current = { id, loaded: false };
        }
        setSelectedId(id);
        setSelectedTerm(term);
        setResultFilter('');
        setSourceFilter('All');
        setSelectedResults(null);
        setAvailableSources([]);
        setCurrentPage(1);
        setSelectedResultsMeta(prev => ({ ...prev, useServerPagination: false }));
        lastResultsRequest.current = `${id}|1|${sortBy}||All`;
        await fetchWatchResults(id, 1, { filter: '', source: 'All' });
    }, [acknowledgeWatch, fetchWatchResults, sortBy]);

    const refreshSelectedResults = React.useCallback(async () => {
        if (!selectedId || viewedWatchRef.current?.id !== selectedId) return;
        const page = resultMode === 'scroll' ? 1 : currentPage;
        const throughPage = resultMode === 'scroll' && selectedResultsMeta.useServerPagination
            ? selectedResultsMeta.page : currentPage;
        await fetchWatchResults(selectedId, page, { throughPage });
    }, [fetchWatchResults, resultMode, selectedId, currentPage, selectedResultsMeta.page, selectedResultsMeta.useServerPagination]);
    const refreshSelectedResultsRef = React.useRef(refreshSelectedResults);
    useEffect(() => {
        refreshSelectedResultsRef.current = refreshSelectedResults;
    }, [refreshSelectedResults]);

    // Refresh saved results as each watch finishes, including while the batch is running.
    useEffect(() => {
        let cancelled = false;
        let timeoutId = null;
        let requestInFlight = false;
        let activeStatusController = null;

        const checkStatus = async () => {
            if (requestInFlight) return;
            requestInFlight = true;
            const statusController = new AbortController();
            activeStatusController = statusController;
            const statusTimeoutId = setTimeout(() => statusController.abort(), 5000);
            let nextDelay = document.hidden ? 60000 : 15000;
            try {
                const res = await authenticatedFetch('/api/status', {
                    signal: statusController.signal
                });
                const data = await res.json();
                if (cancelled) return;
                const running = Boolean(data.isRunning);
                const completionVersion = Number(data.completionVersion) || 0;
                const completionChanged = completionVersion !== completionVersionRef.current;
                const previousWatchStatus = watchStatusRef.current;
                const watchUpdateVersion = Number(data.watchUpdateVersion) || 0;
                const watchUpdates = data.watchUpdates || {};
                const watchlistChanged = watchUpdateVersion !== previousWatchStatus.version;
                const currentWatchUpdated = Boolean(selectedId && watchUpdates[selectedId] &&
                    watchUpdates[selectedId] !== previousWatchStatus.updates[selectedId]);
                nextDelay = document.hidden ? 60000 : running ? 2000 : 15000;

                // The completion version catches runs that start and finish between polls.
                const batchCompleted = (wasRunningRef.current && !running) || completionChanged;
                if (watchlistChanged || batchCompleted) {
                    fetchWatchlist({ statusOnly: !batchCompleted });
                    fetchNewCounts();
                }
                if (currentWatchUpdated || (batchCompleted && !watchUpdates[selectedId])) {
                    refreshSelectedResultsRef.current();
                }

                watchStatusRef.current = { version: watchUpdateVersion, updates: watchUpdates };
                wasRunningRef.current = running;
                completionVersionRef.current = completionVersion;
                setIsGlobalRunning(previous => previous === running ? previous : running);
                setSchedulerProgress(previous => shallowEqual(previous, data.progress) ? previous : data.progress);
            } catch (err) {
                nextDelay = 2000;
                if (err?.name !== 'AbortError') {
                    console.error('Error checking status:', err);
                }
            } finally {
                clearTimeout(statusTimeoutId);
                requestInFlight = false;
                if (activeStatusController === statusController) {
                    activeStatusController = null;
                }
                if (!cancelled) timeoutId = setTimeout(checkStatus, nextDelay);
            }
        };

        checkStatus();

        const handleVisibilityChange = () => {
            if (!document.hidden) {
                clearTimeout(timeoutId);
                checkStatus();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
            activeStatusController?.abort();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [authenticatedFetch, fetchWatchlist, fetchNewCounts, selectedId]);

    useEffect(() => {
        if (!selectedId) return;
        if (!selectedResultsMeta.useServerPagination) return;

        const requestKey = `${selectedId}|${currentPage}|${sortBy}|${resultFilter}|${sourceFilter}`;
        if (lastResultsRequest.current === requestKey) return;
        lastResultsRequest.current = requestKey;

        fetchWatchResults(selectedId, currentPage);
    }, [currentPage, resultFilter, selectedId, selectedResultsMeta.useServerPagination, sourceFilter, sortBy, fetchWatchResults]);

    useEffect(() => {
        const timer = setTimeout(() => {
            fetchWatchlist();
            fetchNewCounts();
            fetchGlobalSettings();
        }, 0);
        return () => clearTimeout(timer);
    }, [fetchGlobalSettings, fetchNewCounts, fetchWatchlist]);

    // Process search queue sequentially
    // Queue items: { id, name, type: 'single' | 'runAll', items?: [] }
    const abortRef = React.useRef(false);

    useEffect(() => {
        const processQueue = async () => {
            if (isProcessingRef.current || searchQueue.length === 0) return;

            isProcessingRef.current = true;
            abortRef.current = false;
            const item = searchQueue[0];
            setCurrentQueueItem(item);

            try {
                if (item.type === 'runAll') {
                    // Process all items in the Run All batch
                    const itemsToProcess = item.items || [];
                    for (let i = 0; i < itemsToProcess.length; i++) {
                        if (abortRef.current) {
                            console.log('Run All aborted');
                            break;
                        }
                        const watchItem = itemsToProcess[i];
                        setCurrentQueueItem({ ...item, progress: `${i + 1}/${itemsToProcess.length}: ${watchItem.name}` });
                        try {
                            await authenticatedFetch(`/api/run-single/${watchItem.id}`, { method: 'POST' });
                        } catch (err) {
                            console.error(`Queue: ${watchItem.name} failed`, err);
                        }
                    }
                } else {
                    // Single item search
                    if (!abortRef.current) {
                        const res = await authenticatedFetch(`/api/run-single/${item.id}`, { method: 'POST' });
                        const data = await res.json();
                        console.log(`Queue: ${item.name} completed - ${data.resultCount} results`);

                        if (selectedId === item.id) {
                            viewResults(item.id, selectedTerm);
                        }
                    }
                }
                fetchWatchlist();
                fetchNewCounts();
            } catch (err) {
                console.error(`Queue: ${item.name} failed`, err);
            }

            // Remove processed item from queue
            setSearchQueue(prev => prev.slice(1));
            setCurrentQueueItem(null);
            isProcessingRef.current = false;
            abortRef.current = false;
        };

        processQueue();
    }, [selectedId, searchQueue, selectedTerm, authenticatedFetch, fetchWatchlist, fetchNewCounts, viewResults]);

    // Add item to search queue
    const addToSearchQueue = (id, name, type = 'single', items = null) => {
        const queueId = type === 'runAll' ? 'runAll' : id;
        // Don't add if already in queue or currently processing
        if (searchQueue.some(item => item.id === queueId) || (currentQueueItem && currentQueueItem.id === queueId)) {
            return;
        }
        setSearchQueue(prev => [...prev, { id: queueId, name, type, items }]);
    };

    // Stop current search and remove from queue
    const stopSearch = (queueId) => {
        if (currentQueueItem && currentQueueItem.id === queueId) {
            abortRef.current = true;
            // Will be cleaned up by queue processor
        } else {
            setSearchQueue(prev => prev.filter(item => item.id !== queueId));
        }
    };

    const runNow = async () => {
        try {
            const res = await authenticatedFetch('/api/run-now', { method: 'POST' });
            if (!res.ok) throw new Error(`Run failed with status ${res.status}`);
            wasRunningRef.current = true;
            setIsGlobalRunning(true);
        } catch (err) {
            console.error('Error starting batch run:', err);
            alert('Failed to start run');
        }
    };

    const createWatch = async (payload) => {
        const res = await authenticatedFetch('/api/watchlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.status === 409) {
            window.alert('Watch already exists');
            return false;
        }
        if (!res.ok) throw new Error(`Add failed with status ${res.status}`);

        setNewTerm('');
        fetchWatchlist();
        return true;
    };

    const addToWatchlist = async (e) => {
        e.preventDefault();
        if (!newTerm.trim()) return;

        try {
            await createWatch({
                term: newTerm,
                strict: newStrict,
                enabledSites: { ...DEFAULT_ENABLED_SITES },
                siteOptions: { mandarake: { mode: 'garageKit' } }
            });
        } catch (err) {
            console.error('Error adding to watchlist:', err);
        }
    };

    const addGKEntries = async () => {
        if (!newTerm.trim()) return;

        const terms = [
            `${newTerm} ガレージキット`,
            `${newTerm} レジンキット`,
            `${newTerm} レジンキャストキット`
        ];

        try {
            await createWatch({
                terms,
                name: terms[0], // Set name explicitly to first term
                filters: [],
                strict: newStrict,
                enabledSites: { ...DEFAULT_ENABLED_SITES },
                siteOptions: { mandarake: { mode: 'garageKit' } }
            });
        } catch (err) {
            console.error('Error adding GK entry:', err);
        }
    };

    const addCNWatch = async () => {
        if (!newTerm.trim()) return;

        // Enable available CN sites, disable others
        const cnEnabledSites = {
            mercari: false,
            yahoo: false,
            paypay: false,
            fril: false,
            surugaya: false,
            taobao: taobaoEnabled,
            goofish: goofishEnabled,
            mandarake: false
        };

        try {
            await createWatch({
                term: newTerm,
                enabledSites: cnEnabledSites,
                strict: newStrict,
                name: `${newTerm} (CN)`
            });
        } catch (err) {
            console.error('Error adding CN watch:', err);
        }
    };

    const removeWatch = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm('Are you sure you want to delete this watchlist item?')) return;

        try {
            await authenticatedFetch(`/api/watchlist/${id}`, {
                method: 'DELETE'
            });
            fetchWatchlist();
            if (selectedId === id) {
                viewedWatchRef.current = null;
                resultsRequestVersionRef.current += 1;
                setSelectedId(null);
                setSelectedTerm('');
                setSelectedResults(null);
            }
        } catch (err) {
            console.error('Error removing watch:', err);
        }
    };

    const handleDragStart = (e, item) => {
        setDraggedItem(item);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e, item) => {
        e.preventDefault();
        if (!draggedItem || draggedItem.id === item.id) return;

        const dragIndex = (watchlist || []).findIndex(i => i.id === draggedItem.id);
        const hoverIndex = (watchlist || []).findIndex(i => i.id === item.id);

        if (dragIndex === hoverIndex) return;

        // Reorder locally for smooth visual feedback
        const newList = [...(watchlist || [])];
        newList.splice(dragIndex, 1);
        newList.splice(hoverIndex, 0, draggedItem);
        setWatchlist(newList);
    };

    const handleDragEnd = async () => {
        if (!draggedItem) return;

        // Save the new order to the server
        try {
            await authenticatedFetch('/api/watchlist/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds: (watchlist || []).map(i => i.id) })
            });
        } catch (err) {
            console.error('Error saving order:', err);
        }

        setDraggedItem(null);
    };

    const toggleCheck = (id) => {
        const newChecked = new Set(checkedItems);
        if (newChecked.has(id)) newChecked.delete(id);
        else newChecked.add(id);
        setCheckedItems(newChecked);
    };

    const handleMerge = async () => {
        if (checkedItems.size < 2) return alert('Select at least 2 items to merge.');

        // Find the first selected item according to current list order to use as name source
        const firstId = (watchlist || []).find(item => checkedItems.has(item.id))?.id;
        const firstItem = (watchlist || []).find(item => item.id === firstId);
        const name = firstItem ? (firstItem.name || firstItem.term) : 'Merged Watch';

        try {
            await authenticatedFetch('/api/watchlist/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(checkedItems), newName: name })
            });
            setIsMerging(false);
            setCheckedItems(new Set());
            fetchWatchlist();
        } catch (err) {
            console.error('Merge failed:', err);
            alert('Merge failed');
        }
    };

    const handleMarkAllSeen = async () => {
        if (!window.confirm('Mark all new items as seen?')) return;
        try {
            await authenticatedFetch('/api/results/mark-all-seen', { method: 'POST' });
            fetchNewCounts();
            if (selectedId) {
                // If viewing a result, refresh it to clear flags
                const item = watchlist.find(i => i.id === selectedId);
                if (item) {
                    viewResults(selectedId, item.term);
                }
            }
        } catch (err) {
            console.error('Error marking all seen:', err);
        }
    };

    const startEdit = (e, item) => {
        e.stopPropagation();
        setEditingItem(item);
        setEditName(item.name || item.term);
        // Join terms with newline for textarea
        const terms = item.terms || [item.term];
        setEditTerms(terms.join('\n'));
        // Join filters with newline for textarea
        const filters = item.filters || [];
        setEditFilters(filters.join('\n'));
        setEditEnabledSites(item.enabledSites || { ...DEFAULT_ENABLED_SITES });
        setEditSiteOptions({
            ...DEFAULT_SITE_OPTIONS,
            ...(item.siteOptions || {}),
            mandarake: {
                ...DEFAULT_SITE_OPTIONS.mandarake,
                ...(item.siteOptions?.mandarake || {})
            }
        });
        setEditStrict(item.strict !== false);
    };

    const saveEdit = async () => {
        if (!editingItem) return;

        // Parse terms from textarea
        const terms = editTerms.split('\n').map(t => t.trim()).filter(t => t);
        if (terms.length === 0) return alert('At least one term required');

        // Parse filter terms
        const filters = editFilters.split('\n').map(t => t.trim()).filter(t => t);

        try {
            await authenticatedFetch(`/api/watchlist/${editingItem.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editName, terms, filters, enabledSites: editEnabledSites, siteOptions: editSiteOptions, strict: editStrict })
            });
            setEditingItem(null);
            fetchWatchlist();
        } catch (err) {
            console.error('Edit failed:', err);
            alert('Edit failed');
        }
    };

    // Wrapper for blocking that updates local state immediately
    const handleLocalBlock = React.useCallback((item) => {
        // Call parent onBlock for API call
        if (onBlock) {
            onBlock(item);
        }
        // Immediately remove from local selectedResults
        setSelectedResults(prev =>
            prev ? prev.filter(r => r.link !== item.link) : null
        );
    }, [onBlock]);

    const handleLocalFavoriteToggle = React.useCallback(async (item) => {
        if (!onFavoriteToggle) return;
        const isFavorite = await onFavoriteToggle(item);
        if (typeof isFavorite !== 'boolean') return;

        setSelectedResults(prev =>
            prev ? prev.map(result =>
                result.link === item.link ? { ...result, isFavorite } : result
            ) : null
        );
    }, [onFavoriteToggle]);

    const exportToHtml = (items, filename = 'watchlist_results') => {
        const safeName = makeExportFilename(filename);
        const html = buildExportHtml({
            heading: `🔍 ${filename}`,
            items,
            variant: 'watchlist',
            subtitle: `${items.length} items exported on ${new Date().toLocaleString()}`
        });
        downloadExportHtml({ filename: safeName, html });
    };

    // Calculate filtered and sorted results for display
    const filteredAndSortedResults = React.useMemo(() => {
        if (!selectedResults) return [];

        const parsePrice = (priceStr) => {
            if (!priceStr) return 0;
            const match = priceStr.replace(/,/g, '').match(/[\d.]+/);
            return match ? parseFloat(match[0]) : 0;
        };

        const visibleResults = selectedResults.filter(item => {
            return !item.hidden;
        });

        if (selectedResultsMeta.useServerPagination) {
            return visibleResults;
        }

        const filteredResults = visibleResults.filter(item => {
            const matchesTitle = !resultFilter || item.title.toLowerCase().includes(resultFilter.toLowerCase());
            const matchesSource = sourceFilter === 'All' || item.source === sourceFilter;
            return matchesTitle && matchesSource;
        });

        if (sortBy === 'favorite') {
            filteredResults.sort((a, b) => Number(!!b.isFavorite) - Number(!!a.isFavorite));
        } else if (sortBy === 'name') {
            filteredResults.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
        } else if (sortBy === 'relevance') {
            const item = watchlist.find(i => i.id === selectedId);
            const terms = item ? (item.terms || [item.term]) : [];
            const keywords = new Set(terms.flatMap(t => t.toLowerCase().split(/\s+/).filter(k => k)));

            const countMatches = (title) => {
                if (!title) return 0;
                const lowerTitle = title.toLowerCase();
                let count = 0;
                keywords.forEach(k => {
                    if (lowerTitle.includes(k)) count++;
                });
                return count;
            };
            filteredResults.sort((a, b) => countMatches(b.title) - countMatches(a.title));
        } else if (sortBy === 'priceHigh') {
            filteredResults.sort((a, b) => parsePrice(b.price) - parsePrice(a.price));
        } else if (sortBy === 'priceLow') {
            filteredResults.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
        }

        // Keep unread discoveries and favorite price updates ahead of seen items.
        filteredResults.sort((a, b) => Number(!!(b.isNew || b.isUpdated)) - Number(!!(a.isNew || a.isUpdated)));
        return filteredResults;
    }, [selectedResults, resultFilter, sourceFilter, sortBy, watchlist, selectedId, selectedResultsMeta.useServerPagination]);

    const totalPages = selectedResultsMeta.useServerPagination
        ? Math.max(1, selectedResultsMeta.totalPages || 1)
        : Math.max(1, Math.ceil(filteredAndSortedResults.length / ITEMS_PER_PAGE));
    const safePage = Math.min(currentPage, Math.max(1, totalPages));
    const resultCount = selectedResultsMeta.useServerPagination
        ? selectedResultsMeta.total
        : (selectedResults ? selectedResults.filter(item => !item.hidden).length : 0);
    const serverPagination = selectedResultsMeta.useServerPagination;
    const loadedPage = serverPagination ? selectedResultsMeta.page : safePage;
    const visibleResults = React.useMemo(() => {
        if (serverPagination) return filteredAndSortedResults;
        const start = resultMode === 'scroll' ? 0 : (safePage - 1) * ITEMS_PER_PAGE;
        return filteredAndSortedResults.slice(start, safePage * ITEMS_PER_PAGE);
    }, [filteredAndSortedResults, resultMode, serverPagination, safePage]);

    const visiblePages = React.useMemo(() => {
        const pages = new Map();
        visibleResults.forEach((item, index) => {
            const page = serverPagination ? item.watchResultPage
                : resultMode === 'scroll' ? Math.floor(index / ITEMS_PER_PAGE) + 1 : safePage;
            if (!pages.has(page)) pages.set(page, []);
            pages.get(page).push(item);
        });
        return Array.from(pages.entries());
    }, [visibleResults, resultMode, serverPagination, safePage]);

    const canLoadNext = resultMode === 'scroll' && loadedPage < totalPages;

    const loadNextResults = React.useCallback(() => {
        if (!selectedId || !canLoadNext || resultsLoadingRef.current) return;
        if (serverPagination) {
            void fetchWatchResults(selectedId, loadedPage + 1, { append: true });
        } else {
            setCurrentPage(loadedPage + 1);
        }
    }, [canLoadNext, fetchWatchResults, loadedPage, selectedId, serverPagination]);

    useEffect(() => {
        const trigger = nextPageTriggerRef.current;
        if (!trigger || resultsLoading || resultsLoadError || typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) loadNextResults();
        }, { rootMargin: '0px 0px 160px' });

        observer.observe(trigger);
        return () => observer.disconnect();
    }, [loadNextResults, resultsLoadError, resultsLoading]);

    const switchResultMode = () => {
        setResultMode(mode => mode === 'scroll' ? 'paged' : 'scroll');
        setCurrentPage(1);
        if (serverPagination) {
            lastResultsRequest.current = `${selectedId}|1|${sortBy}|${resultFilter}|${sourceFilter}`;
            void fetchWatchResults(selectedId, 1);
        }
    };

    const resultSources = selectedResultsMeta.useServerPagination
        ? availableSources
        : [...new Set((selectedResults || []).filter(item => !item.hidden).map(item => item.source).filter(Boolean))].sort();
    const sortedWatchlist = React.useMemo(() => [...watchlist].sort((a, b) => {
        const countA = newCounts[a.id] || 0;
        const countB = newCounts[b.id] || 0;
        if (countA > 0 && countB === 0) return -1;
        if (countA === 0 && countB > 0) return 1;
        return 0;
    }), [watchlist, newCounts]);

    const unreadCount = Object.values(newCounts).reduce((total, count) => total + count, 0);

    return (
        <div className="watchlist-container">
            {/* Top Row: Run All + Add Form */}
            <div className="watchlist-top-row">
                <form onSubmit={addToWatchlist} className="add-watch-form">
                    <input
                        type="text"
                        value={newTerm}
                        onChange={(e) => setNewTerm(e.target.value)}
                        placeholder="Add a search term…"
                        aria-label="New watch term"
                        className="search-input"
                    />
                    <label className="watch-strict-toggle" title="Enable Strict Filtering (Exact Match)">
                        <input
                            type="checkbox"
                            checked={newStrict}
                            onChange={e => setNewStrict(e.target.checked)}
                        />
                        Strict
                    </label>
                    <button type="submit" className="add-btn" disabled={!newTerm.trim()}><Icon name="add" /> Add</button>
                    <button type="button" className="add-btn gk-btn" onClick={addGKEntries} disabled={!newTerm.trim()}>Add GK</button>
                    <button
                        type="button"
                        className="add-btn taobao-btn"
                        onClick={() => (!taobaoEnabled && !goofishEnabled) ? alert('CN Watch Disabled: Cookies missing for both sites') : addCNWatch()}
                        disabled={(!taobaoEnabled && !goofishEnabled) || !newTerm.trim()}
                        title={(!taobaoEnabled && !goofishEnabled) ? "CN Watch Disabled (Cookies Missing)" : "Add CN Watch (Taobao/Goofish)"}
                    >
                        Add CN
                    </button>
                </form>
                <button
                    className="run-now-btn"
                    onClick={runNow}
                    disabled={
                        currentQueueItem?.id === 'runAll' ||
                        searchQueue.some(q => q.id === 'runAll') ||
                        isGlobalRunning ||
                        watchlist.length === 0
                    }
                >
                    {currentQueueItem?.id === 'runAll'
                        ? `${currentQueueItem.progress || 'Starting...'}`
                        : searchQueue.some(q => q.id === 'runAll')
                            ? 'Queued'
                            : isGlobalRunning
                                ? 'Background...'
                                : <><Icon name="run" /> Run All</>}
                </button>


            </div>

            {/* Search Queue Status */}
            {(currentQueueItem || searchQueue.length > 0 || isGlobalRunning) && (
                <div className="queue-status">
                    {/* Background scheduler running */}
                    {isGlobalRunning && !currentQueueItem && (
                        <span className="queue-item active">
                            <span className="scan-status" role="status">
                                <ScanIndicator />
                                {schedulerProgress
                                    ? `Scheduled ${schedulerProgress.current}/${schedulerProgress.total}: ${schedulerProgress.currentItem}`
                                    : 'Scheduled search running…'}
                            </span>
                            <button
                                className="queue-remove-btn"
                                onClick={async () => {
                                    try {
                                        await authenticatedFetch('/api/abort-scheduled', { method: 'POST' });
                                    } catch (err) {
                                        console.error('Error aborting:', err);
                                    }
                                }}
                                title="Stop scheduled search"
                                aria-label="Stop scheduled search"
                            ><Icon name="close" /></button>
                        </span>
                    )}
                    {currentQueueItem && (
                        <span className="queue-item active">
                            <span className="scan-status" role="status">
                                <ScanIndicator />
                                {currentQueueItem.progress || currentQueueItem.name}
                            </span>
                            <button
                                className="queue-remove-btn"
                                onClick={() => stopSearch(currentQueueItem.id)}
                                title="Stop search"
                                aria-label="Stop search"
                            ><Icon name="close" /></button>
                        </span>
                    )}
                    {searchQueue.map((q) => (
                        <span key={q.id} className="queue-item pending">
                            {q.name}
                            <button
                                className="queue-remove-btn"
                                onClick={() => stopSearch(q.id)}
                                title="Remove from queue"
                                aria-label="Remove from queue"
                            ><Icon name="close" /></button>
                        </span>
                    ))}
                </div>
            )}

            <div className="watchlist-grid">
                {/* Floating mobile drawer trigger */}
                <button
                    className="mobile-sidebar-toggle"
                    type="button"
                    ref={watchDrawerButtonRef}
                    aria-label={`Open watches (${watchlist.length})`}
                    title="Open watches"
                    aria-controls="watch-rail"
                    aria-haspopup="dialog"
                    aria-expanded={mobileSidebarOpen}
                    onClick={() => setMobileSidebarOpen(true)}
                >
                    <Icon name="folder" />
                </button>

                <WatchRail
                    id="watch-rail"
                    className={`watchlist-sidebar ${mobileSidebarOpen ? 'watchlist-drawer' : ''}`}
                    aria-labelledby="watches-title"
                    {...(mobileSidebarOpen && {
                        ref: node => {
                            watchDrawerRef.current = node;
                            if (node && !node.open) node.showModal();
                        },
                        onCancel: event => {
                            event.preventDefault();
                            closeWatchDrawer();
                        },
                        onClick: event => {
                            if (event.target !== event.currentTarget) return;
                            const rect = event.currentTarget.getBoundingClientRect();
                            if (event.clientX > rect.right) closeWatchDrawer();
                        }
                    })}
                >
                    <div className="panel-heading">
                        <h2 id="watches-title"><Icon name="folder" /> Saved watches</h2>
                        {mobileSidebarOpen ? (
                            <button type="button" className="drawer-close" aria-label="Close watches" onClick={() => closeWatchDrawer()}>
                                <Icon name="close" />
                            </button>
                        ) : <span className="panel-count">{watchlist.length}</span>}
                    </div>
                    <div className="sidebar-actions">
                        {!isMerging ? (
                            <>
                                <button className="merge-btn" onClick={() => setIsMerging(true)} disabled={watchlist.length < 2}>
                                    Merge Items
                                </button>
                                <button
                                    className="merge-btn"
                                    onClick={handleMarkAllSeen}
                                    disabled={unreadCount === 0}
                                >
                                    Mark Read
                                </button>
                            </>
                        ) : (
                            <div className="merge-controls">
                                <button className="merge-btn confirm" onClick={handleMerge} disabled={checkedItems.size < 2}>Merge Selected ({checkedItems.size})</button>
                                <button className="merge-btn cancel" onClick={() => { setIsMerging(false); setCheckedItems(new Set()); }}>Cancel</button>
                            </div>
                        )}
                    </div>

                    {watchlist.length === 0 && <p className="rail-empty">No items in watchlist.</p>}
                    <ul className="watchlist-items">
                        {sortedWatchlist.map(item => (
                            <li
                                key={item.id}
                                className={`watchlist-item ${selectedId === item.id ? 'active' : ''} ${draggedItem?.id === item.id ? 'dragging' : ''} ${newCounts[item.id] > 0 ? 'moving-up' : ''}`}
                                draggable={!isMerging}
                                onDragStart={(e) => !isMerging && handleDragStart(e, item)}
                                onDragOver={(e) => !isMerging && handleDragOver(e, item)}
                                onDragEnd={!isMerging ? handleDragEnd : undefined}
                            >
                                {!isMerging && <span className="drag-handle" aria-hidden="true" />}
                                <button
                                    type="button"
                                    className="watch-info"
                                    aria-current={!isMerging && selectedId === item.id ? 'true' : undefined}
                                    aria-pressed={isMerging ? checkedItems.has(item.id) : undefined}
                                    onClick={() => {
                                        if (isMerging) toggleCheck(item.id);
                                        else {
                                            viewResults(item.id, item.name || item.term);
                                            if (mobileSidebarOpen) closeWatchDrawer(true);
                                        }
                                    }}
                                >
                                    <span className="watch-term">
                                        {item.name || item.term}
                                        {item.terms && item.terms.length > 1 && <span className="term-count">{item.terms.length} terms</span>}
                                    </span>
                                    <span className="watch-meta">
                                        {item.lastRun ? new Date(item.lastRun).toLocaleString() : 'Awaiting first search'}
                                        {item.lastResultCount !== undefined && ` • ${item.lastResultCount} results`}
                                    </span>
                                    {newCounts[item.id] > 0 && (
                                        <span className="new-badge">
                                            {newCounts[item.id]} NEW
                                        </span>
                                    )}
                                </button>

                                {!isMerging && (
                                    <div className="watch-row-actions">
                                        <button
                                            type="button"
                                            className="edit-btn"
                                            aria-label={`Edit ${item.name || item.term}`}
                                            onClick={(e) => startEdit(e, item)}
                                            title="Edit terms"
                                        >
                                            <Icon name="edit" />
                                        </button>
                                        <button
                                            type="button"
                                            className="delete-btn"
                                            aria-label={`Remove ${item.name || item.term}`}
                                            onClick={(e) => removeWatch(item.id, e)}
                                            title="Remove from watchlist"
                                        >
                                            <Icon name="trash" />
                                        </button>
                                    </div>
                                )}
                            </li>
                            ))}
                    </ul>
                </WatchRail>

                {editingItem && (
                    <dialog
                        className="modal-content"
                        ref={node => { if (node && !node.open) node.showModal(); }}
                        onCancel={() => setEditingItem(null)}
                        aria-labelledby="edit-watch-heading"
                    >
                        <h3 id="edit-watch-heading">Edit Watch</h3>
                        <div style={{ marginBottom: '15px' }}>
                            <label htmlFor="watch-name">Display name</label>
                            <input
                                type="text"
                                id="watch-name"
                                value={editName}
                                onChange={e => setEditName(e.target.value)}

                            />
                        </div>
                        <div style={{ marginBottom: '20px' }}>
                            <label htmlFor="watch-terms">Search terms (one per line)</label>
                            <textarea
                                id="watch-terms"
                                value={editTerms}
                                onChange={e => setEditTerms(e.target.value)}
                                rows={6}

                            />
                        </div>
                        <div style={{ marginBottom: '20px' }}>
                            <label htmlFor="watch-filters">Terms to hide (one per line)</label>
                            <textarea
                                id="watch-filters"
                                value={editFilters}
                                onChange={e => setEditFilters(e.target.value)}
                                rows={4}
                                placeholder="e.g. 'damaged', 'junk', 'parts only'"

                            />
                        </div>
                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ display: 'block', marginBottom: '5px' }}>Enabled Services:</label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                {['mercari', 'yahoo', 'paypay', 'fril', 'surugaya', 'mandarake', 'taobao', 'goofish'].map(site => {
                                    const isGloballyEnabled = globalSettings.enabledSites?.[site] !== false;
                                    // Cookie-backed sites should not be enabled per-watch while globally off.
                                    const isDisabled = (site === 'taobao' || site === 'goofish' || site === 'mandarake') && !isGloballyEnabled;

                                    return (
                                        <label key={site} style={{ display: 'flex', alignItems: 'center', cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.5 : 1 }}>
                                            <input
                                                type="checkbox"
                                                checked={editEnabledSites[site] !== false}
                                                onChange={e => {
                                                    if (isDisabled) return;
                                                    setEditEnabledSites(prev => ({ ...prev, [site]: e.target.checked }));
                                                }}
                                                disabled={isDisabled}
                                                style={{ marginRight: '8px' }}
                                            />
                                            {SITE_LABELS[site] || site.charAt(0).toUpperCase() + site.slice(1)}
                                        </label>
                                    );
                                })}
                            </div>
                            {editEnabledSites.mandarake !== false && (
                                <div style={{ marginTop: '12px', marginLeft: '4px' }}>
                                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '0.9rem' }}>Mandarake Mode:</label>
                                    <select
                                        value={editSiteOptions.mandarake?.mode || 'garageKit'}
                                        onChange={e => setEditSiteOptions(prev => ({
                                            ...prev,
                                            mandarake: {
                                                ...(prev.mandarake || {}),
                                                mode: e.target.value
                                            }
                                        }))}

                                    >
                                        <option value="full">Full site search</option>
                                        <option value="garageKit">Garage kits only</option>
                                    </select>
                                </div>
                            )}
                        </div>
                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontWeight: 'bold' }}>
                                <input
                                    type="checkbox"
                                    checked={editStrict}
                                    onChange={e => setEditStrict(e.target.checked)}
                                    style={{ marginRight: '8px', transform: 'scale(1.2)' }}
                                />
                                Enable Strict Filtering (Exact Match)
                            </label>
                            <p style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '5px', marginLeft: '24px' }}>
                                If enabled, items must match query exactly (order insensitive) and pass anti-spam checks.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                            <button onClick={() => setEditingItem(null)} className="page-btn">Cancel</button>
                            <button onClick={saveEdit} className="page-btn active">Save Changes</button>
                        </div>
                    </dialog>
                )}

                <section className="watchlist-results" ref={resultsPanelRef} tabIndex={-1} aria-label="Stored results">
                    {selectedTerm && (
                        <>
                            <div className="panel-heading results-heading">
                                <h2>{selectedTerm}</h2>
                                {selectedResults && <span className="result-count">({resultCount} results)</span>}
                            </div>
                            <div className="results-actions">

                                <button
                                    className={`action-btn refresh-btn ${currentQueueItem?.id === selectedId ? 'searching' :
                                        searchQueue.some(q => q.id === selectedId) ? 'queued' : ''
                                        }`}
                                    onClick={() => {
                                        if (!selectedId) return;
                                        const item = watchlist.find(i => i.id === selectedId);
                                        if (item) {
                                            addToSearchQueue(selectedId, item.name || item.term);
                                        }
                                    }}
                                    disabled={currentQueueItem?.id === selectedId || searchQueue.some(q => q.id === selectedId)}
                                >
                                    {currentQueueItem?.id === selectedId
                                        ? 'Searching...'
                                        : searchQueue.some(q => q.id === selectedId)
                                            ? 'Queued'
                                            : <><Icon name="refresh" /> Run Search</>}
                                </button>
                                <button
                                    className={`action-btn email-toggle-btn ${emailSettings[selectedId] ? 'email-on' : 'email-off'}`}
                                    onClick={async () => {
                                        if (!selectedId) return;
                                        try {
                                            const res = await authenticatedFetch(`/api/watchlist/${selectedId}/toggle-email`, {
                                                method: 'POST'
                                            });
                                            const data = await res.json();
                                            setEmailSettings(prev => ({ ...prev, [selectedId]: data.emailNotify }));
                                        } catch (err) {
                                            console.error('Error toggling email:', err);
                                        }
                                    }}
                                    title={emailSettings[selectedId] ? 'Email notifications ON' : 'Email notifications OFF'}
                                >
                                    {emailSettings[selectedId] ? 'Emails On' : 'Emails Off'}
                                </button>
                                <button
                                    className={`action-btn priority-toggle-btn ${prioritySettings[selectedId] ? 'priority-on' : 'priority-off'}`}
                                    onClick={async () => {
                                        if (!selectedId) return;
                                        try {
                                            const res = await authenticatedFetch(`/api/watchlist/${selectedId}/toggle-priority`, {
                                                method: 'POST'
                                            });
                                            const data = await res.json();
                                            setPrioritySettings(prev => ({ ...prev, [selectedId]: data.priority }));
                                        } catch (err) {
                                            console.error('Error toggling priority:', err);
                                        }
                                    }}
                                    title={prioritySettings[selectedId] ? 'Priority Alerts ON (Ntfy)' : 'Priority Alerts OFF'}
                                >
                                    {prioritySettings[selectedId] ? 'Priority ON' : 'Priority Off'}
                                </button>
                                <button
                                    className={`action-btn active-toggle-btn ${activeSettings[selectedId] ? 'active-on' : 'active-off'}`}
                                    onClick={async () => {
                                        if (!selectedId) return;
                                        try {
                                            const res = await authenticatedFetch(`/api/watchlist/${selectedId}/toggle-active`, {
                                                method: 'POST'
                                            });
                                            const data = await res.json();
                                            setActiveSettings(prev => ({ ...prev, [selectedId]: data.active }));
                                            // Also update watchlist state to reflect change for Run All
                                            setWatchlist(prev => prev.map(item =>
                                                item.id === selectedId ? { ...item, active: data.active } : item
                                            ));
                                        } catch (err) {
                                            console.error('Error toggling active:', err);
                                        }
                                    }}
                                    title={activeSettings[selectedId] ? 'Included in Run All' : 'Excluded from Run All'}
                                >
                                    {activeSettings[selectedId] ? 'Active' : 'Inactive'}
                                </button>
                            </div>
                        </>
                    )}

                    {!selectedTerm && (
                        <>
                            <div className="panel-heading"><h2>Stored results</h2></div>
                            <div className="results-idle">
                                <p>{watchlist.length ? 'Select a watch to see its results.' : 'Add a watch to start tracking listings.'}</p>
                            </div>
                        </>
                    )}

                    {selectedResults && (
                        <>
                            {/* Filter Input */}
                            <div className="results-filter">
                                <input
                                    type="text"
                                    placeholder="Filter results by title..."
                                    aria-label="Filter results by title"
                                    value={resultFilter}
                                    onChange={(e) => { setResultFilter(e.target.value); setCurrentPage(1); }}
                                    className="search-input"

                                />

                                <select
                                    aria-label="Filter by marketplace"
                                    value={sourceFilter}
                                    onChange={(e) => { setSourceFilter(e.target.value); setCurrentPage(1); }}
                                    className="search-input"

                                >
                                    <option value="All">All Websites</option>
                                    {resultSources.map(source => (
                                        <option key={source} value={source}>{source}</option>
                                    ))}
                                </select>

                                {(resultFilter || sourceFilter !== 'All') && (
                                    <button
                                        className="clear-filter-btn"
                                        onClick={() => { setResultFilter(''); setSourceFilter('All'); setCurrentPage(1); }}
                                        style={{ marginLeft: '10px' }}
                                    >
                                        <Icon name="close" /> Clear
                                    </button>
                                )}
                                <select
                                    aria-label="Sort results"
                                    value={sortBy}
                                    onChange={(e) => { setSortBy(e.target.value); setCurrentPage(1); }}
                                    className="search-input"

                                >
                                    <option value="time">Sort: Time Scraped</option>
                                    <option value="favorite">Sort: Favorited</option>
                                    <option value="name">Sort: Name</option>
                                    <option value="priceHigh">Sort: Price High→Low</option>
                                    <option value="priceLow">Sort: Price Low→High</option>
                                </select>
                                <button type="button" className="view-mode-btn" onClick={switchResultMode}>
                                    <Icon name="list" /> {resultMode === 'scroll' ? 'Paged view' : 'Infinite scroll'}
                                </button>
                            </div>
                            {visiblePages.map(([page, items]) => (
                                <section key={`${selectedId}:${page}`} aria-label={`Page ${page}`}>
                                    {totalPages > 1 && resultMode === 'scroll' && (
                                        <h3 className="watch-page-divider">Page {page}</h3>
                                    )}
                                    <div className="results-grid">
                                        {items.map((item, index) => (
                                            <ResultCard
                                                key={item.link || item.url || index}
                                                item={item}
                                                onBlock={handleLocalBlock}
                                                onFavoriteToggle={handleLocalFavoriteToggle}
                                                isNew={item.isNew}
                                            />
                                        ))}
                                    </div>
                                </section>
                            ))}

                            {visiblePages.length === 0 && !resultsLoading && !resultsLoadError && (
                                <p className="empty-results-message">
                                    {resultFilter || sourceFilter !== 'All' ? 'No results match your filter.' : 'No stored results yet.'}
                                </p>
                            )}
                            {canLoadNext && !resultsLoadError && (
                                <div className="watch-page-next" ref={nextPageTriggerRef}>
                                    <button type="button" className="page-btn" onClick={loadNextResults} disabled={resultsLoading}>
                                        Load page {loadedPage + 1}
                                    </button>
                                </div>
                            )}

                            {resultMode === 'paged' && totalPages > 1 && (
                                <div className="pagination">
                                    <button
                                        className="page-btn"
                                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                        disabled={currentPage === 1}
                                    >
                                        ← Prev
                                    </button>

                                    <div className="page-numbers">
                                        {(() => {
                                            const pages = [];
                                            const start = Math.max(1, currentPage - 2);
                                            const end = Math.min(totalPages, start + 4);
                                            const adjustedStart = Math.max(1, Math.min(start, totalPages - 4));

                                            for (let i = adjustedStart; i <= end; i++) {
                                                pages.push(
                                                    <button
                                                        key={i}
                                                        className={`page-number-btn ${currentPage === i ? 'active' : ''}`}
                                                        onClick={() => setCurrentPage(i)}
                                                    >
                                                        {i}
                                                    </button>
                                                );
                                            }
                                            return pages;
                                        })()}
                                    </div>

                                    <div className="page-jump">
                                        <input
                                            type="number"
                                            min="1"
                                            max={totalPages}
                                            placeholder="#"
                                            className="page-input"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const val = parseInt(e.target.value);
                                                    if (val >= 1 && val <= totalPages) {
                                                        setCurrentPage(val);
                                                        e.target.value = '';
                                                    }
                                                }
                                            }}
                                        />
                                        <span className="total-pages">/ {totalPages}</span>
                                    </div>

                                    <button
                                        className="page-btn"
                                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                        disabled={currentPage >= totalPages}
                                    >
                                        Next →
                                    </button>

                                    <div className="export-actions">
                                        <button
                                            className="page-btn"
                                            onClick={() => handleExportClipboard(visibleResults)}

                                            title="Copy Name - Link to Clipboard"
                                        >
                                            Copy
                                        </button>
                                        <button
                                            className="page-btn"
                                            onClick={() => exportToHtml(
                                                visibleResults,
                                                selectedTerm || 'watchlist_results'
                                            )}

                                        >
                                            Export HTML
                                        </button>
                                    </div>
                            </div>
                            )}

                            {/* Export Button (shown when no pagination) */}
                            {visibleResults.length > 0 && (resultMode === 'scroll' || totalPages <= 1) && (
                                <div className="export-actions standalone">
                                    <button
                                        className="page-btn"
                                        onClick={() => handleExportClipboard(visibleResults)}

                                        title="Copy Name - Link to Clipboard"
                                    >
                                        Copy ({visibleResults.length})
                                    </button>
                                    <button
                                        className="page-btn"
                                        onClick={() => exportToHtml(
                                            visibleResults,
                                            selectedTerm || 'watchlist_results'
                                        )}

                                    >
                                        Export HTML ({visibleResults.length})
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                    {resultsLoading && <p className="watch-results-status" role="status">Loading results…</p>}
                    {resultsLoadError && (
                        <div className="watch-results-status">
                            <p role="alert">Could not load page {resultsLoadError.page}.</p>
                            <button type="button" className="page-btn" onClick={() => fetchWatchResults(
                                selectedId,
                                resultsLoadError.page,
                                { append: resultsLoadError.append, throughPage: resultsLoadError.throughPage }
                            )}>Retry</button>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default WatchlistManager;
