import React, { useState, useEffect } from 'react';
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
        pageSize: 24,
        totalPages: 1,
        useServerPagination: false
    });
    const markResultsAsSeenRef = React.useRef(null);
    const lastResultsRequest = React.useRef('');
    const [schedulerProgress, setSchedulerProgress] = useState(null);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(window.innerWidth <= 767);

    // Track window resize for responsive placeholder
    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth <= 767);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);


    // Track previous running state to detect completion
    const wasRunningRef = React.useRef(false);
    const completionVersionRef = React.useRef(0);

    // Poll for global search status and auto-refresh on completion

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


    const ITEMS_PER_PAGE = 24;

    const fetchGlobalSettings = React.useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/settings');
            const data = await res.json();
            setGlobalSettings(data || {});
        } catch (err) {
            console.error('Error fetching global settings:', err);
        }
    }, [authenticatedFetch]);

    const fetchWatchlist = React.useCallback(async () => {
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

    const fetchWatchResults = React.useCallback(async (id, page = 1) => {
        const markSeen = async () => {
            if (markResultsAsSeenRef.current !== id || newCounts[id] <= 0) {
                return;
            }

            await authenticatedFetch(`/api/results/${id}/seen`, { method: 'POST' });
            setNewCounts(prev => ({ ...prev, [id]: 0 }));
            markResultsAsSeenRef.current = null;
        };

        try {
            const params = new URLSearchParams();
            params.set('page', String(page || 1));
            params.set('pageSize', String(ITEMS_PER_PAGE));
            const { sort, order } = getSortParams(sortBy);
            params.set('sort', sort);
            params.set('order', order);

            const normalizedFilter = resultFilter.trim();
            if (normalizedFilter) {
                params.set('filter', normalizedFilter);
            }

            if (sourceFilter !== 'All') {
                params.set('source', sourceFilter);
            }

            const res = await authenticatedFetch(`/api/results/${id}?${params.toString()}`);
            const data = await res.json();
            if (hasServerPaginationResponse(data)) {
                const serverMeta = {
                    total: Number(data.total) || 0,
                    page: Number(data.page) || 1,
                    pageSize: Number(data.pageSize) || ITEMS_PER_PAGE,
                    totalPages: Number(data.totalPages) || 1,
                    useServerPagination: true
                };
                setSelectedResultsMeta(serverMeta);
                setSelectedResults(Array.isArray(data.items) ? data.items : []);
                setAvailableSources(Array.isArray(data.sources) ? data.sources : []);
                setCurrentPage(serverMeta.page || page);
                await markSeen();
                return;
            }

            const fallbackItems = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
            setSelectedResultsMeta({
                total: fallbackItems.length,
                page: Math.max(1, page),
                pageSize: ITEMS_PER_PAGE,
                totalPages: Math.max(1, Math.ceil(fallbackItems.length / ITEMS_PER_PAGE)),
                useServerPagination: false
            });
            setSelectedResults(fallbackItems);
            setAvailableSources([...new Set(fallbackItems.map(item => item.source).filter(Boolean))].sort());
            setCurrentPage(Math.max(1, page));

            await markSeen();
        } catch (err) {
            console.error('Error fetching stored results', err);
        }
    }, [authenticatedFetch, getSortParams, markResultsAsSeenRef, newCounts, resultFilter, sourceFilter, sortBy]);

    const viewResults = React.useCallback(async (id, term) => {
        setSelectedId(id);
        setSelectedTerm(term);
        setResultFilter('');
        setSourceFilter('All');
        setSelectedResults(null);
        setAvailableSources([]);
        setCurrentPage(1);
        setSelectedResultsMeta(prev => ({ ...prev, useServerPagination: false }));
        markResultsAsSeenRef.current = id;
        lastResultsRequest.current = `${id}|1|${sortBy}| |All`;
        await fetchWatchResults(id, 1);
    }, [fetchWatchResults, sortBy]);

    const refreshSelectedResults = React.useCallback(async () => {
        if (!selectedId) return;
        await fetchWatchResults(selectedId, selectedResultsMeta.page || 1);
    }, [fetchWatchResults, selectedId, selectedResultsMeta.page]);
    const refreshSelectedResultsRef = React.useRef(refreshSelectedResults);
    useEffect(() => {
        refreshSelectedResultsRef.current = refreshSelectedResults;
    }, [refreshSelectedResults]);

    // Poll for global search status and auto-refresh on completion
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
                const running = Boolean(data.isRunning);
                const completionVersion = Number(data.completionVersion) || 0;
                const completionChanged = completionVersion !== completionVersionRef.current;
                nextDelay = running ? 2000 : (document.hidden ? 60000 : 15000);

                // The completion version catches runs that start and finish between polls.
                if ((wasRunningRef.current && !running) || completionChanged) {
                    console.log('Search completed, refreshing data...');
                    fetchWatchlist();
                    fetchNewCounts();
                    if (selectedId) {
                        refreshSelectedResultsRef.current();
                    }
                }

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
            if (selectedResults && selectedResults.id === id) {
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

        return filteredResults;
    }, [selectedResults, resultFilter, sourceFilter, sortBy, watchlist, selectedId, selectedResultsMeta.useServerPagination]);

    const totalPages = selectedResultsMeta.useServerPagination
        ? Math.max(1, selectedResultsMeta.totalPages || 1)
        : Math.max(1, Math.ceil(filteredAndSortedResults.length / ITEMS_PER_PAGE));
    const safePage = Math.min(currentPage, Math.max(1, totalPages));
    const resultCount = selectedResultsMeta.useServerPagination
        ? selectedResultsMeta.total
        : (selectedResults ? selectedResults.filter(item => !item.hidden).length : 0);
    const visibleResults = React.useMemo(
        () => (
            selectedResultsMeta.useServerPagination
                ? filteredAndSortedResults
                : filteredAndSortedResults.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE)
        ),
        [filteredAndSortedResults, selectedResultsMeta.useServerPagination, safePage]
    );
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

    return (
        <div className="watchlist-container">

            {/* Top Row: Run All + Add Form */}
            <div className="watchlist-top-row">
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
                        ? `🔄 ${currentQueueItem.progress || 'Starting...'}`
                        : searchQueue.some(q => q.id === 'runAll')
                            ? '⏳ Queued'
                            : isGlobalRunning
                                ? '⏳ Background...'
                                : '▶ Run All'}
                </button>

                <form onSubmit={addToWatchlist} className="add-watch-form">
                    <input
                        type="text"
                        value={newTerm}
                        onChange={(e) => setNewTerm(e.target.value)}
                        placeholder={isMobile ? "Add watch..." : "Add new term to watch..."}
                        className="search-input"
                        style={{ maxWidth: '400px', fontSize: '1rem' }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', marginLeft: '10px', fontSize: '0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' }} title="Enable Strict Filtering (Exact Match)">
                        <input
                            type="checkbox"
                            checked={newStrict}
                            onChange={e => setNewStrict(e.target.checked)}
                            style={{ marginRight: '5px' }}
                        />
                        Strict
                    </label>
                    <button type="submit" className="add-btn">Add</button>
                    <button type="button" className="add-btn gk-btn" onClick={addGKEntries}>Add GK</button>
                        <button
                            type="button"
                            className="add-btn taobao-btn"
                            onClick={() => (!taobaoEnabled && !goofishEnabled) ? alert('CN Watch Disabled: Cookies missing for both sites') : addCNWatch()}
                            disabled={(!taobaoEnabled && !goofishEnabled) || !newTerm.trim()}
                            title={(!taobaoEnabled && !goofishEnabled) ? "CN Watch Disabled (Cookies Missing)" : "Add CN Watch (Taobao/Goofish)"}
                        style={{
                            backgroundColor: (!taobaoEnabled && !goofishEnabled) ? '#555' : '#ff5000',
                            marginLeft: '5px',
                            cursor: (!taobaoEnabled && !goofishEnabled) ? 'not-allowed' : 'pointer',
                            opacity: (!taobaoEnabled && !goofishEnabled) ? 0.6 : 1
                        }}
                    >
                        Add CN
                    </button>
                </form>


            </div>

            {/* Search Queue Status */}
            {(currentQueueItem || searchQueue.length > 0 || isGlobalRunning) && (
                <div className="queue-status">
                    {/* Background scheduler running */}
                    {isGlobalRunning && !currentQueueItem && (
                        <span className="queue-item active">
                            🔄 {schedulerProgress
                                ? `Scheduled ${schedulerProgress.current}/${schedulerProgress.total}: ${schedulerProgress.currentItem}`
                                : 'Scheduled search running...'}
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
                            >✕</button>
                        </span>
                    )}
                    {currentQueueItem && (
                        <span className="queue-item active">
                            🔄 {currentQueueItem.progress || currentQueueItem.name}
                            <button
                                className="queue-remove-btn"
                                onClick={() => stopSearch(currentQueueItem.id)}
                                title="Stop search"
                            >✕</button>
                        </span>
                    )}
                    {searchQueue.map((q) => (
                        <span key={q.id} className="queue-item pending">
                            📋 {q.name}
                            <button
                                className="queue-remove-btn"
                                onClick={() => stopSearch(q.id)}
                                title="Remove from queue"
                            >✕</button>
                        </span>
                    ))}
                </div>
            )}

            <div className="watchlist-grid">
                {/* Mobile toggle button */}
                <button
                    className="mobile-sidebar-toggle"
                    onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
                >
                    {mobileSidebarOpen ? '✕ Close' : '☰ Watches'}
                </button>

                {/* Overlay for mobile */}
                {mobileSidebarOpen && (
                    <div
                        className="sidebar-overlay"
                        onClick={() => setMobileSidebarOpen(false)}
                    />
                )}

                <div className={`watchlist-sidebar ${mobileSidebarOpen ? 'open' : ''}`}>
                    <div className="sidebar-actions" style={{ marginBottom: '10px' }}>
                        {!isMerging ? (
                            <>
                                <button className="merge-btn" onClick={() => setIsMerging(true)} disabled={watchlist.length < 2}>
                                    🔗 Merge Items
                                </button>
                                <button
                                    className="merge-btn"
                                    style={{
                                        marginLeft: '5px',
                                        opacity: Object.values(newCounts).reduce((a, b) => a + b, 0) > 0 ? 1 : 0.5,
                                        cursor: Object.values(newCounts).reduce((a, b) => a + b, 0) > 0 ? 'pointer' : 'not-allowed'
                                    }}
                                    onClick={handleMarkAllSeen}
                                    disabled={Object.values(newCounts).reduce((a, b) => a + b, 0) === 0}
                                >
                                    ✓ Mark Read
                                </button>
                            </>
                        ) : (
                            <div className="merge-controls">
                                <button className="merge-btn confirm" onClick={handleMerge} disabled={checkedItems.size < 2}>Merge Selected ({checkedItems.size})</button>
                                <button className="merge-btn cancel" onClick={() => { setIsMerging(false); setCheckedItems(new Set()); }}>Cancel</button>
                            </div>
                        )}
                    </div>

                    {watchlist.length === 0 && <p>No items in watchlist.</p>}
                    <ul className="watchlist-items">
                        {sortedWatchlist.map(item => (
                                <li
                                    key={item.id}
                                    className={`watchlist-item ${selectedId === item.id ? 'active' : ''} ${draggedItem?.id === item.id ? 'dragging' : ''} ${newCounts[item.id] > 0 ? 'moving-up' : ''}`}
                                    draggable={!isMerging}
                                    onDragStart={(e) => !isMerging && handleDragStart(e, item)}
                                    onDragOver={(e) => !isMerging && handleDragOver(e, item)}
                                    onDragEnd={!isMerging ? handleDragEnd : undefined}
                                    onClick={() => {
                                        if (isMerging) toggleCheck(item.id);
                                        else viewResults(item.id, item.term);
                                    }}
                                    style={{
                                        borderLeft: selectedId === item.id ? '4px solid var(--accent-color)' : 'none',
                                        backgroundColor: selectedId === item.id ? '#333' : undefined
                                    }}
                                >
                                    {isMerging ? (
                                        <input
                                            type="checkbox"
                                            checked={checkedItems.has(item.id)}
                                            readOnly
                                            style={{ marginRight: '10px', transform: 'scale(1.5)', cursor: 'pointer' }}
                                        />
                                    ) : (
                                        <span className="drag-handle">☰</span>
                                    )}

                                    <div className="watch-info">
                                        <span className="watch-term">
                                            {item.name || item.term}
                                            {item.terms && item.terms.length > 1 && <span style={{ fontSize: '0.8em', color: '#888', marginLeft: '5px' }}>({item.terms.length} terms)</span>}
                                        </span>
                                        <span className="watch-meta">
                                            Last Searched: {item.lastRun ? new Date(item.lastRun).toLocaleString() : 'Pending'}
                                            {item.lastResultCount !== undefined && ` • ${item.lastResultCount} results`}
                                        </span>
                                        {newCounts[item.id] > 0 && (
                                            <span className="new-badge">
                                                {newCounts[item.id]} NEW
                                            </span>
                                        )}
                                    </div>

                                    {!isMerging && (
                                        <button
                                            className="edit-btn"
                                            onClick={(e) => startEdit(e, item)}
                                            style={{ marginRight: '5px' }}
                                            title="Edit terms"
                                        >
                                            ✎
                                        </button>
                                    )}

                                    {!isMerging && (
                                        <button
                                            className="delete-btn"
                                            onClick={(e) => removeWatch(item.id, e)}
                                            title="Remove from watchlist"
                                        >
                                            &times;
                                        </button>
                                    )}
                                </li>
                            ))}
                    </ul>
                </div>

                {editingItem && (
                    <div className="modal-overlay" style={{
                        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000
                    }}>
                        <div className="modal-content" style={{
                            backgroundColor: '#2a2a2a', padding: '20px', borderRadius: '8px', minWidth: '400px'
                        }}>
                            <h3>Edit Watch</h3>
                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px' }}>Name (for display):</label>
                                <input
                                    type="text"
                                    value={editName}
                                    onChange={e => setEditName(e.target.value)}
                                    style={{ width: '100%', padding: '8px', background: '#333', border: '1px solid #555', color: 'white' }}
                                />
                            </div>
                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'block', marginBottom: '5px' }}>Search Terms (one per line):</label>
                                <textarea
                                    value={editTerms}
                                    onChange={e => setEditTerms(e.target.value)}
                                    rows={6}
                                    style={{ width: '100%', padding: '8px', background: '#333', border: '1px solid #555', color: 'white' }}
                                />
                            </div>
                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'block', marginBottom: '5px' }}>Filter Terms (one per line - hide items containing these):</label>
                                <textarea
                                    value={editFilters}
                                    onChange={e => setEditFilters(e.target.value)}
                                    rows={4}
                                    placeholder="e.g. 'damaged', 'junk', 'parts only'"
                                    style={{ width: '100%', padding: '8px', background: '#333', border: '1px solid #555', color: 'white' }}
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
                                            style={{ width: '100%', padding: '8px', background: '#333', border: '1px solid #555', color: 'white' }}
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
                        </div>
                    </div>
                )}

                <div className="watchlist-results">
                    {selectedTerm && (
                        <>
                            <h3>Stored Results for "{selectedTerm}" <span style={{ fontSize: '0.8em', color: '#888', marginLeft: '10px' }}>({resultCount} results)</span></h3>
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
                                        ? '🔄 Searching...'
                                        : searchQueue.some(q => q.id === selectedId)
                                            ? '⏳ Queued'
                                            : '🔄 Run Search'}
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
                                    {emailSettings[selectedId] ? '🔔 Emails On' : '🔕 Emails Off'}
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
                                    style={prioritySettings[selectedId] ? { background: '#d32f2f', color: 'white' } : {}}
                                >
                                    {prioritySettings[selectedId] ? '🚨 Priority ON' : '💤 Priority Off'}
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
                                    {activeSettings[selectedId] ? '✅ Active' : '⛔ Inactive'}
                                </button>
                            </div>
                        </>
                    )}

                    {!selectedTerm && <p className="empty-results-message">Select an item to view stored results.</p>}

                    {selectedResults && (
                        <>
                            {/* Filter Input */}
                            <div className="results-filter">
                                <input
                                    type="text"
                                    placeholder="Filter results by title..."
                                    value={resultFilter}
                                    onChange={(e) => { setResultFilter(e.target.value); setCurrentPage(1); }}
                                    className="search-input"
                                    style={{ maxWidth: '400px', fontSize: '0.9rem', marginBottom: '1rem', marginRight: '10px' }}
                                />

                                <select
                                    value={sourceFilter}
                                    onChange={(e) => { setSourceFilter(e.target.value); setCurrentPage(1); }}
                                    className="search-input" // Reusing search-input style for consistency
                                    style={{ maxWidth: '200px', fontSize: '0.9rem', marginBottom: '1rem', padding: '0.5rem' }}
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
                                        ✕ Clear
                                    </button>
                                )}
                                <select
                                    value={sortBy}
                                    onChange={(e) => { setSortBy(e.target.value); setCurrentPage(1); }}
                                    className="search-input"
                                    style={{ maxWidth: '180px', fontSize: '0.9rem', marginBottom: '1rem', padding: '0.5rem', marginLeft: '10px' }}
                                >
                                    <option value="time">Sort: Time Scraped</option>
                                    <option value="favorite">Sort: Favorited</option>
                                    <option value="name">Sort: Name</option>
                                    <option value="priceHigh">Sort: Price High→Low</option>
                                    <option value="priceLow">Sort: Price Low→High</option>
                                </select>
                            </div>
                            <div className="results-grid">
                                {(() => {
                                    if (filteredAndSortedResults.length === 0) {
                                        return <p>{resultFilter || sourceFilter !== 'All' ? 'No results match your filter.' : 'No results found in last run (or run hasn\'t happened yet).'}</p>;
                                    }

                                    return visibleResults
                                        .map((item, idx) => (
                                            <ResultCard
                                                key={item.link || item.url || idx}
                                                item={item}
                                                onBlock={handleLocalBlock}
                                                onFavoriteToggle={handleLocalFavoriteToggle}
                                                isNew={item.isNew}
                                            />
                                        ));
                                })()}
                            </div>

                            {/* Pagination */}
                            {totalPages > 1 && (
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

                                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '5px' }}>
                                        <button
                                            className="page-btn"
                                            onClick={() => handleExportClipboard(visibleResults)}
                                            style={{ backgroundColor: '#333', border: '1px solid #555' }}
                                            title="Copy Name - Link to Clipboard"
                                        >
                                            📋 Copy
                                        </button>
                                        <button
                                            className="page-btn"
                                            onClick={() => exportToHtml(
                                                visibleResults,
                                                selectedTerm || 'watchlist_results'
                                            )}
                                            style={{ backgroundColor: '#333', border: '1px solid #555' }}
                                        >
                                            📥 Export HTML
                                        </button>
                                    </div>
                            </div>
                            )}

                            {/* Export Button (shown when no pagination) */}
                            {visibleResults.length > 0 && totalPages <= 1 && (
                                <div style={{ textAlign: 'right', marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '5px' }}>
                                    <button
                                        className="page-btn"
                                        onClick={() => handleExportClipboard(visibleResults)}
                                        style={{ backgroundColor: '#333', border: '1px solid #555' }}
                                        title="Copy Name - Link to Clipboard"
                                    >
                                        📋 Copy ({visibleResults.length})
                                    </button>
                                    <button
                                        className="page-btn"
                                        onClick={() => exportToHtml(
                                            visibleResults,
                                            selectedTerm || 'watchlist_results'
                                        )}
                                        style={{ backgroundColor: '#333', border: '1px solid #555' }}
                                    >
                                        📥 Export HTML ({visibleResults.length})
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default WatchlistManager;
