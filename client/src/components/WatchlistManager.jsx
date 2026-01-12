import React, { useState, useEffect } from 'react';
import ResultCard from './ResultCard';

const WatchlistManager = ({ authenticatedFetch, onBlock, taobaoEnabled, goofishEnabled }) => {
    const [watchlist, setWatchlist] = useState([]);
    const [newTerm, setNewTerm] = useState('');
    const [selectedResults, setSelectedResults] = useState(null);
    const [selectedTerm, setSelectedTerm] = useState('');
    const [selectedId, setSelectedId] = useState(null);

    const [isRunning, setIsRunning] = useState(false);
    const [runProgress, setRunProgress] = useState({ current: 0, total: 0, term: '' });
    const [newCounts, setNewCounts] = useState({});
    const [currentPage, setCurrentPage] = useState(1);
    const [resultFilter, setResultFilter] = useState('');
    const [emailSettings, setEmailSettings] = useState({});
    const [prioritySettings, setPrioritySettings] = useState({});
    const [activeSettings, setActiveSettings] = useState({});
    const [singleSearching, setSingleSearching] = useState(false);
    const [draggedItem, setDraggedItem] = useState(null);
    const [isGlobalRunning, setIsGlobalRunning] = useState(false);

    // Search queue for sequential single searches
    const [searchQueue, setSearchQueue] = useState([]);  // Array of {id, name}

    const [currentQueueItem, setCurrentQueueItem] = useState(null);  // Currently processing item
    const isProcessingRef = React.useRef(false);
    const [sourceFilter, setSourceFilter] = useState('All');
    const [sortBy, setSortBy] = useState('time'); // 'time', 'name', 'priceHigh', 'priceLow'
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

    // Poll for global search status and auto-refresh on completion
    useEffect(() => {
        const checkStatus = async () => {
            try {
                const res = await authenticatedFetch('/api/status');
                const data = await res.json();

                // Detect transition: was running -> now stopped
                if (wasRunningRef.current && !data.isRunning) {
                    console.log('Search completed, refreshing data...');
                    fetchWatchlist();
                    fetchNewCounts();
                    // Also refresh currently viewed results if any
                    if (selectedId) {
                        refreshSelectedResults();
                    }
                }

                wasRunningRef.current = data.isRunning;
                setIsGlobalRunning(data.isRunning);
                setSchedulerProgress(data.progress);
            } catch (err) {
                console.error('Error checking status:', err);
            }
        };

        const interval = setInterval(checkStatus, 2000);
        checkStatus();
        return () => clearInterval(interval);
    }, [selectedId]);

    // Multi-term / Merge / Edit State
    const [isMerging, setIsMerging] = useState(false);
    const [checkedItems, setCheckedItems] = useState(new Set());
    const [editingItem, setEditingItem] = useState(null);
    const [editName, setEditName] = useState('');
    const [editTerms, setEditTerms] = useState('');
    const [editFilters, setEditFilters] = useState('');
    const [editEnabledSites, setEditEnabledSites] = useState({});
    const [globalSettings, setGlobalSettings] = useState({}); // Renamed to avoid collision with 'activeSettings' maybe? No, 'settings' is fine but distinct from local settings maps.


    const ITEMS_PER_PAGE = 24;

    // Reset to page 1 when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [resultFilter, sourceFilter, sortBy]);

    useEffect(() => {
        fetchWatchlist();
        fetchNewCounts();
        fetchWatchlist();
        fetchNewCounts();
        fetchGlobalSettings();
    }, []);

    const fetchGlobalSettings = async () => {
        try {
            const res = await authenticatedFetch('/api/settings');
            const data = await res.json();
            setGlobalSettings(data);
        } catch (err) {
            console.error('Error fetching global settings:', err);
        }
    };

    const fetchWatchlist = async () => {
        try {
            const res = await authenticatedFetch('/api/watchlist');
            const data = await res.json();
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
        } catch (err) {
            console.error('Error fetching watchlist:', err);
        }
    };

    const fetchNewCounts = async () => {
        try {
            const res = await authenticatedFetch('/api/watchlist/newcounts');
            const data = await res.json();
            setNewCounts(data);
        } catch (err) {
            console.error('Error fetching new counts:', err);
        }
    };

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
    }, [searchQueue, selectedId, selectedTerm]);

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
            await authenticatedFetch('/api/run-now', { method: 'POST' });
        } catch (err) {
            console.error('Error starting batch run:', err);
            alert('Failed to start run');
        }
    };

    const addToWatchlist = async (e) => {
        e.preventDefault();
        if (!newTerm.trim()) return;

        try {
            const res = await authenticatedFetch('/api/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    term: newTerm,
                    enabledSites: {
                        mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true,
                        taobao: false, goofish: false
                    }
                })
            });
            const data = await res.json();
            setNewTerm('');
            fetchWatchlist();
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
            await authenticatedFetch('/api/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    terms,
                    name: terms[0], // Set name explicitly to first term
                    filters: ['プラモデル'],
                    enabledSites: {
                        mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true,
                        taobao: false, goofish: false
                    }
                })
            });
            setNewTerm('');
            fetchWatchlist();
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
            goofish: goofishEnabled
        };

        try {
            await authenticatedFetch('/api/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    term: newTerm,
                    enabledSites: cnEnabledSites,
                    name: `${newTerm} (CN)`
                })
            });
            setNewTerm('');
            fetchWatchlist();
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

        const dragIndex = watchlist.findIndex(i => i.id === draggedItem.id);
        const hoverIndex = watchlist.findIndex(i => i.id === item.id);

        if (dragIndex === hoverIndex) return;

        // Reorder locally for smooth visual feedback
        const newList = [...watchlist];
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
                body: JSON.stringify({ orderedIds: watchlist.map(i => i.id) })
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
        const firstId = watchlist.find(item => checkedItems.has(item.id))?.id;
        const firstItem = watchlist.find(item => item.id === firstId);
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
        setEditEnabledSites(item.enabledSites || {
            mercari: true, yahoo: true, paypay: true, fril: true, surugaya: true, taobao: false, goofish: false
        });
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
                body: JSON.stringify({ name: editName, terms, filters, enabledSites: editEnabledSites })
            });
            setEditingItem(null);
            fetchWatchlist();
        } catch (err) {
            console.error('Edit failed:', err);
            alert('Edit failed');
        }
    };

    const viewResults = async (id, term) => {
        setSelectedId(id);
        setSelectedTerm(term);
        // Reset local filters when opening new item
        setResultFilter(''); // Default to showing All items
        setSourceFilter('All');
        setSelectedResults(null); // Clear previous
        setCurrentPage(1); // Reset pagination
        try {
            const res = await authenticatedFetch(`/api/results/${id}`);
            const data = await res.json();
            setSelectedResults(data.items || []);

            // Mark as seen if there are new items
            if (newCounts[id] && newCounts[id] > 0) {
                await authenticatedFetch(`/api/results/${id}/seen`, {
                    method: 'POST'
                });
                // Update local newCounts
                setNewCounts(prev => ({ ...prev, [id]: 0 }));
            }
        } catch (err) {
            console.error("Error fetching stored results", err);
        }
    };

    // Silent refresh of currently selected results (no "seen" marking)
    const refreshSelectedResults = async () => {
        if (!selectedId) return;
        try {
            const res = await authenticatedFetch(`/api/results/${selectedId}`);
            const data = await res.json();
            setSelectedResults(data.items || []);
        } catch (err) {
            console.error("Error refreshing results", err);
        }
    };

    // Wrapper for blocking that updates local state immediately
    const handleLocalBlock = (item) => {
        // Call parent onBlock for API call
        if (onBlock) {
            onBlock(item);
        }
        // Immediately remove from local selectedResults
        setSelectedResults(prev =>
            prev ? prev.filter(r => r.link !== item.link) : null
        );
    };

    // Export results to HTML file with 5-column grid
    const exportToHtml = (items, filename = 'watchlist_results') => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${filename} - GK Watch Export</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #eee; padding: 20px; }
    h1 { text-align: center; margin-bottom: 20px; color: #fff; }
    .info { text-align: center; margin-bottom: 20px; color: #888; }
    .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 15px; }
    .card { background: #2a2a2a; border-radius: 8px; overflow: hidden; transition: transform 0.2s; border: 1px solid #333; }
    .card:hover { transform: translateY(-3px); border-color: #555; }
    .card a { text-decoration: none; color: inherit; display: block; }
    .card img { width: 100%; height: 280px; object-fit: cover; background: #333; }
    .card-body { padding: 10px; }
    .card-title { font-size: 0.85rem; font-weight: 500; margin-bottom: 5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; height: 2.6em; }
    .card-price { font-size: 0.9rem; font-weight: bold; color: #fff; }
    .card-source { font-size: 0.7rem; color: #888; margin-top: 3px; }
    @media (max-width: 1200px) { .grid { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 600px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <h1>🔍 ${filename}</h1>
  <p class="info">${items.length} items exported on ${new Date().toLocaleString()}</p>
  <div class="grid">
    ${items.map(item => `
    <div class="card">
      <a href="${item.link}" target="_blank" rel="noopener">
        <img src="${item.image || 'https://via.placeholder.com/200x280?text=No+Image'}" alt="${(item.title || '').replace(/"/g, '&quot;')}" loading="lazy" onerror="this.src='https://via.placeholder.com/200x280?text=No+Image'">
        <div class="card-body">
          <div class="card-title">${item.title || 'Unknown'}</div>
          <div class="card-price">${item.price || 'N/A'}</div>
          <div class="card-source">${item.source || ''}</div>
        </div>
      </a>
    </div>`).join('')}
  </div>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Sanitize filename but preserve spaces and harmless punctuation
        const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_');

        // Add date/time to filename
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5); // HH-MM

        a.download = `${safeFilename} - ${dateStr} ${timeStr}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Calculate filtered and sorted results for display
    const filteredAndSortedResults = React.useMemo(() => {
        if (!selectedResults) return [];

        const parsePrice = (priceStr) => {
            if (!priceStr) return 0;
            const match = priceStr.replace(/,/g, '').match(/[\d.]+/);
            return match ? parseFloat(match[0]) : 0;
        };

        let results = selectedResults.filter(item => {
            if (item.hidden) return false;
            const matchesTitle = !resultFilter || item.title.toLowerCase().includes(resultFilter.toLowerCase());
            const matchesSource = sourceFilter === 'All' || item.source === sourceFilter;
            return matchesTitle && matchesSource;
        });

        if (sortBy === 'name') {
            results.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
        } else if (sortBy === 'priceHigh') {
            results.sort((a, b) => parsePrice(b.price) - parsePrice(a.price));
        } else if (sortBy === 'priceLow') {
            results.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
        }

        return results;
    }, [selectedResults, resultFilter, sourceFilter, sortBy]);

    const totalPages = Math.ceil(filteredAndSortedResults.length / ITEMS_PER_PAGE);

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
                    <button type="submit" className="add-btn">Add</button>
                    <button type="button" className="add-btn gk-btn" onClick={addGKEntries}>Add GK</button>
                    <button
                        type="button"
                        className="add-btn taobao-btn"
                        onClick={(e) => (!taobaoEnabled && !goofishEnabled) ? alert('CN Watch Disabled: Cookies missing for both sites') : addCNWatch()}
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
                                {Object.values(newCounts).reduce((a, b) => a + b, 0) > 0 && (
                                    <button className="merge-btn" style={{ marginLeft: '5px', backgroundColor: '#4a90e2' }} onClick={handleMarkAllSeen}>
                                        ✓ Mark All Seen
                                    </button>
                                )}
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
                        {(() => {
                            // Sort logic...
                            const sortedWatchlist = [...watchlist].sort((a, b) => {
                                const countA = newCounts[a.id] || 0;
                                const countB = newCounts[b.id] || 0;
                                if (countA > 0 && countB === 0) return -1;
                                if (countA === 0 && countB > 0) return 1;
                                return 0;
                            });

                            return sortedWatchlist.map(item => (
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
                                        <span className="watch-meta">Last Searched: {item.lastRun ? new Date(item.lastRun).toLocaleString() : 'Pending'}</span>
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
                                            style={{ marginRight: '5px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.2em' }}
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
                            ));
                        })()}
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
                                    {['mercari', 'yahoo', 'paypay', 'fril', 'surugaya', 'taobao', 'goofish'].map(site => {
                                        const isGloballyEnabled = globalSettings.enabledSites?.[site] !== false;
                                        // Special case for Taobao/Goofish: disable if globally OFF
                                        const isDisabled = (site === 'taobao' || site === 'goofish') && !isGloballyEnabled;

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
                                                {site.charAt(0).toUpperCase() + site.slice(1)}
                                            </label>
                                        );
                                    })}
                                </div>
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
                            <h3>Stored Results for "{selectedTerm}" <span style={{ fontSize: '0.8em', color: '#888', marginLeft: '10px' }}>({selectedResults ? selectedResults.filter(r => !r.hidden).length : 0} results)</span></h3>
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
                                    onChange={(e) => setSourceFilter(e.target.value)}
                                    className="search-input" // Reusing search-input style for consistency
                                    style={{ maxWidth: '200px', fontSize: '0.9rem', marginBottom: '1rem', padding: '0.5rem' }}
                                >
                                    <option value="All">All Websites</option>
                                    {[...new Set(selectedResults.filter(item => !item.hidden).map(item => item.source))].sort().map(source => (
                                        <option key={source} value={source}>{source}</option>
                                    ))}
                                </select>

                                {(resultFilter || sourceFilter !== 'All') && (
                                    <button
                                        className="clear-filter-btn"
                                        onClick={() => { setResultFilter(''); setSourceFilter('All'); }}
                                        style={{ marginLeft: '10px' }}
                                    >
                                        ✕ Clear
                                    </button>
                                )}
                                <select
                                    value={sortBy}
                                    onChange={(e) => setSortBy(e.target.value)}
                                    className="search-input"
                                    style={{ maxWidth: '180px', fontSize: '0.9rem', marginBottom: '1rem', padding: '0.5rem', marginLeft: '10px' }}
                                >
                                    <option value="time">Sort: Time Scraped</option>
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

                                    const safePage = Math.min(currentPage, Math.max(1, totalPages));

                                    return filteredAndSortedResults
                                        .slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE)
                                        .map((item, idx) => (
                                            <ResultCard key={idx} item={item} onBlock={handleLocalBlock} isNew={item.isNew} />
                                        ));
                                })()}
                            </div>

                            {/* Pagination */}
                            {filteredAndSortedResults.length > ITEMS_PER_PAGE && (
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

                                    <button
                                        className="page-btn"
                                        onClick={() => exportToHtml(
                                            filteredAndSortedResults,
                                            selectedTerm || 'watchlist_results'
                                        )}
                                        style={{ marginLeft: 'auto', backgroundColor: '#333', border: '1px solid #555' }}
                                    >
                                        📥 Export HTML
                                    </button>
                                </div>
                            )}

                            {/* Export Button (shown when no pagination) */}
                            {filteredAndSortedResults.length > 0 && totalPages <= 1 && (
                                <div style={{ textAlign: 'right', marginTop: '1rem' }}>
                                    <button
                                        className="page-btn"
                                        onClick={() => exportToHtml(
                                            filteredAndSortedResults,
                                            selectedTerm || 'watchlist_results'
                                        )}
                                        style={{ backgroundColor: '#333', border: '1px solid #555' }}
                                    >
                                        📥 Export HTML ({filteredAndSortedResults.length} items)
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
