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
  const [error, setError] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);

  const [currentPage, setCurrentPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState('All');
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
    const res = await fetch(url, { ...options, headers });
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
  }, [sourceFilter, sortBy]);

  // Load search history from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('gkwatch_search_history');
    if (saved) {
      try {
        setSearchHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load search history');
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

  // Export results to HTML file with 5-column grid
  const exportToHtml = (items, filename = 'search_results') => {
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
        const uniqueMap = aMap = new Map();
        combined.forEach(err => uniqueMap.set(err.source, err.error));

        return Array.from(uniqueMap.entries()).map(([source, error]) => ({ source, error }));
      });
    }

    return validItems;
  };

  const search = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const searchTerm = overrideQuery || query;
    if (!searchTerm.trim()) return;

    setLoading(true);
    setError(null);
    setResults([]);
    setCurrentPage(1); // Reset page on new search
    setSiteErrors([]); // Clear previous errors

    // Save to history
    saveToHistory(searchTerm, 'normal');
    if (overrideQuery) setQuery(overrideQuery);

    try {
      // Check if query contains | operator for multi-search
      const hasOrOperator = searchTerm.includes('|');
      const sitesParam = `&sites=${STANDARD_SITES.join(',')}`;

      if (hasOrOperator) {
        // Split by | and run parallel searches, similar to GK search
        const terms = searchTerm.split(/\s*\|\s*/).filter(t => t.trim());

        const promises = terms.map(term =>
          authenticatedFetch(`/api/search?q=${encodeURIComponent(term.trim())}${sitesParam}`)
            .then(res => res.json())
            .catch(err => {
              console.error(`Error searching ${term}:`, err);
              return [];
            })
        );

        const allResults = await Promise.all(promises);
        const flatResults = allResults.flat();

        // Process errors
        const cleanResults = processResults(flatResults);

        // Deduplicate by link
        const uniqueResults = [];
        const seenLinks = new Set();

        cleanResults.forEach(item => {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            uniqueResults.push(item);
          }
        });

        setResults(uniqueResults);
      } else {
        // Single search (original behavior)
        const response = await authenticatedFetch(`/api/search?q=${encodeURIComponent(searchTerm)}${sitesParam}`);
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        const data = await response.json();
        const cleanData = processResults(data);
        setResults(cleanData);
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
    setSiteErrors([]);

    if (overrideQuery) setQuery(overrideQuery);

    // Save to history (save the base term)
    saveToHistory(queryTerm, 'gk');

    const terms = [
      `${queryTerm} ガレージキット`,
      `${queryTerm} レジンキット`,
      `${queryTerm} レジンキャストキット`
    ];

    const sitesParam = `&sites=${STANDARD_SITES.join(',')}`;

    try {
      // Run searches in parallel
      const promises = terms.map(term =>
        authenticatedFetch(`/api/search?q=${encodeURIComponent(term)}${sitesParam}`)
          .then(res => res.json())
          .catch(err => {
            console.error(`Error searching ${term}:`, err);
            return [];
          })
      );

      const allResults = await Promise.all(promises);
      const flatResults = allResults.flat();

      const cleanResults = processResults(flatResults);

      // Deduplicate by link
      const uniqueResults = [];
      const seenLinks = new Set();

      cleanResults.forEach(item => {
        if (!seenLinks.has(item.link)) {
          seenLinks.add(item.link);
          uniqueResults.push(item);
        }
      });

      setResults(uniqueResults);
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
    setSiteErrors([]);

    if (overrideQuery) setQuery(overrideQuery);
    saveToHistory(queryTerm, 'cn'); // 'cn' for both

    try {
      // Build sites parameter
      const sites = [];
      if (taobaoEnabled) sites.push('taobao');
      if (goofishEnabled) sites.push('goofish');

      const response = await authenticatedFetch(`/api/search?q=${encodeURIComponent(queryTerm)}&sites=${sites.join(',')}`);
      if (!response.ok) throw new Error('Network response was not ok');
      const data = await response.json();
      const cleanData = processResults(data);
      setResults(cleanData);
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
              <button type="submit" className="add-btn">Search</button>
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
                style={{
                  backgroundColor: (!taobaoEnabled && !goofishEnabled) ? '#555' : '#ff5000',
                  marginLeft: '5px',
                  cursor: (!taobaoEnabled && !goofishEnabled) ? 'not-allowed' : 'pointer',
                  opacity: (!taobaoEnabled && !goofishEnabled) ? 0.6 : 1
                }}
              >
                Search CN
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
          </div>

          {/* Search History */}
          {searchHistory.length > 0 && (
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
          )}

          {loading && <div className="loading">Searching...</div>}

          {error && <div className="error">{error}</div>}

          {/* Results Count & Source Filter */}
          {results.length > 0 && (
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontWeight: '500', color: '#888' }}>
                {results.length} result{results.length !== 1 ? 's' : ''} found
              </span>
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
                <option value="name">Sort: Name</option>
                <option value="priceHigh">Sort: Price High→Low</option>
                <option value="priceLow">Sort: Price Low→High</option>
              </select>
            </div>
          )}

          {(() => {
            // Parse price string to number for sorting
            const parsePrice = (priceStr) => {
              if (!priceStr) return 0;
              const match = priceStr.replace(/,/g, '').match(/[\d.]+/);
              return match ? parseFloat(match[0]) : 0;
            };

            let filteredResults = sourceFilter === 'All'
              ? results
              : results.filter(item => item.source === sourceFilter);

            // Apply sorting
            if (sortBy === 'name') {
              filteredResults = [...filteredResults].sort((a, b) =>
                (a.title || '').localeCompare(b.title || '', 'ja')
              );
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

                    <button
                      className="page-btn"
                      onClick={() => exportToHtml(filteredResults, query || 'search_results')}
                      style={{ marginLeft: 'auto', backgroundColor: '#333', border: '1px solid #555' }}
                    >
                      📥 Export HTML
                    </button>
                  </div>
                )}
              </>
            );
          })()}

          {/* Export Button (shown when no pagination) */}
          {results.length > 0 && results.length <= ITEMS_PER_PAGE && (
            <div style={{ textAlign: 'right', marginTop: '1rem' }}>
              <button
                className="page-btn"
                onClick={() => exportToHtml(results, query || 'search_results')}
                style={{ backgroundColor: '#333', border: '1px solid #555' }}
              >
                📥 Export HTML ({results.length} items)
              </button>
            </div>
          )}

          {!loading && results.length === 0 && query && !error && (
            <p style={{ marginTop: '2rem', color: '#666' }}>No results found or search not started.</p>
          )}
        </>
      )}

      {view === 'watchlist' && (
        <WatchlistManager
          authenticatedFetch={authenticatedFetch}
          onBlock={handleBlock}
          taobaoEnabled={taobaoEnabled}
          goofishEnabled={goofishEnabled}
        />
      )}

      {view === 'blocked' && (
        <BlockedManager authenticatedFetch={authenticatedFetch} />
      )}

      {view === 'options' && (
        <OptionsManager authenticatedFetch={authenticatedFetch} />
      )}
    </div>
  );
}

export default App;
