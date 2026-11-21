import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ResultCard from './components/ResultCard';
import WatchlistManager from './components/WatchlistManager';
import BlockedManager from './components/BlockedManager';
import OptionsManager from './components/OptionsManager';
import Clock from './components/Clock';
import AsciiHeading from './components/AsciiHeading';
import { buildExportHtml, downloadExportHtml, makeExportFilename } from './utils/exportHelpers';

const MAX_HISTORY = 10;
const ITEMS_PER_PAGE = 24;
const VIEWS = {
  watchlist: 'Watchlist',
  search: 'Live Search',
  blocked: 'Lists',
  options: 'Options'
};

const loadSearchHistory = () => {
  if (typeof localStorage === 'undefined') return [];
  const historyValue = localStorage.getItem('gkwatch_search_history');
  if (!historyValue) return [];
  try {
    const parsed = JSON.parse(historyValue);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    console.error('Failed to load search history');
  }
  localStorage.removeItem('gkwatch_search_history');
  return [];
};

const parsePrice = (priceStr) => {
  if (!priceStr) return 0;
  const match = priceStr.replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
};

function App() {
  const [view, setView] = useState('watchlist'); // 'search', 'watchlist', 'blocked', 'options'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [error, setError] = useState(null);
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory);
  const [executedQuery, setExecutedQuery] = useState('');

  const [currentPage, setCurrentPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState('All');
  const [resultFilter, setResultFilter] = useState('');
  const [sortBy, setSortBy] = useState('time'); // 'time', 'name', 'priceHigh', 'priceLow'

  // Login protection state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [taobaoEnabled, setTaobaoEnabled] = useState(false);
  const [goofishEnabled, setGoofishEnabled] = useState(false);
  const [strictMode, setStrictMode] = useState(true);
  const inFlightSearchesRef = useRef(new Map());
  const liveSearchSeenLinksRef = useRef(new Set());
  const activeLiveSearchRef = useRef(null);
  const clearAuthSession = useCallback(() => {
    setIsAuthenticated(false);
    setLoginRequired(true);
  }, []);

  // Check if login is required on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth-status', { credentials: 'same-origin' });
        if (res.status === 401) {
          clearAuthSession();
          setCheckingAuth(false);
          return;
        }
        const data = await res.json().catch(() => ({}));
        const requiresAuth = data?.loginRequired === true && data?.authenticated !== true;

        if (requiresAuth) {
          setIsAuthenticated(false);
          setLoginRequired(true);
          setCheckingAuth(false);
          return;
        }
        setIsAuthenticated(true);
        setLoginRequired(false);

        // Check Taobao status
        const tbRes = await fetch('/api/taobao/status', { credentials: 'same-origin' });
        if (tbRes.status === 401) {
          clearAuthSession();
          setCheckingAuth(false);
          return;
        }
        if (tbRes.ok) {
          const tbData = await tbRes.json();
          setTaobaoEnabled(Boolean(tbData.hasCookies));
        }

        // Check Goofish status
        const gfRes = await fetch('/api/goofish/status', { credentials: 'same-origin' });
        if (gfRes.status === 401) {
          clearAuthSession();
          setCheckingAuth(false);
          return;
        }
        if (gfRes.ok) {
          const gfData = await gfRes.json();
          setGoofishEnabled(Boolean(gfData.hasCookies));
        }
      } catch (err) {
        console.error('Error checking auth/status:', err);
        clearAuthSession();
      }
      setCheckingAuth(false);
    };
    checkAuth();
  }, [clearAuthSession]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword })
      });
      const data = await res.json();

      if (res.ok && data?.success) {
        setIsAuthenticated(true);
        setLoginRequired(false);
        setLoginError('');
      } else {
        setLoginError(data?.error || 'Incorrect password');
      }
    } catch {
      setLoginError('Error logging in');
    }
  };

  const authenticatedFetch = useCallback(async (url, options = {}) => {
    const headers = options.headers;

    // Default to 300s (5 min) timeout if not provided
    let signal = options.signal;
    if (!signal) {
      signal = AbortSignal.timeout(300000);
    }

    const res = await fetch(url, { ...options, headers, signal, credentials: 'same-origin' });
    if (res.status === 401) {
      clearAuthSession();
      throw new Error('Unauthorized');
    }
    if (res.status === 403) {
      throw new Error('Forbidden');
    }
    return res;
  }, [clearAuthSession]);

  // Save search history to localStorage
  const saveToHistory = (term, type = 'normal') => {
    const trimmed = term.trim();
    if (!trimmed) return;

    setSearchHistory(prev => {
      // Normalize prev items to objects for comparison
      const normalize = (item) => typeof item === 'string' ? { term: item, type: 'normal' } : item;

      const filtered = prev.filter(h => normalize(h).term.toLowerCase() !== trimmed.toLowerCase());

      const newItem = { term: trimmed, type };
      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);

      localStorage.setItem('gkwatch_search_history', JSON.stringify(updated));
      return updated;
    });
  };

  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('gkwatch_search_history');
  };

  // Export results to Clipboard (Name - Price - Link)
  const handleExportClipboard = async (items) => {
    if (!items || items.length === 0) return;

    const text = items.map(item => {
      const price = item.price && item.price !== 'N/A' ? ` - ${item.price}` : '';
      return `${item.title}${price}\n${item.link}\n`;
    }).join('\n');

      try {
        await navigator.clipboard.writeText(text);
        alert(`Copied ${items.length} items to clipboard!`);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      // Fallback for non-secure contexts (though this app is usually secure)
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        alert(`Copied ${items.length} items to clipboard!`);
      } catch {
        alert('Failed to copy to clipboard');
      }
      document.body.removeChild(textArea);
    }
  };

  // Export results to HTML file with secure templating
  const exportToHtml = (items, filename) => {
    const safeName = makeExportFilename(filename || 'search_results');
    const htmlContent = buildExportHtml({
      heading: `Search Results: ${filename || 'search_results'}`,
      items,
      variant: 'light',
      subtitle: `Exported on ${new Date().toLocaleString()} - ${items.length} items`
    });
    downloadExportHtml({ filename: safeName, html: htmlContent });
  };

  const handleBlock = useCallback(async (item) => {
    try {
      await authenticatedFetch('/api/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.link, title: item.title, image: item.image })
      });
      // Remove from local results
      setResults(prev => prev.filter(r => r.link !== item.link));
    } catch (err) {
      console.error('Failed to block item:', err);
    }
  }, [authenticatedFetch]);

  const handleFavoriteToggle = useCallback(async (item) => {
    try {
      const res = await authenticatedFetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: item.link || item.url,
          title: item.title,
          image: item.image,
          price: item.price,
          bidPrice: item.bidPrice,
          binPrice: item.binPrice,
          source: item.source
        })
      });
      const data = await res.json();
      const isFavorite = !!data.favorite;
      const itemUrl = item.link || item.url;
      setResults(prev => prev.map(result =>
        result.link === itemUrl ? { ...result, isFavorite } : result
      ));
      return isFavorite;
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      return undefined;
    }
  }, [authenticatedFetch]);

  // Explicitly define standard sites to exclude CN ones
  const STANDARD_SITES = ['mercari', 'yahoo', 'paypay', 'fril', 'surugaya', 'mandarake'];

  const [siteErrors, setSiteErrors] = useState([]);

  // Helper to separate errors from valid results
  const processResults = useCallback((rawResults) => {
    if (!Array.isArray(rawResults)) return [];

    // Find errors (any item with an 'error' property)
    const errors = rawResults.filter(item => item.error);
    const validItems = rawResults.filter(item => !item.error);

    if (errors.length > 0) {
      setSiteErrors(prev => {
        // Create map of Source -> Error Message
        const newErrors = errors.map(e => ({ source: e.source || 'Unknown', error: e.error }));

        // Merge with previous errors, preferring newer ones
        const combined = [...prev, ...newErrors];

        // Deduplicate by source (keep latest)
        const uniqueMap = new Map();
        combined.forEach(err => uniqueMap.set(err.source, err.error));

        return Array.from(uniqueMap.entries()).map(([source, error]) => ({ source, error }));
      });
    }

    return validItems;
  }, []);

  const fetchStream = useCallback(async (url, options = {}) => {
    const response = await authenticatedFetch(url, {
      headers: { 'Accept': 'text/event-stream' },
      ...options
    });

    if (!response.ok) throw new Error('Network response was not ok');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingItems = [];
    let flushTimer = null;

    const flushPendingItems = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (options.signal?.aborted) {
        pendingItems = [];
        return;
      }
      if (pendingItems.length === 0) return;

      const batch = pendingItems;
      pendingItems = [];
      const seenLinks = liveSearchSeenLinksRef.current;
      const uniqueItems = batch.filter(item => {
        if (!item.link || seenLinks.has(item.link)) return false;
        seenLinks.add(item.link);
        return true;
      });
      if (uniqueItems.length > 0) setResults(previous => [...previous, ...uniqueItems]);
    };

    const queueItems = (items) => {
      pendingItems.push(...items);
      if (!flushTimer) flushTimer = setTimeout(flushPendingItems, 150);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep the last partial line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'start') {
                setProgress(prev => ({ ...prev, total: data.totalScrapers, current: data.source }));
              } else if (data.type === 'result') {
                if (data.items && data.items.length > 0) {
                  queueItems(processResults(data.items));
                }

                // Only increment completion if this is the FINAL result packet for this scraper
                if (data.partial === false) {
                  setProgress(prev => ({
                    ...prev,
                    completed: prev.completed + 1,
                    current: `${data.source} Finished`
                  }));
                } else {
                  setProgress(prev => ({
                    ...prev,
                    current: `${data.source} (Found ${data.items.length} items...)`
                  }));
                }
              } else if (data.type === 'error') {
                if (!options.signal?.aborted) {
                  setSiteErrors(previous => [...previous, { source: data.source, error: data.error }]);
                }
                setProgress(prev => ({
                  ...prev,
                  completed: prev.completed + 1,
                  current: `${data.source} Failed`
                }));
              } else if (data.type === 'done') {
                flushPendingItems();
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }
    } finally {
      if (options.signal?.aborted) {
        if (flushTimer) clearTimeout(flushTimer);
        pendingItems = [];
      } else {
        flushPendingItems();
      }
    }
  }, [authenticatedFetch, processResults]);

  const getSearchRequestKey = useCallback((term, sitesParam) => `${term.toLowerCase()}|${sitesParam}`, []);

  const runSearch = useCallback(async (term, sitesParam, signal) => {
    const trimmedTerm = String(term || '').trim();
    if (!trimmedTerm) return;
    const key = getSearchRequestKey(trimmedTerm, sitesParam);

    if (inFlightSearchesRef.current.has(key)) {
      return inFlightSearchesRef.current.get(key);
    }

    const searchPromise = fetchStream(`/api/search?q=${encodeURIComponent(trimmedTerm)}${sitesParam}`, { signal })
      .catch((err) => {
        if (!signal.aborted && err?.name !== 'AbortError') {
          setSiteErrors(previous => [...previous, { source: trimmedTerm, error: err.message }]);
        }
      })
      .finally(() => {
        if (inFlightSearchesRef.current.get(key) === searchPromise) {
          inFlightSearchesRef.current.delete(key);
        }
      });

    inFlightSearchesRef.current.set(key, searchPromise);
    return searchPromise;
  }, [fetchStream, getSearchRequestKey]);

  const runSearchBatch = useCallback(async (requests, signal, maxConcurrent = 2) => {
    const queue = [...requests];
    const workerCount = Math.min(maxConcurrent, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (queue.length > 0 && !signal.aborted) {
        const request = queue.shift();
        if (request) await runSearch(request.term, request.sitesParam, signal);
      }
    }));
  }, [runSearch]);

  const beginLiveSearch = () => {
    activeLiveSearchRef.current?.abort();
    inFlightSearchesRef.current.clear();
    const controller = new AbortController();
    activeLiveSearchRef.current = controller;
    liveSearchSeenLinksRef.current = new Set();
    return controller;
  };

  useEffect(() => () => activeLiveSearchRef.current?.abort(), []);

  const search = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const searchTerm = overrideQuery || query;
    if (!searchTerm.trim()) return;
    const searchController = beginLiveSearch();

    setLoading(true);
    setError(null);
    setResults([]);
    setCurrentPage(1); // Reset page on new search
    setResultFilter(''); // Reset filter
    setSiteErrors([]); // Clear previous errors
    setProgress({ completed: 0, total: 0, current: 'Initializing...' });

    // Save to history
    saveToHistory(searchTerm, 'normal');
    if (overrideQuery) setQuery(overrideQuery);
    setExecutedQuery(searchTerm);
    try {
      // Check if query contains | operator for multi-search
      const hasOrOperator = searchTerm.includes('|');
      const sitesParam = `&sites=${STANDARD_SITES.join(',')}&strict=${strictMode}`;

      if (hasOrOperator) {
        // Split by | and run parallel searches
        const terms = Array.from(new Set(searchTerm.split(/\s*\|\s*/).map((term) => term.trim()).filter(Boolean)));
        await runSearchBatch(terms.map(term => ({ term, sitesParam })), searchController.signal);
      } else {
        // Single search
        await runSearch(searchTerm, sitesParam, searchController.signal);
      }
    } catch (err) {
      setError('Failed to fetch results. Please try again.');
      console.error(err);
    } finally {
      if (activeLiveSearchRef.current === searchController) {
        activeLiveSearchRef.current = null;
        setLoading(false);
      }
    }
  };

  const searchGK = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const queryTerm = overrideQuery || query;
    if (!queryTerm.trim()) return;
    const searchController = beginLiveSearch();

    setLoading(true);
    setError(null);
    setResults([]);
    setCurrentPage(1); // Reset page on new search
    setResultFilter(''); // Reset filter
    setSiteErrors([]);
    setProgress({ completed: 0, total: 0, current: 'Initializing GK Search...' });

    if (overrideQuery) setQuery(overrideQuery);
    setExecutedQuery(queryTerm);

    // Save to history (save the base term)
    saveToHistory(queryTerm, 'gk');

    const terms = [
      `${queryTerm} ガレージキット`,
      `${queryTerm} レジンキット`,
      `${queryTerm} レジンキャストキット`
    ];

    // Force strict for GK searches. Mandarake can use its own garage-kit category,
    // so it searches the base query once instead of the suffix variants.
    const suffixSites = STANDARD_SITES.filter(site => site !== 'mandarake');
    const sitesParam = `&sites=${suffixSites.join(',')}&strict=${strictMode}`;

    try {
      // Run searches in parallel
      const uniqueTerms = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean)));
      await runSearchBatch([
        ...uniqueTerms.map(term => ({ term, sitesParam })),
        { term: queryTerm, sitesParam: `&sites=mandarake&strict=${strictMode}&mandarakeMode=garageKit` }
      ], searchController.signal);
    } catch (err) {
      setError('Failed to fetch GK results. Please try again.');
      console.error(err);
    } finally {
      if (activeLiveSearchRef.current === searchController) {
        activeLiveSearchRef.current = null;
        setLoading(false);
      }
    }
  };

  const searchCN = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const queryTerm = overrideQuery || query;
    if (!queryTerm.trim()) return;
    const searchController = beginLiveSearch();

    setLoading(true);
    setError(null);
    setResults([]);
    setCurrentPage(1);
    setResultFilter(''); // Reset filter
    setSiteErrors([]);
    setProgress({ completed: 0, total: 0, current: 'Initializing CN Search...' });

    if (overrideQuery) setQuery(overrideQuery);
    setExecutedQuery(queryTerm);
    saveToHistory(queryTerm, 'cn'); // 'cn' for both

    try {
      // Build sites parameter
      const sites = [];
      if (taobaoEnabled) sites.push('taobao');
      if (goofishEnabled) sites.push('goofish');

      if (sites.length === 0) {
        setError('No CN sites enabled or cookies missing.');
        activeLiveSearchRef.current = null;
        setLoading(false);
        return;
      }

      await runSearch(queryTerm, `&sites=${sites.join(',')}&strict=${strictMode}`, searchController.signal);
    } catch (err) {
      setError('Failed to fetch CN results.');
      console.error(err);
    } finally {
      if (activeLiveSearchRef.current === searchController) {
        activeLiveSearchRef.current = null;
        setLoading(false);
      }
    }
  };

  const liveSources = useMemo(
    () => [...new Set(results.map(item => item.source).filter(Boolean))].sort(),
    [results]
  );

  const filteredResults = useMemo(() => {
    const normalizedFilter = resultFilter.toLowerCase();
    let nextResults = results.filter(item => {
      if (normalizedFilter && !(item.title || '').toLowerCase().includes(normalizedFilter)) return false;
      return sourceFilter === 'All' || item.source === sourceFilter;
    });

    if (sortBy === 'name') {
      nextResults = [...nextResults].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', 'ja')
      );
    } else if (sortBy === 'relevance') {
      const keywords = executedQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const countMatches = (title) => {
        const lowerTitle = (title || '').toLowerCase();
        return keywords.reduce((count, keyword) => count + Number(lowerTitle.includes(keyword)), 0);
      };
      nextResults = [...nextResults].sort((a, b) => countMatches(b.title) - countMatches(a.title));
    } else if (sortBy === 'priceHigh') {
      nextResults = [...nextResults].sort((a, b) => parsePrice(b.price) - parsePrice(a.price));
    } else if (sortBy === 'priceLow') {
      nextResults = [...nextResults].sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
    }

    return nextResults;
  }, [results, resultFilter, sourceFilter, sortBy, executedQuery]);

  const liveTotalPages = Math.ceil(filteredResults.length / ITEMS_PER_PAGE);
  const liveSafePage = Math.min(currentPage, Math.max(1, liveTotalPages));
  const visibleLiveResults = useMemo(
    () => filteredResults.slice((liveSafePage - 1) * ITEMS_PER_PAGE, liveSafePage * ITEMS_PER_PAGE),
    [filteredResults, liveSafePage]
  );

  // Show loading while checking auth
  if (checkingAuth) {
    return (
      <div className="App login-screen">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  // Show login screen if required
  if (loginRequired && !isAuthenticated) {
    return (
      <div className="App login-screen">
        <div className="login-container">
          <img src="/mamizou.svg" alt="" width="56" height="56" />
          <AsciiHeading label="GK Watcher" />
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              className="login-input"
              autoFocus
            />
            <button type="submit" className="login-btn">Login</button>
          </form>
          {loginError && <p className="login-error" role="alert">{loginError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="desktop-bar">
        <div className="desktop-bar-inner">
          <div className="wordmark">
            <img src="/mamizou.svg" alt="" width="36" height="36" />
            <span>GK Watcher</span>
          </div>
          <nav className="main-nav" aria-label="Main navigation"
            style={{ '--workspace-index': Object.keys(VIEWS).indexOf(view) }}
          >
            {Object.entries(VIEWS).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={view === id ? 'page' : undefined}
                className={view === id ? 'active' : ''}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <Clock authenticatedFetch={authenticatedFetch} />
        </div>
      </header>
      <main className="workspace">
        <div className="workspace-heading" key={view}>
          <AsciiHeading label={VIEWS[view]} />
        </div>

        {view === 'search' && (
          <>
            <div className="search-container">
              <form onSubmit={search} className="add-watch-form">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search for resin crack..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search term"
                />
                <label className="watch-strict-toggle" title="Enable Strict Filtering (Exact Match)">
                  <input
                    type="checkbox"
                    checked={strictMode}
                    onChange={e => setStrictMode(e.target.checked)}
                  />
                  Strict
                </label>
                <button type="submit" className="add-btn">
                  Search
                </button>
                <button
                  type="button"
                  className="add-btn gk-btn"
                  onClick={searchGK}
                  title="Search for Garage Kit, Resin Kit, and Resin Cast Kit"
                >
                  Search GK
                </button>
                <button
                  type="button"
                  className="add-btn taobao-btn"
                  onClick={(e) => (!taobaoEnabled && !goofishEnabled) ? alert('CN Search Disabled: Cookies missing for both sites (check Options)') : searchCN(e, null)}
                  title={(!taobaoEnabled && !goofishEnabled) ? "CN Search Disabled (Cookies Missing)" : "Search Taobao & Goofish"}
                  disabled={!taobaoEnabled && !goofishEnabled}

                >
                  Search CN
                </button>
              </form>
              {siteErrors.length > 0 && (
                <div className="site-errors" role="status">
                  <strong>Search incomplete.</strong>{' '}
                  {siteErrors.map(({ source, error }) => `${source} (${error})`).join(', ')}
                </div>
              )}

              {loading && (
                <div className="search-progress" role="status">
                  <span>{progress.current || 'Searching…'}</span>
                  <progress aria-label="Search progress" max={progress.total || 1} value={progress.total > 0 ? progress.completed : undefined} />
                </div>
              )}
            </div>

            {/* Search History */}
            {
              searchHistory.length > 0 && (
                <div className="search-history">
                  <div className="search-history-header">
                    <span>Recent:</span>
                    <button className="clear-history-btn" onClick={clearHistory}>Clear</button>
                  </div>
                  <div className="search-history-chips">
                    {searchHistory.map((item, i) => {
                      // Handle legacy string items
                      const term = typeof item === 'string' ? item : item.term;
                      const type = typeof item === 'string' ? 'normal' : item.type;

                      return (
                        <button
                          key={i}
                          className={`history-chip ${type === 'gk' ? 'gk-history' : (type === 'taobao' || type === 'cn') ? 'taobao-history' : ''}`}
                          onClick={() => {
                            if (type === 'gk') searchGK(null, term);
                            else if (type === 'taobao') searchCN(null, term); // Legacy support
                            else if (type === 'cn') searchCN(null, term);
                            else search(null, term);
                          }}
                          title={type === 'gk' ? "Re-run GK Search" : (type === 'taobao' || type === 'cn') ? "Re-run CN Search" : "Re-run Search"}
                        >
                          {term}
                          {type === 'gk' && <span className="gk-badge">GK</span>}
                          {(type === 'taobao' || type === 'cn') && <span className="gk-badge taobao-badge-chip">CN</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )
            }

            {error && <div className="error" role="alert">{error}</div>}

            {/* Results Count & Source Filter */}
            {
              results.length > 0 && (
                <div className="results-filter live-results-filter">
                  <span className="result-count">
                    {results.length} result{results.length !== 1 ? 's' : ''} found
                  </span>

                  <input
                    type="text"
                    placeholder="Filter by title..."
                    aria-label="Filter results by title"
                    value={resultFilter}
                    onChange={(e) => { setResultFilter(e.target.value); setCurrentPage(1); }}
                    className="search-input"

                  />

                  {resultFilter && (
                    <button
                      className="clear-filter-btn"
                      aria-label="Clear title filter"
                      onClick={() => { setResultFilter(''); setCurrentPage(1); }}
                      >
                      ✕
                    </button>
                  )}

                  <select
                    aria-label="Filter by marketplace"
                    value={sourceFilter}
                    onChange={(e) => { setSourceFilter(e.target.value); setCurrentPage(1); }}
                    className="search-input"

                  >
                    <option value="All">All Websites</option>
                    {liveSources.map(source => (
                      <option key={source} value={source}>{source}</option>
                    ))}
                  </select>
                  {sourceFilter !== 'All' && (
                    <button
                      className="clear-filter-btn"
                      onClick={() => { setSourceFilter('All'); setCurrentPage(1); }}
                    >
                      ✕ Clear
                    </button>
                  )}
                  <select
                    aria-label="Sort results"
                    value={sortBy}
                    onChange={(e) => { setSortBy(e.target.value); setCurrentPage(1); }}
                    className="search-input"

                  >
                    <option value="time">Sort: Time Scraped</option>
                    <option value="relevance">Sort: Relevance</option>
                    <option value="name">Sort: Name</option>
                    <option value="priceHigh">Sort: Price High→Low</option>
                    <option value="priceLow">Sort: Price Low→High</option>
                  </select>
                </div>
              )
            }

            {
                  <>
                    <div className="results-grid">
                      {visibleLiveResults.map(item => (
                          <ResultCard
                            key={item.link || item.url}
                            item={item}
                            onBlock={handleBlock}
                            onFavoriteToggle={handleFavoriteToggle}
                          />
                        ))}
                    </div>
                    {results.length > 0 && filteredResults.length === 0 && (
                      <p className="empty-results-message">No results match your filters.</p>
                    )}

                    {/* Pagination Controls */}
                    {filteredResults.length > ITEMS_PER_PAGE && (
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
                            const end = Math.min(liveTotalPages, start + 4);
                            const adjustedStart = Math.max(1, Math.min(start, liveTotalPages - 4));

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
                            max={liveTotalPages}
                            placeholder="#"
                            aria-label="Jump to results page"
                            className="page-input"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const val = parseInt(e.target.value);
                                if (val >= 1 && val <= liveTotalPages) {
                                  setCurrentPage(val);
                                  e.target.value = '';
                                }
                              }
                            }}
                          />
                          <span className="total-pages">/ {liveTotalPages}</span>
                        </div>

                        <button
                          className="page-btn"
                          onClick={() => setCurrentPage(p => Math.min(liveTotalPages, p + 1))}
                          disabled={currentPage >= liveTotalPages}
                        >
                          Next →
                        </button>

                        <div className="export-actions">
                          <button
                            className="page-btn"
                            onClick={() => handleExportClipboard(filteredResults)}

                            title="Copy Name - Link to Clipboard"
                          >
                            Copy
                          </button>
                          <button
                            className="page-btn"
                            onClick={() => exportToHtml(filteredResults, query || 'search_results')}

                          >
                            Export HTML
                          </button>
                        </div>
                      </div>
                    )}
                  </>
            }

            {/* Export Button (shown when no pagination) */}
            {
              results.length > 0 && results.length <= ITEMS_PER_PAGE && (
                <div className="export-actions standalone">
                  <button
                    className="page-btn"
                    onClick={() => handleExportClipboard(results)}

                    title="Copy Name - Link to Clipboard"
                  >
                    Copy ({results.length})
                  </button>
                  <button
                    className="page-btn"
                    onClick={() => exportToHtml(results, query || 'search_results')}

                  >
                    Export HTML ({results.length})
                  </button>
                </div>
              )
            }

            {
              !loading && results.length === 0 && executedQuery && !error && siteErrors.length === 0 && (
                <p className="empty-results-message">{`No results for “${executedQuery}”.`}</p>
              )
            }
          </>
        )
        }

        {
          view === 'watchlist' && (
            <WatchlistManager
              authenticatedFetch={authenticatedFetch}
              onBlock={handleBlock}
              onFavoriteToggle={handleFavoriteToggle}
              taobaoEnabled={taobaoEnabled}
              goofishEnabled={goofishEnabled}
              handleExportClipboard={handleExportClipboard}
            />
          )
        }

        {
          view === 'blocked' && (
            <BlockedManager authenticatedFetch={authenticatedFetch} />
          )
        }

        {
          view === 'options' && (
            <OptionsManager authenticatedFetch={authenticatedFetch} />
          )
        }
      </main>
    </div>
  );
}

export default App;
