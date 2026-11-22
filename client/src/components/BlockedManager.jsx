import { useEffect, useId, useState } from 'react';
import ResultCard from './ResultCard';

const tabs = [
    { id: 'favorites', label: 'Favorites', empty: 'No favorited items.' },
    { id: 'blocked', label: 'Blocked Items', empty: 'No blocked items.' },
    { id: 'blacklist', label: 'Blacklisted Terms' }
];

const BlockedManager = ({ authenticatedFetch }) => {
    const tabGroup = useId();
    const [activeTab, setActiveTab] = useState('favorites');
    const [lists, setLists] = useState({});
    const [loadErrors, setLoadErrors] = useState({});
    const [messages, setMessages] = useState({});
    const [pending, setPending] = useState(false);
    const [blacklistDraft, setBlacklistDraft] = useState(null);

    useEffect(() => {
        let current = true;
        for (const { id } of tabs) {
            const load = async () => {
                try {
                    const response = await authenticatedFetch(`/api/${id}`);
                    if (!response.ok) throw new Error('Could not load this list.');
                    const items = await response.json();
                    if (current) setLists(previous => ({ ...previous, [id]: items }));
                } catch {
                    if (current) setLoadErrors(previous => ({ ...previous, [id]: 'Could not load this list.' }));
                }
            };
            void load();
        }
        return () => { current = false; };
    }, [authenticatedFetch]);

    const selectByKey = (event, index) => {
        const next = {
            ArrowRight: (index + 1) % tabs.length,
            ArrowLeft: (index + tabs.length - 1) % tabs.length,
            Home: 0,
            End: tabs.length - 1
        }[event.key];
        if (typeof next !== 'number') return;
        event.preventDefault();
        const nextTab = tabs[next].id;
        setActiveTab(nextTab);
        document.getElementById(`${tabGroup}-tab-${nextTab}`)?.focus();
    };

    const updateList = async (id, action) => {
        setMessages(previous => ({ ...previous, [id]: null }));
        setPending(true);
        try {
            await action();
        } catch (err) {
            setMessages(previous => ({ ...previous, [id]: { text: err.message, error: true } }));
        } finally {
            setPending(false);
        }
    };

    const removeItem = (id, item) => updateList(id, async () => {
        const response = await authenticatedFetch(`/api/${id}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(id === 'blocked' ? 'Could not unblock the item.' : 'Could not remove the favorite.');
        setLists(previous => ({ ...previous, [id]: previous[id].filter(entry => entry.id !== item.id) }));
    });

    const clearMissing = (id) => {
        const description = id === 'favorites'
            ? 'Remove favorites that are missing from stored watch results?'
            : 'Unblock items confirmed missing by tracked watch searches?';
        if (!window.confirm(description)) return;
        return updateList(id, async () => {
            const response = await authenticatedFetch(`/api/${id}/clear-missing`, { method: 'POST' });
            if (!response.ok) throw new Error('Could not clear missing items.');
            const { removed } = await response.json();
            const updated = await authenticatedFetch(`/api/${id}`);
            if (!updated.ok) throw new Error('Missing items were cleared. Could not reload this list.');
            const items = await updated.json();
            setLists(previous => ({ ...previous, [id]: items }));
            setMessages(previous => ({ ...previous, [id]: { text: `Cleared ${removed} item${removed === 1 ? '' : 's'}.` } }));
        });
    };

    const savedBlacklist = lists.blacklist?.map(item => item.term).join('\n') ?? '';
    const blacklistText = blacklistDraft ?? savedBlacklist;

    const saveBlacklist = (event) => {
        event.preventDefault();
        return updateList('blacklist', async () => {
            const terms = blacklistText.split('\n').map(term => term.trim()).filter(Boolean);
            const response = await authenticatedFetch('/api/blacklist', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ terms })
            });
            if (!response.ok) throw new Error('Could not save blacklisted terms.');
            const items = await response.json();
            setLists(previous => ({ ...previous, blacklist: items }));
            setBlacklistDraft(null);
            setMessages(previous => ({ ...previous, blacklist: { text: 'Blacklisted terms saved.' } }));
        });
    };

    return (
        <div className="lists-manager">
            <div className="lists-tabs" role="tablist" aria-label="Lists">
                {tabs.map(({ id, label }, index) => (
                    <button key={id} type="button" role="tab" id={`${tabGroup}-tab-${id}`}
                        aria-controls={`${tabGroup}-panel-${id}`} aria-selected={activeTab === id}
                        tabIndex={activeTab === id ? 0 : -1}
                        className={`segment-btn${activeTab === id ? ' active' : ''}`}
                        onClick={() => setActiveTab(id)} onKeyDown={event => selectByKey(event, index)}>
                        {label}
                    </button>
                ))}
            </div>
            {tabs.map(({ id, empty }) => {
                const items = lists[id];
                const message = messages[id];
                const isFavoriteTab = id === 'favorites';
                return (
                    <section key={id} className="lists-panel" id={`${tabGroup}-panel-${id}`}
                        role="tabpanel" aria-labelledby={`${tabGroup}-tab-${id}`}
                        tabIndex={0} hidden={activeTab !== id}>
                        {activeTab === id && <>
                            {loadErrors[id] && <p role="alert" className="error">{loadErrors[id]}</p>}
                            {message && <p role={message.error ? 'alert' : 'status'}
                                className={message.error ? 'error' : undefined}>{message.text}</p>}
                            {!items && !loadErrors[id] && <p role="status">Loading…</p>}
                            {items && (id === 'blacklist' ? (
                                <form className="blacklist-editor" onSubmit={saveBlacklist}>
                                    <label htmlFor={`${tabGroup}-terms`}>One term per line</label>
                                    <textarea id={`${tabGroup}-terms`} aria-label="Blacklisted terms"
                                        value={blacklistText} onChange={event => setBlacklistDraft(event.target.value)}
                                        disabled={pending} />
                                    <button className="save-btn" disabled={pending || blacklistText === savedBlacklist}>
                                        Save Blacklist
                                    </button>
                                </form>
                            ) : (
                                <>
                                    <div className="lists-toolbar">
                                        {isFavoriteTab && <p>Missing favorites are absent from stored watch results.</p>}
                                        <button type="button" onClick={() => clearMissing(id)}
                                            disabled={pending || !items.some(item => item.isMissing)}>Clear Missing</button>
                                    </div>
                                    {items.length ? <div className="results-grid">
                                        {items.map(item => (
                                            <ResultCard key={item.id}
                                                item={{ ...item, title: item.title || item.url, isFavorite: isFavoriteTab, isBlocked: !isFavoriteTab }}
                                                onFavoriteToggle={isFavoriteTab ? entry => removeItem(id, entry) : undefined}
                                                onBlock={!isFavoriteTab ? entry => removeItem(id, entry) : undefined}
                                                actionsDisabled={pending} />
                                        ))}
                                    </div> : <p>{empty}</p>}
                                </>
                            ))}
                        </>}
                    </section>
                );
            })}
        </div>
    );
};

export default BlockedManager;
