import React, { useState, useEffect } from 'react';

const BlockedManager = ({ authenticatedFetch }) => {
    const [blockedItems, setBlockedItems] = useState([]);
    // blacklist state is now just for tracking changes if needed, but we mainly use newTerm for the textarea
    // to avoid confusion, let's rename newTerm to blacklistText
    const [blacklistText, setNewTerm] = useState(''); // Reusing setNewTerm setter to minimize diff, but essentially it's the text block 

    useEffect(() => {
        fetchBlockedItems();
        fetchBlacklist();
    }, []);

    const fetchBlockedItems = async () => {
        try {
            const res = await authenticatedFetch('/api/blocked');
            const data = await res.json();
            setBlockedItems(data);
        } catch (err) {
            console.error('Error fetching blocked items:', err);
        }
    };

    const fetchBlacklist = async () => {
        try {
            const res = await authenticatedFetch('/api/blacklist');
            const data = await res.json();
            // Convert list to newline-separated string
            const text = data.map(item => item.term).join('\n');
            setNewTerm(text);
        } catch (err) {
            console.error('Error fetching blacklist:', err);
        }
    };

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

    return (
        <div className="watchlist-container">
            {/* Desktop: Side-by-side grid, Mobile: Stack */}
            <div className="blocked-grid">
                {/* Universal Blacklist Section */}
                <div className="blocked-section">
                    <h2>🚫 Universal Blacklist</h2>
                    <p style={{ textAlign: 'center', marginBottom: '1.5rem', color: '#888' }}>
                        Items containing these terms will be hidden from <strong>all</strong> search results.<br />
                        <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>One term per line.</span>
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <textarea
                            value={blacklistText}
                            onChange={(e) => setNewTerm(e.target.value)}
                            placeholder="Enter terms to block (one per line)..."
                            className="settings-input"
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
                                style={{
                                    padding: '8px 24px',
                                    borderRadius: '4px',
                                    fontSize: '0.9rem',
                                    fontWeight: 'bold',
                                    background: '#e53935' // Red to indicate blocking
                                }}
                            >
                                Save Blacklist
                            </button>
                        </div>
                    </div>
                </div>

                {/* Blocked Items Section */}
                <div className="blocked-section">
                    <h2>🔗 Blocked Items</h2>
                    <p style={{ textAlign: 'center', marginBottom: '1.5rem', color: '#888' }}>
                        These specific items (by URL) will be permanently hidden from future search results.
                    </p>

                    <ul className="watchlist-items" style={{ margin: '0' }}>
                        {blockedItems.length === 0 && <p style={{ textAlign: 'center' }}>No blocked items.</p>}

                        {blockedItems.map(item => (
                            <li key={item.id} className="watchlist-item" style={{ cursor: 'default' }}>
                                {item.image && (
                                    <div style={{
                                        width: '50px',
                                        height: '50px',
                                        minWidth: '50px',
                                        borderRadius: '4px',
                                        overflow: 'hidden',
                                        marginRight: '12px',
                                        background: '#333'
                                    }}>
                                        <img
                                            src={item.image}
                                            alt=""
                                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                        />
                                    </div>
                                )}
                                <div className="watch-info">
                                    <span className="watch-term" style={{ fontSize: '0.9rem', marginBottom: '4px' }}>{item.title}</span>
                                    <a href={item.url} target="_blank" rel="noreferrer" className="watch-meta" style={{ textDecoration: 'none', color: '#646cff' }}>
                                        {item.url.substring(0, 50)}...
                                    </a>
                                </div>
                                <button className="delete-btn" onClick={() => unblockItem(item.id)} title="Unblock">
                                    ↩️
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
