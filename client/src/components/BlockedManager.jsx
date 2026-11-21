import React, { useState, useEffect, useCallback } from 'react';

const BlockedManager = ({ authenticatedFetch }) => {
    const [blockedItems, setBlockedItems] = useState([]);
    const [favoriteItems, setFavoriteItems] = useState([]);
    // blacklist state is now just for tracking changes if needed, but we mainly use newTerm for the textarea
    // to avoid confusion, let's rename newTerm to blacklistText
    const [blacklistText, setNewTerm] = useState(''); // Reusing setNewTerm setter to minimize diff, but essentially it's the text block 

    const fetchBlockedItems = useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/blocked');
            const data = await res.json();
            setBlockedItems(data);
        } catch (err) {
            console.error('Error fetching blocked items:', err);
        }
    }, [authenticatedFetch]);

    const fetchFavoriteItems = useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/favorites');
            const data = await res.json();
            setFavoriteItems(data);
        } catch (err) {
            console.error('Error fetching favorite items:', err);
        }
    }, [authenticatedFetch]);

    const fetchBlacklist = useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/blacklist');
            const data = await res.json();
            // Convert list to newline-separated string
            const text = data.map(item => item.term).join('\n');
            setNewTerm(text);
        } catch (err) {
            console.error('Error fetching blacklist:', err);
        }
    }, [authenticatedFetch]);

    useEffect(() => {
        const loadInitialData = async () => {
            await Promise.all([
                fetchBlockedItems(),
                fetchFavoriteItems(),
                fetchBlacklist()
            ]);
        };
        void loadInitialData();
    }, [fetchBlockedItems, fetchFavoriteItems, fetchBlacklist]);

    const saveBulkBlacklist = async () => {
        const terms = blacklistText.split('\n').map(t => t.trim()).filter(t => t);
        try {
            const res = await authenticatedFetch('/api/blacklist', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ terms })
            });
            if (res.ok) {
                alert('Blacklist updated!');
                fetchBlacklist(); // Refresh to normalize formatting
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to update blacklist');
            }
        } catch (err) {
            console.error('Error saving blacklist:', err);
            alert('Failed to save blacklist');
        }
    };

    const unblockItem = async (id) => {
        try {
            await authenticatedFetch(`/api/blocked/${id}`, {
                method: 'DELETE'
            });
            fetchBlockedItems();
        } catch (err) {
            console.error('Error unblocking item:', err);
        }
    };

    const unfavoriteItem = async (id) => {
        try {
            await authenticatedFetch(`/api/favorites/${id}`, {
                method: 'DELETE'
            });
            fetchFavoriteItems();
        } catch (err) {
            console.error('Error unfavoriting item:', err);
        }
    };

    const clearMissingFavorites = async () => {
        if (!window.confirm('Clear favorited items that are no longer found in stored results?')) return;

        try {
            const res = await authenticatedFetch('/api/favorites/clear-missing', {
                method: 'POST'
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to clear missing favorites');
            await fetchFavoriteItems();
            alert(`Removed ${data.removed || 0} favorited item${data.removed === 1 ? '' : 's'}.`);
        } catch (err) {
            console.error('Error clearing missing favorites:', err);
            alert('Failed to clear missing favorites');
        }
    };

    const clearMissingBlockedItems = async () => {
        if (!window.confirm('Clear blocked items confirmed missing by tracked watch searches?')) return;

        try {
            const res = await authenticatedFetch('/api/blocked/clear-missing', {
                method: 'POST'
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to clear missing blocked items');
            await fetchBlockedItems();
            alert(`Removed ${data.removed || 0} blocked item${data.removed === 1 ? '' : 's'}.`);
        } catch (err) {
            console.error('Error clearing missing blocked items:', err);
            alert('Failed to clear missing blocked items');
        }
    };

    return (
        <div className="watchlist-container">
            {/* Desktop: Side-by-side grid, Mobile: Stack */}
            <div className="blocked-grid">
                {/* Favorite Items Section */}
                <div className="blocked-section">
                    <h2>Favorited items</h2>
                    <p className="options-description">
                        Favorited items are tracked for price changes in scheduled email digests.
                    </p>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                        <button
                            className="page-btn"
                            onClick={clearMissingFavorites}
                            disabled={favoriteItems.length === 0}
                            title="Unfavorite items that are no longer in stored results"
                        >
                            Clear Missing
                        </button>
                    </div>

                    <ul className="watchlist-items" style={{ margin: '0' }}>
                        {favoriteItems.length === 0 && <p className="rail-empty">No favorited items.</p>}

                        {favoriteItems.map(item => (
                            <li key={item.id} className="watchlist-item">
                                {item.image && (
                                    <div className="list-thumbnail">
                                        <img
                                            src={item.image}
                                            alt=""
                                        />
                                    </div>
                                )}
                                <div className="watch-info">
                                    <span className="watch-term" style={{ fontSize: '0.9rem', marginBottom: '4px' }}>{item.title}</span>
                                    <span className="watch-meta">
                                        {item.price || item.bidPrice || item.binPrice || 'No price saved'}
                                        {item.source && ` • ${item.source}`}
                                    </span>
                                    <a href={item.url} target="_blank" rel="noreferrer" className="watch-meta" >
                                        {item.url.substring(0, 50)}...
                                    </a>
                                </div>
                                <button className="delete-btn" onClick={() => unfavoriteItem(item.id)} title="Unfavorite">
                                    ★
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Universal Blacklist Section */}
                <div className="blocked-section">
                    <h2>Universal blacklist</h2>
                    <p className="options-description">
                        Items containing these terms will be hidden from <strong>all</strong> search results.<br />
                        <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>One term per line.</span>
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <textarea
                            value={blacklistText}
                            onChange={(e) => setNewTerm(e.target.value)}
                            placeholder="Enter terms to block (one per line)..."
                            className="settings-input"
                            aria-label="Terms to block"
                            rows={10}
                            style={{
                                width: '100%',
                                minHeight: '200px',
                                fontFamily: 'monospace',
                                lineHeight: '1.5',
                                padding: '10px'
                            }}
                        />

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                            <button
                                onClick={saveBulkBlacklist}
                                className="save-btn"

                            >
                                Save Blacklist
                            </button>
                        </div>
                    </div>
                </div>

                {/* Blocked Items Section */}
                <div className="blocked-section">
                    <h2>Blocked items</h2>
                    <p className="options-description">
                        These specific items (by URL) will be permanently hidden from future search results.
                    </p>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                        <button
                            className="page-btn"
                            onClick={clearMissingBlockedItems}
                            disabled={blockedItems.length === 0}
                            title="Unblock items that are no longer in stored results"
                        >
                            Clear Missing
                        </button>
                    </div>

                    <ul className="watchlist-items" style={{ margin: '0' }}>
                        {blockedItems.length === 0 && <p className="rail-empty">No blocked items.</p>}

                        {blockedItems.map(item => (
                            <li key={item.id} className="watchlist-item">
                                {item.image && (
                                    <div className="list-thumbnail">
                                        <img
                                            src={item.image}
                                            alt=""
                                        />
                                    </div>
                                )}
                                <div className="watch-info">
                                    <span className="watch-term" style={{ fontSize: '0.9rem', marginBottom: '4px' }}>{item.title}</span>
                                    <a href={item.url} target="_blank" rel="noreferrer" className="watch-meta" >
                                        {item.url.substring(0, 50)}...
                                    </a>
                                </div>
                                <button className="delete-btn" onClick={() => unblockItem(item.id)} title="Unblock">
                                    Unblock
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
};

export default BlockedManager;
