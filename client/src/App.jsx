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
  const ITEMS_PER_PAGE = 24;

  // Login protection state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [checkingAuth, setCheckingAuth] = useState(true);

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
      } catch (err) {
        console.error('Error checking auth:', err);
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
  }, [sourceFilter]);

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

  const search = async (e, overrideQuery = null) => {
    if (e) e.preventDefault();
    const searchTerm = overrideQuery || query;
    if (!searchTerm.trim()) return;

    setLoading(true);
    setError(null);
    setResults([]);
    setCurrentPage(1); // Reset page on new search

    // Save to history
    saveToHistory(searchTerm, 'normal');
    if (overrideQuery) setQuery(overrideQuery);

    try {
      const response = await authenticatedFetch(`/api/search?q=${encodeURIComponent(searchTerm)}`);
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      const data = await response.json();
      setResults(data);
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

    if (overrideQuery) setQuery(overrideQuery);

    // Save to history (save the base term)
    saveToHistory(queryTerm, 'gk');

    const terms = [
      `${queryTerm} ガレージキット`,
      `${queryTerm} レジンキット`,
      `${queryTerm} レジンキャストキット`
    ];

    try {
      // Run searches in parallel
      const promises = terms.map(term =>
        authenticatedFetch(`/api/search?q=${encodeURIComponent(term)}`)
          .then(res => res.json())
          .catch(err => {
            console.error(`Error searching ${term}:`, err);
            return [];
          })
      );

      const allResults = await Promise.all(promises);
      const flatResults = allResults.flat();

      // Deduplicate by link
      const uniqueResults = [];
      const seenLinks = new Set();

      flatResults.forEach(item => {
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
          <div className="search-container" style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem', marginTop: '1rem' }}>
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
            </form>
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
                      className={`history-chip ${type === 'gk' ? 'gk-history' : ''}`}
                      onClick={() => type === 'gk' ? searchGK(null, term) : search(null, term)}
                      title={type === 'gk' ? "Re-run GK Search" : "Re-run Search"}
                    >
                      {term} {type === 'gk' && <span className="gk-badge">GK</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {loading && <div className="loading">Searching across Japan...</div>}

          {error && <div className="error">{error}</div>}

          {/* Source Filter */}
          {results.length > 0 && (
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
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
              <button
                className="action-btn surugaya-btn"
                onClick={() => window.open(`https://www.suruga-ya.jp/search?category=&search_word=${encodeURIComponent(query)}`, '_blank')}
                style={{ marginLeft: 'auto', padding: '0.5rem 1rem', fontSize: '0.9rem' }}
              >
                🔍 Search Suruga-ya
              </button>
            </div>
          )}

          {(() => {
            const filteredResults = sourceFilter === 'All'
              ? results
              : results.filter(item => item.source === sourceFilter);
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
                  </div>
                )}
              </>
            );
          })()}

          {!loading && results.length === 0 && query && !error && (
            <p style={{ marginTop: '2rem', color: '#666' }}>No results found or search not started.</p>
          )}
        </>
      )}

      {view === 'watchlist' && (
        <WatchlistManager authenticatedFetch={authenticatedFetch} onBlock={handleBlock} />
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
