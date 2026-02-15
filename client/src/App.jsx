import React, { useState, useEffect } from 'react';
import ResultCard from './components/ResultCard';
import WatchlistManager from './components/WatchlistManager';
import BlockedManager from './components/BlockedManager';
import OptionsManager from './components/OptionsManager';
import Clock from './components/Clock';

const MAX_HISTORY = 10;

function App() {
  const [view, setView] = useState('watchlist'); // 'search', 'watchlist', 'blocked', 'options'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [error, setError] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);
  const [executedQuery, setExecutedQuery] = useState('');

  const [currentPage, setCurrentPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState('All');
  const [resultFilter, setResultFilter] = useState('');
  const [sortBy, setSortBy] = useState('time'); // 'time', 'name', 'priceHigh', 'priceLow'
  const ITEMS_PER_PAGE = 24;

  // Login protection state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [taobaoEnabled, setTaobaoEnabled] = useState(false);
  const [goofishEnabled, setGoofishEnabled] = useState(false);
  const [strictMode, setStrictMode] = useState(true);

  // Check if login is required on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth-status');
        const data = await res.json();
        if (data.loginRequired) {
          // Check if already authenticated in session
          const token = sessionStorage.getItem('gkwatch_token');
          if (token) {
            setIsAuthenticated(true);
          } else {
            setLoginRequired(true);
          }
        } else {
          setIsAuthenticated(true);
        }

        // Check Taobao status
        const tbRes = await fetch('/api/taobao/status', { headers: getAuthHeaders() });
        if (tbRes.ok) {
          const tbData = await tbRes.json();
          setTaobaoEnabled(tbData.hasCookies);
        }

        // Check Goofish status
        const gfRes = await fetch('/api/goofish/status', { headers: getAuthHeaders() });
        if (gfRes.ok) {
          const gfData = await gfRes.json();
          setGoofishEnabled(gfData.hasCookies);
        }

      } catch (err) {
        console.error('Error checking auth/status:', err);
        setIsAuthenticated(true); // Allow access if can't check
      }
      setCheckingAuth(false);
    };
    checkAuth();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword })
      });
      const data = await res.json();

      if (data.success && data.token) {
        setIsAuthenticated(true);
        setLoginRequired(false);
        setLoginError('');
        sessionStorage.setItem('gkwatch_token', data.token); // Store token instead of boolean
      } else {
        setLoginError(data.error || 'Incorrect password');
      }
    } catch (err) {
      setLoginError('Error logging in');
    }
  };

  const getAuthHeaders = () => {
    const token = sessionStorage.getItem('gkwatch_token');
    return token ? { 'x-auth-token': token } : {};
  };

  const authenticatedFetch = async (url, options = {}) => {
    const headers = { ...options.headers, ...getAuthHeaders() };

    // Default to 300s (5 min) timeout if not provided
    let signal = options.signal;
    let controller = null;
    if (!signal) {
      controller = new AbortController();
      setTimeout(() => controller.abort(), 300000);
      signal = controller.signal;
    }

    const res = await fetch(url, { ...options, headers, signal });
    if (res.status === 401) {
      setIsAuthenticated(false);
      setLoginRequired(true);
      sessionStorage.removeItem('gkwatch_token');
      throw new Error('Unauthorized');
    }
    return res;
  };

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [sourceFilter, sortBy, resultFilter]);

  // Load search history from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('gkwatch_search_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setSearchHistory(parsed);
        } else {
          console.error('Search history corrupted, resetting');
          localStorage.removeItem('gkwatch_search_history');
          setSearchHistory([]);
        }
      } catch (e) {
        console.error('Failed to load search history');
        setSearchHistory([]);
      }
    }
  }, []);

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
      } catch (err) {
        alert('Failed to copy to clipboard');
      }
      document.body.removeChild(textArea);
    }
  };

  // Export results to HTML file with 5-column grid
  const exportToHtml = (items, filename) => {
    // Generate HTML content
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>GK Watch Export - ${filename}</title>
      <style>
        body { font-family: sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f0f2f5; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
        .card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.1); display: flex; flex-direction: column; }
        .img-container { height: 200px; overflow: hidden; position: relative; }
        .img-container img { width: 100%; height: 100%; object-fit: cover; }
        .content { padding: 15px; flex: 1; display: flex; flex-direction: column; }
        h3 { margin: 0 0 10px; font-size: 1rem; line-height: 1.4; color: #333; }
        .price { font-weight: bold; font-size: 1.2rem; color: #e53935; margin-bottom: 10px; }
        .source { font-size: 0.8rem; color: #666; margin-top: auto; display: flex; justify-content: space-between; align-items: center; }
        a { text-decoration: none; color: inherit; }
        .blocked { opacity: 0.6; filter: grayscale(100%); }
        .badge { background: #333; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; }
      </style>
    </head>
    <body>
      <h1>Search Results: ${filename}</h1>
      <p>Exported on ${new Date().toLocaleString()} - ${items.length} items</p>
      <div class="grid">
        ${items.map(item => `
          <div class="card">
            <a href="${item.link}" target="_blank">
              <div class="img-container">
                <img src="${item.image}" alt="${item.title.replace(/"/g, '&quot;')}" loading="lazy">
              </div>
              <div class="content">
                <h3>${item.title}</h3>
                <div class="price">${item.price}</div>
                <div class="source">
                  <span>${item.source}</span>
                  ${item.isNew ? '<span class="badge">NEW</span>' : ''}
                </div>
              </div>
            </a>
          </div>
        `).join('')}
      </div>
    </body>
    </html>
    `;

    // Create download link
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    a.download = `${safeFilename} - ${dateStr} ${timeStr}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleBlock = async (item) => {
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
  };

  // Explicitly define standard sites to exclude CN ones
  const STANDARD_SITES = ['mercari', 'yahoo', 'paypay', 'fril', 'surugaya'];

  const [siteErrors, setSiteErrors] = useState([]);

  // Helper to separate errors from valid results
  const processResults = (rawResults) => {
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
  };

  const fetchStream = async (url) => {
    const response = await authenticatedFetch(url, {
      headers: { 'Accept': 'text/event-stream' }
    });

    if (!response.ok) throw new Error('Network response was not ok');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
                const cleanData = processResults(data.items);
                setResults(prev => {
                  // Simple deduplication logic
                  const existingLinks = new Set(prev.map(i => i.link));
                  const newItems = cleanData.filter(i => !existingLinks.has(i.link));
                  return [...prev, ...newItems];
                });
              }

              // Only increment completion if this is the FINAL result packet for this scraper
              if (data.partial === false) {
                setProgress(prev => ({
                  ...prev,
                  completed: prev.completed + 1,
                  current: `${data.source} Finished`
                }));
              } else {
                // Update current status without incrementing count
                setProgress(prev => ({
                  ...prev,
                  current: `${data.source} (Found ${data.items.length} items...)`
                }));
              }
            } else if (data.type === 'error') {
              console.error(`Scraper error from ${data.source}: ${data.error}`);
              setProgress(prev => ({
                ...prev,
                completed: prev.completed + 1,
                current: `${data.source} Failed`
              }));
            } else if (data.type === 'done') {
              // Stream complete
            }
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    }
  };

  const search = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const searchTerm = overrideQuery || query;
    if (!searchTerm.trim()) return;

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
        const terms = searchTerm.split(/\s*\|\s*/).filter(t => t.trim());
        const promises = terms.map(term =>
          fetchStream(`/api/search?q=${encodeURIComponent(term.trim())}${sitesParam}`)
            .catch(err => console.error(`Error searching ${term}:`, err))
        );
        await Promise.all(promises);
      } else {
        // Single search
        await fetchStream(`/api/search?q=${encodeURIComponent(searchTerm)}${sitesParam}`);
      }
    } catch (err) {
      setError('Failed to fetch results. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const searchGK = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const queryTerm = overrideQuery || query;
    if (!queryTerm.trim()) return;

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

    // Force strict for GK searches
    const sitesParam = `&sites=${STANDARD_SITES.join(',')}&strict=${strictMode}`;

    try {
      // Run searches in parallel
      const promises = terms.map(term =>
        fetchStream(`/api/search?q=${encodeURIComponent(term)}${sitesParam}`)
          .catch(err => console.error(`Error searching ${term}:`, err))
      );
      await Promise.all(promises);
    } catch (err) {
      setError('Failed to fetch GK results. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const searchCN = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const queryTerm = overrideQuery || query;
    if (!queryTerm.trim()) return;

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
        setLoading(false);
        return;
      }

      await fetchStream(`/api/search?q=${encodeURIComponent(queryTerm)}&sites=${sites.join(',')}&strict=${strictMode}`);
    } catch (err) {
      setError('Failed to fetch CN results.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

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
          <h1>🔐 GK Watcher</h1>
          <p>Enter password to access</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Password"
              className="login-input"
              autoFocus
            />
            <button type="submit" className="login-btn">Login</button>
          </form>
          {loginError && <p className="login-error">{loginError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <nav className="main-nav">
        <button
          className={view === 'search' ? 'active' : ''}
          onClick={() => setView('search')}
        >
          Live Search
        </button>
        <button
          className={view === 'watchlist' ? 'active' : ''}
          onClick={() => setView('watchlist')}
        >
          Watchlist
        </button>
        <button
          className={view === 'blocked' ? 'active' : ''}
          onClick={() => setView('blocked')}
        >
          Blocked Items
        </button>
        <button
          className={view === 'options' ? 'active' : ''}
          onClick={() => setView('options')}
        >
          ⚙️ Options
        </button>
        <Clock />
      </nav>

      {view === 'search' && (
        <>
          <div className="search-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '2rem', marginTop: '1rem' }}>
            <form onSubmit={search} style={{ display: 'flex', gap: '10px', alignItems: 'center', width: '100%', maxWidth: '800px' }}>
              <input
                type="text"
                className="search-input"
                placeholder="Search for resin crack..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.9rem', cursor: 'pointer', whiteSpace: 'nowrap', color: '#ccc', marginRight: '5px' }} title="Enable Strict Filtering (Exact Match)">
                <input
                  type="checkbox"
                  checked={strictMode}
                  onChange={e => setStrictMode(e.target.checked)}
                  style={{ marginRight: '5px' }}
                />
                Strict
              </label>
              <button type="submit" className="add-btn">
                <span className="desktop-label">Search</span>
                <span className="mobile-label">🔍</span>
              </button>
              <button
                type="button"
                className="add-btn gk-btn"
                onClick={searchGK}
                title="Search for Garage Kit, Resin Kit, and Resin Cast Kit"
              >
                <span className="desktop-label">Search GK</span>
                <span className="mobile-label">GK</span>
              </button>
              <button
                type="button"
                className="add-btn taobao-btn"
                onClick={(e) => (!taobaoEnabled && !goofishEnabled) ? alert('CN Search Disabled: Cookies missing for both sites (check Options)') : searchCN(e, null)}
                title={(!taobaoEnabled && !goofishEnabled) ? "CN Search Disabled (Cookies Missing)" : "Search Taobao & Goofish"}
                disabled={!taobaoEnabled && !goofishEnabled}
                style={{
                  backgroundColor: (!taobaoEnabled && !goofishEnabled) ? '#555' : '#ff5000',
                  marginLeft: '5px',
                  cursor: (!taobaoEnabled && !goofishEnabled) ? 'not-allowed' : 'pointer',
                  opacity: (!taobaoEnabled && !goofishEnabled) ? 0.6 : 1
                }}
              >
                <span className="desktop-label">Search CN</span>
                <span className="mobile-label">CN</span>
              </button>
            </form>
            {/* Discreet Site Error Message */}
            {siteErrors.length > 0 && (
              <div style={{
                marginTop: '10px',
                padding: '8px 16px',
                backgroundColor: 'rgba(211, 47, 47, 0.1)',
                border: '1px solid #ef5350',
                borderRadius: '8px',
                color: '#ef5350',
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <span>
                  ⚠️ <strong>Search Incomplete:</strong>{' '}
                  {siteErrors.map((err, i) => (
                    <span key={err.source}>
                      <strong>{err.source}</strong> ({err.error})
                      {i < siteErrors.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {/* Progress Bar */}
            {loading && progress.total > 0 && (
              <div style={{ width: '100%', maxWidth: '800px', marginBottom: '1rem', marginTop: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px', fontSize: '0.9rem', color: '#666' }}>
                  <span>Creating Resin Dust... {progress.current ? `(${progress.current})` : ''}</span>
                  <span>{Math.round((progress.completed / progress.total) * 100)}%</span>
                </div>
                <div style={{ width: '100%', height: '8px', backgroundColor: '#e0e0e0', borderRadius: '4px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(progress.completed / progress.total) * 100}%`,
                      height: '100%',
                      backgroundColor: '#ff5000',
                      transition: 'width 0.3s ease'
                    }}
                  />
                </div>
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

          {loading && <div className="loading">Searching...</div>}

          {error && <div className="error">{error}</div>}

          {/* Results Count & Source Filter */}
          {
            results.length > 0 && (
              <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontWeight: '500', color: '#888' }}>
                  {results.length} result{results.length !== 1 ? 's' : ''} found
                </span>
                <span style={{ color: '#555' }}>|</span>

                <input
                  type="text"
                  placeholder="Filter by title..."
                  value={resultFilter}
                  onChange={(e) => { setResultFilter(e.target.value); setCurrentPage(1); }}
                  className="search-input"
                  style={{ maxWidth: '250px', fontSize: '0.9rem', padding: '0.5rem' }}
                />

                {resultFilter && (
                  <button
                    className="clear-filter-btn"
                    onClick={() => { setResultFilter(''); setCurrentPage(1); }}
                    style={{ marginRight: '5px' }}
                  >
                    ✕
                  </button>
                )}

                <span style={{ color: '#555' }}>|</span>
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="search-input"
                  style={{ maxWidth: '200px', fontSize: '0.9rem', padding: '0.5rem' }}
                >
                  <option value="All">All Websites</option>
                  {[...new Set(results.map(item => item.source))].sort().map(source => (
                    <option key={source} value={source}>{source}</option>
                  ))}
                </select>
                {sourceFilter !== 'All' && (
                  <button
                    className="clear-filter-btn"
                    onClick={() => setSourceFilter('All')}
                  >
                    ✕ Clear
                  </button>
                )}
                <span style={{ color: '#555' }}>|</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="search-input"
                  style={{ maxWidth: '180px', fontSize: '0.9rem', padding: '0.5rem' }}
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
            (() => {
              // Parse price string to number for sorting
              const parsePrice = (priceStr) => {
                if (!priceStr) return 0;
                const match = priceStr.replace(/,/g, '').match(/[\d.]+/);
                return match ? parseFloat(match[0]) : 0;
              };

              let filteredResults = results.filter(item => {
                if (resultFilter && !item.title.toLowerCase().includes(resultFilter.toLowerCase())) return false;
                if (sourceFilter !== 'All' && item.source !== sourceFilter) return false;
                return true;
              });

              // Apply sorting
              if (sortBy === 'name') {
                filteredResults = [...filteredResults].sort((a, b) =>
                  (a.title || '').localeCompare(b.title || '', 'ja')
                );
              } else if (sortBy === 'relevance') {
                const keywords = executedQuery.toLowerCase().split(/\s+/).filter(k => k);
                const countMatches = (title) => {
                  if (!title) return 0;
                  const lowerTitle = title.toLowerCase();
                  return keywords.reduce((acc, k) => acc + (lowerTitle.includes(k) ? 1 : 0), 0);
                };
                filteredResults = [...filteredResults].sort((a, b) => countMatches(b.title) - countMatches(a.title));
              } else if (sortBy === 'priceHigh') {
                filteredResults = [...filteredResults].sort((a, b) =>
                  parsePrice(b.price) - parsePrice(a.price)
                );
              } else if (sortBy === 'priceLow') {
                filteredResults = [...filteredResults].sort((a, b) =>
                  parsePrice(a.price) - parsePrice(b.price)
                );
              }
              // 'time' is default order from server

              const totalPages = Math.ceil(filteredResults.length / ITEMS_PER_PAGE);
              const safePage = Math.min(currentPage, Math.max(1, totalPages));

              return (
                <>
                  <div className="results-grid">
                    {filteredResults
                      .slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE)
                      .map((item, index) => (
                        <ResultCard key={`${item.source}-${index}`} item={item} onBlock={handleBlock} />
                      ))}
                  </div>

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
                          onClick={() => handleExportClipboard(filteredResults)}
                          style={{ backgroundColor: '#333', border: '1px solid #555' }}
                          title="Copy Name - Link to Clipboard"
                        >
                          📋 Copy
                        </button>
                        <button
                          className="page-btn"
                          onClick={() => exportToHtml(filteredResults, query || 'search_results')}
                          style={{ backgroundColor: '#333', border: '1px solid #555' }}
                        >
                          📥 HTML
                        </button>
                      </div>
                    </div>
                  )}
                </>
              );
            })()
          }

          {/* Export Button (shown when no pagination) */}
          {
            results.length > 0 && results.length <= ITEMS_PER_PAGE && (
              <div style={{ textAlign: 'right', marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '5px' }}>
                <button
                  className="page-btn"
                  onClick={() => handleExportClipboard(results)}
                  style={{ backgroundColor: '#333', border: '1px solid #555' }}
                  title="Copy Name - Link to Clipboard"
                >
                  📋 Copy ({results.length})
                </button>
                <button
                  className="page-btn"
                  onClick={() => exportToHtml(results, query || 'search_results')}
                  style={{ backgroundColor: '#333', border: '1px solid #555' }}
                >
                  📥 HTML ({results.length})
                </button>
              </div>
            )
          }

          {
            !loading && results.length === 0 && query && !error && (
              <p style={{ marginTop: '2rem', color: '#666' }}>No results found or search not started.</p>
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
    </div >
  );
}

export default App;
