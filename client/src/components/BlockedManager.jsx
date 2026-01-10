import React, { useState, useEffect } from 'react';

const BlockedManager = ({ authenticatedFetch }) => {
    const [blockedItems, setBlockedItems] = useState([]);
    const [blacklist, setBlacklist] = useState([]);
    const [newTerm, setNewTerm] = useState('');

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
            setBlacklist(data);
        } catch (err) {
            console.error('Error fetching blacklist:', err);
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

    const addToBlacklist = async (e) => {
        e.preventDefault();
        if (!newTerm.trim()) return;

        try {
            const res = await authenticatedFetch('/api/blacklist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ term: newTerm })
            });
            if (res.ok) {
                setNewTerm('');
                fetchBlacklist();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to add term');
            }
        } catch (err) {
            console.error('Error adding to blacklist:', err);
        }
    };

    const removeFromBlacklist = async (id) => {
        try {
            await authenticatedFetch(`/api/blacklist/${id}`, {
                method: 'DELETE'
            });
            fetchBlacklist();
        } catch (err) {
            console.error('Error removing from blacklist:', err);
        }
    };

    return (
        <div className="watchlist-container">
            {/* Universal Blacklist Section */}
            <div className="options-section" style={{ marginBottom: '3rem' }}>
                <h2>🚫 Universal Blacklist</h2>
                <p style={{ textAlign: 'center', marginBottom: '1.5rem', color: '#888' }}>
                    Items containing these terms will be hidden from <strong>all</strong> search results.
                </p>

                <form onSubmit={addToBlacklist} style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '1.5rem' }}>
                    <input
                        type="text"
                        value={newTerm}
                        onChange={(e) => setNewTerm(e.target.value)}
                        placeholder="Enter term to filter..."
                        className="search-input"
                        style={{ maxWidth: '300px' }}
                    />
                    <button type="submit" className="add-btn">+ Add</button>
                </form>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>
                    {blacklist.length === 0 && <p style={{ color: '#666' }}>No blacklisted terms yet.</p>}
                    {blacklist.map(item => (
                        <span
                            key={item.id}
                            className="history-chip"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                background: 'rgba(255, 68, 68, 0.2)',
                                borderColor: '#ff4444'
                            }}
                        >
                            {item.term}
                            <button
                                onClick={() => removeFromBlacklist(item.id)}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: 0,
                                    fontSize: '1rem'
                                }}
                                title="Remove"
                            >
                                ✕
                            </button>
                        </span>
                    ))}
                </div>
            </div>

            {/* Blocked Items Section */}
            <h2>🔗 Blocked Items</h2>
            <p style={{ textAlign: 'center', marginBottom: '2rem', color: '#888' }}>
                These specific items (by URL) will be permanently hidden from future search results.
            </p>

            <ul className="watchlist-items" style={{ maxWidth: '800px', margin: '0 auto' }}>
                {blockedItems.length === 0 && <p style={{ textAlign: 'center' }}>No blocked items.</p>}

                {blockedItems.map(item => (
                    <li key={item.id} className="watchlist-item" style={{ cursor: 'default' }}>
                        <div className="watch-info">
                            <span className="watch-term" style={{ fontSize: '0.9rem', marginBottom: '4px' }}>{item.title}</span>
                            <a href={item.url} target="_blank" rel="noreferrer" className="watch-meta" style={{ textDecoration: 'none', color: '#646cff' }}>
                                {item.url.substring(0, 60)}...
                            </a>
                        </div>
                        <button className="delete-btn" onClick={() => unblockItem(item.id)} title="Unblock">
                            ↩️
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default BlockedManager;
