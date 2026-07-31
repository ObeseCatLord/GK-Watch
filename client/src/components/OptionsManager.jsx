import React, { useState, useEffect, useCallback } from 'react';

const normalizeScheduleInterval = (interval) => Number(interval) === 30 ? 30 : 60;
const normalizeSlots = (slots) => [...new Set((slots || [])
    .map(slot => Number(slot))
    .filter(slot => Number.isInteger(slot) && slot >= 0 && slot < 24 * 60 && slot % 30 === 0))]
    .sort((a, b) => a - b);
const normalizeHalfHourSlots = (slots) => normalizeSlots(slots).filter(slot => slot % 60 === 30);
const getLocalTimeZoneName = () => {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
        return parts.find(part => part.type === 'timeZoneName')?.value || 'Local';
    } catch (error) {
        console.error('Error getting timezone:', error);
        return 'Local';
    }
};

const OptionsManager = ({ authenticatedFetch }) => {
    const [settings, setSettings] = useState({
        email: '',
        emailEnabled: false,
        baseUrl: 'http://localhost:5173',
        smtpHost: '',
        smtpPort: 587,
        smtpUser: '',
        smtpPass: '',
        loginEnabled: false,
        loginPassword: ''
    });
    const [saved, setSaved] = useState(false);
    const [testStatus, setTestStatus] = useState('');
    const [ntfyTestStatus, setNtfyTestStatus] = useState('');
    const [enabledSlots, setEnabledSlots] = useState([]);
    const [disabledHalfHourSlots, setDisabledHalfHourSlots] = useState([]);
    const [scheduleInterval, setScheduleInterval] = useState(60);
    const saveTimeoutRef = React.useRef(null);

    const [timeZoneName] = useState(getLocalTimeZoneName);

    // Password State
    const [newPassword, setNewPassword] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [passwordSaved, setPasswordSaved] = useState(false);

    // SMTP Password State
    const [newSmtpPass, setNewSmtpPass] = useState('');
    const [smtpPassError, setSmtpPassError] = useState('');
    const [smtpPassSaved, setSmtpPassSaved] = useState(false);

    // Cookie Upload State
    const [cookieSite, setCookieSite] = useState(null); // 'taobao', 'goofish', or 'mandarake'
    const [cookieContent, setCookieContent] = useState('');
    const [cookieError, setCookieError] = useState('');
    const [cookieSuccess, setCookieSuccess] = useState('');

    // System Cleanup State
    const [cleanupStatus, setCleanupStatus] = useState('');
    const [cleanupMessage, setCleanupMessage] = useState('');

    const fetchSettings = useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/settings');
            const data = await res.json();
            setSettings(data);
        } catch (err) {
            console.error('Error fetching settings:', err);
        }
    }, [authenticatedFetch]);

    const fetchSchedule = useCallback(async () => {
        try {
            const res = await authenticatedFetch('/api/schedule');
            const data = await res.json();
            const interval = normalizeScheduleInterval(data.intervalMinutes);
            const slots = Array.isArray(data.enabledSlots)
                ? data.enabledSlots
                : (data.enabledHours || []).map(hour => hour * 60);
            const disabledSlots = Array.isArray(data.disabledHalfHourSlots)
                ? data.disabledHalfHourSlots
                : [];

            setScheduleInterval(interval);
            setEnabledSlots(normalizeSlots(slots));
            setDisabledHalfHourSlots(normalizeHalfHourSlots(disabledSlots));
        } catch (err) {
            console.error('Error fetching schedule:', err);
        }
    }, [authenticatedFetch]);

    useEffect(() => {
        const timer = setTimeout(() => {
            fetchSettings();
            fetchSchedule();
        }, 0);
        return () => clearTimeout(timer);
    }, [fetchSettings, fetchSchedule]);

    const applyHalfHourDefaults = (slots, disabledSlots) => {
        const disabledSet = new Set(normalizeHalfHourSlots(disabledSlots));
        const slotSet = new Set(normalizeSlots(slots));

        for (const slot of Array.from(slotSet)) {
            if (slot % 60 !== 0) continue;
            const halfHourSlot = slot + 30;
            if (halfHourSlot < 24 * 60 && !disabledSet.has(halfHourSlot)) {
                slotSet.add(halfHourSlot);
            }
        }

        return Array.from(slotSet).sort((a, b) => a - b);
    };

    const saveSchedule = async (slots, interval = scheduleInterval, disabledSlots = disabledHalfHourSlots, applyDefaults = interval === 30) => {
        const normalizedInterval = normalizeScheduleInterval(interval);
        const normalizedDisabledSlots = normalizeHalfHourSlots(disabledSlots);
        const normalizedSlots = applyDefaults && normalizedInterval === 30
            ? applyHalfHourDefaults(slots, normalizedDisabledSlots)
            : normalizeSlots(slots);

        setScheduleInterval(normalizedInterval);
        setEnabledSlots(normalizedSlots);
        setDisabledHalfHourSlots(normalizedDisabledSlots);

        try {
            await authenticatedFetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    intervalMinutes: normalizedInterval,
                    enabledSlots: normalizedSlots,
                    disabledHalfHourSlots: normalizedDisabledSlots
                })
            });
        } catch (err) {
            console.error('Error saving schedule:', err);
        }
    };

    const toggleSlot = async (slot) => {
        const normalizedSlot = Number(slot);
        const isHalfHourSlot = normalizedSlot % 60 === 30;
        const isEnabled = enabledSlots.includes(normalizedSlot);
        const newSlots = isEnabled
            ? enabledSlots.filter(s => s !== normalizedSlot)
            : [...enabledSlots, normalizedSlot];
        const newDisabledHalfHourSlots = isHalfHourSlot
            ? (isEnabled
                ? normalizeHalfHourSlots([...disabledHalfHourSlots, normalizedSlot])
                : disabledHalfHourSlots.filter(s => s !== normalizedSlot))
            : disabledHalfHourSlots;

        await saveSchedule(newSlots, scheduleInterval, newDisabledHalfHourSlots);
    };

    const changeScheduleInterval = async (interval) => {
        await saveSchedule(enabledSlots, interval, disabledHalfHourSlots, interval === 30);
    };

    const formatSlot = (slot) => {
        const normalized = ((slot % (24 * 60)) + (24 * 60)) % (24 * 60);
        const hour = Math.floor(normalized / 60);
        const minute = normalized % 60;
        return `${hour}:${String(minute).padStart(2, '0')}`;
    };

    const jstToLocalSlot = (jstSlot) => {
        const offsetMinutes = -new Date().getTimezoneOffset();
        const diffMinutes = offsetMinutes - (9 * 60);
        return (jstSlot + diffMinutes + (24 * 60)) % (24 * 60);
    };

    const savePassword = async () => {
        if (!newPassword) {
            setPasswordError('Password cannot be empty');
            return;
        }
        if (newPassword.length < 12) {
            setPasswordError('Password must be at least 12 characters');
            return;
        }

        try {
            const res = await authenticatedFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ loginPassword: newPassword })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            setNewPassword('');
            setPasswordError('');
            setPasswordSaved(true);
            setTimeout(() => setPasswordSaved(false), 3000);

            // Refresh settings to reflect loginEnabled status
            fetchSettings();
        } catch (err) {
            console.error('Error saving password:', err);
            setPasswordError(err.message || 'Failed to save password');
        }
    };


    const handleChange = (e) => {
        const { name, value, type, checked } = e.target;
        const newSettings = {
            ...settings,
            [name]: type === 'checkbox' ? checked : value
        };
        setSettings(newSettings);
        triggerAutoSave(newSettings);
    };

    const handleNestedChange = (category, key, value) => {
        const newCategory = { ...settings[category] || {}, [key]: value };
        const newSettings = { ...settings, [category]: newCategory };
        setSettings(newSettings);
        triggerAutoSave(newSettings);
    };

    const triggerAutoSave = (newSettings) => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(async () => {
            try {
                await authenticatedFetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newSettings)
                });
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } catch (err) {
                console.error('Error auto-saving settings:', err);
            }
        }, 500);
    };

    const handleCookieSave = async () => {
        if (!cookieContent.trim()) {
            setCookieError('Please paste cookie JSON content');
            return;
        }

        try {
            // Basic validation
            JSON.parse(cookieContent);
        } catch {
            setCookieError('Invalid JSON format. Please copy directly from EditThisCookie.');
            return;
        }

        try {
            const res = await authenticatedFetch(`/api/cookies/${cookieSite}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: cookieContent })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save');

            setCookieSuccess('Cookies saved! Enabling site...');

            // Auto-enable the site
            handleNestedChange('enabledSites', cookieSite, true);

            setTimeout(() => {
                // setShowCookieModal(false);
                setCookieContent('');
                setCookieSuccess('');
                setCookieSite(null);
            }, 1000);

        } catch (err) {
            setCookieError(err.message);
        }
    };

    const sendTestEmail = async () => {
        if (!settings.email) {
            alert('Please enter an email address first');
            return;
        }

        setTestStatus('sending');
        try {
            const res = await authenticatedFetch('/api/settings/test-email', {
                method: 'POST'
            });
            const data = await res.json();

            if (data.error) {
                throw new Error(data.error);
            }

            if (data.previewUrl) {
                setTestStatus('success');
                if (window.confirm('Test email sent! Would you like to view it in your browser? (Using Ethereal test service)')) {
                    window.open(data.previewUrl, '_blank');
                }
            } else {
                setTestStatus('success');
                alert('Test email sent successfully!');
            }
            setTimeout(() => setTestStatus(''), 3000);
        } catch (err) {
            console.error('Error sending test email:', err);
            setTestStatus('error');
            alert('Failed to send test email: ' + err.message);
            setTimeout(() => setTestStatus(''), 3000);
        }
    };

    const sendTestNtfy = async () => {
        if (!settings.ntfyTopic) {
            alert('Please enter a Topic first');
            return;
        }

        setNtfyTestStatus('sending');
        try {
            const res = await authenticatedFetch('/api/settings/test-ntfy', {
                method: 'POST'
            });
            const data = await res.json();

            if (data.error) {
                throw new Error(data.error);
            }

            setNtfyTestStatus('success');
            alert('Test notification sent!');
            setTimeout(() => setNtfyTestStatus(''), 3000);
        } catch (err) {
            console.error('Error sending test ntfy:', err);
            setNtfyTestStatus('error');
            alert('Failed to send Ntfy notification: ' + err.message);
            setTimeout(() => setNtfyTestStatus(''), 3000);
        }
    };

    const exportWatchlist = async () => {
        try {
            // Fetch all data
            const [watchlistRes, blacklistRes, blockedRes, favoritesRes] = await Promise.all([
                authenticatedFetch('/api/watchlist'),
                authenticatedFetch('/api/blacklist'),
                authenticatedFetch('/api/blocked'),
                authenticatedFetch('/api/favorites')
            ]);

            const watchlist = await watchlistRes.json();
            const blacklist = await blacklistRes.json();
            const blocked = await blockedRes.json();
            const favorites = await favoritesRes.json();

            // Create comprehensive export object
            const exportData = {
                exportedAt: new Date().toISOString(),
                watchlist: watchlist.map(item => ({
                    name: item.name,
                    terms: item.terms || [item.term || item.name],
                    filters: item.filters || []
                })),
                blacklist: blacklist.map(item => item.term),
                blockedItems: blocked.map(item => ({
                    url: item.url,
                    title: item.title
                })),
                favoriteItems: favorites.map(item => ({
                    url: item.url,
                    title: item.title,
                    image: item.image,
                    price: item.price,
                    bidPrice: item.bidPrice,
                    binPrice: item.binPrice,
                    source: item.source
                }))
            };

            // Create and download JSON file
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'gkwatch_backup.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Error exporting data:', err);
            alert('Failed to export data');
        }
    };

    const importWatchlist = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            let importData = null;
            let isJson = false;

            // Try parsing as JSON first
            try {
                importData = JSON.parse(text);
                isJson = true;
            } catch {
                // Not JSON, fall back to text lines
                isJson = false;
            }

            let added = 0;
            let errors = 0;
            let firstError = null;

            if (isJson) {
                // Handle JSON Backup Import
                const { watchlist, blacklist, blockedItems, favoriteItems } = importData;

                // Import Watchlist
                if (Array.isArray(watchlist)) {
                    for (const item of watchlist) {
                        try {
                            const payload = {
                                name: item.name,
                                term: item.term || item.terms?.[0], // fallback
                                terms: item.terms || [item.term],
                                filters: item.filters || []
                            };
                            const res = await authenticatedFetch('/api/watchlist', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            if (!res.ok) throw new Error(`Status ${res.status} (${res.statusText})`);
                            added++;
                        } catch (err) {
                            console.error(`Failed to import watchlist item: ${item.name}`, err);
                            errors++;
                            // Capture first error for alert
                            if (errors === 1) firstError = err.message;
                        }
                    }
                }

                // Import Blacklist
                if (Array.isArray(blacklist)) {
                    for (const item of blacklist) {
                        try {
                            // Support both object {term: "foo"} and string "foo"
                            const term = typeof item === 'string' ? item : item.term;
                            if (!term) continue;

                            const res = await authenticatedFetch('/api/blacklist', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ term })
                            });
                            if (!res.ok && res.status !== 409) throw new Error(`Status ${res.status} (${res.statusText})`); // Ignore duplicates (409)
                            if (res.ok) added++;
                        } catch (err) {
                            console.error(`Failed to import blacklist item`, err);
                            errors++;
                            if (errors === 1) firstError = err.message;
                        }
                    }
                }

                // Import Blocked Items
                if (Array.isArray(blockedItems)) {
                    for (const item of blockedItems) {
                        try {
                            const res = await authenticatedFetch('/api/blocked', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ url: item.url, title: item.title })
                            });
                            if (!res.ok) throw new Error(`Status ${res.status} (${res.statusText})`);
                            added++;
                        } catch (err) {
                            console.error(`Failed to import blocked item`, err);
                            errors++;
                            if (errors === 1) firstError = err.message;
                        }
                    }
                }

                // Import Favorite Items
                if (Array.isArray(favoriteItems)) {
                    for (const item of favoriteItems) {
                        try {
                            const res = await authenticatedFetch('/api/favorites', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(item)
                            });
                            if (!res.ok) throw new Error(`Status ${res.status} (${res.statusText})`);
                            added++;
                        } catch (err) {
                            console.error(`Failed to import favorite item`, err);
                            errors++;
                            if (errors === 1) firstError = err.message;
                        }
                    }
                }

            } else {
                // Legacy Text/CSV Import
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (lines.length === 0) {
                    alert('No terms found in file');
                    return;
                }

                for (const line of lines) {
                    try {
                        const terms = line.split(',').map(t => t.trim()).filter(t => t);
                        if (terms.length > 0) {
                            const res = await authenticatedFetch('/api/watchlist', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    term: terms[0], // for compatibility/name fallback
                                    terms: terms
                                })
                            });

                            if (!res.ok) throw new Error(`Status ${res.status} (${res.statusText})`);
                            added++;
                        }
                    } catch (err) {
                        console.error(`Failed to add line: ${line}`, err);
                        errors++;
                        if (errors === 1) firstError = err.message;
                    }
                }
            }

            alert(`Import completed!\nSuccessfully added: ${added} items\nErrors/Duplicates: ${errors}\n${firstError ? 'First Error: ' + firstError : ''}`);
            e.target.value = ''; // Reset file input

            // Refresh data
            fetchSettings(); // Refresh settings/stats if applicable
            // If we had parent props to refresh watchlist/blacklist we would call them here,
            // but OptionsManager typically manages its own fetches or relies on parent refreshes.

        } catch (err) {
            console.error('Error importing file:', err);
            alert('Failed to import file: ' + err.message);
        }
    };

    const runManualCleanup = async () => {
        setCleanupStatus('cleaning');
        setCleanupMessage('');
        try {
            const previewRes = await authenticatedFetch('/api/cleanup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const preview = await previewRes.json();
            if (!previewRes.ok) throw new Error(preview.error || 'Cleanup preview failed');
            const expiredCount = preview.stats?.results?.wouldRemove || 0;
            const tempCount = preview.stats?.puppeteer?.filesRemoved || 0;
            if (!window.confirm(`Delete ${expiredCount} expired result(s) and ${tempCount} temporary item(s)?`)) {
                setCleanupStatus('');
                return;
            }

            const res = await authenticatedFetch('/api/cleanup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: true })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Cleanup failed');

            setCleanupStatus('success');
            // Format stats
            let msg = 'Cleanup completed.';
            if (data.stats) {
                const { log, results, puppeteer } = data.stats;
                const details = [];
                if (log?.rotated) details.push(`Log rotated`);
                if (log?.linesRemoved) details.push(`Removed ${log.linesRemoved} log lines`);
                if (results?.itemsRemoved) details.push(`Removed ${results.itemsRemoved} expired items`);
                if (puppeteer?.filesRemoved) details.push(`Cleared ${puppeteer.filesRemoved} temp files`);

                if (details.length > 0) msg = `Cleanup Success: ${details.join(', ')}`;
                else msg = 'Cleanup Success: No items needed removal.';
            }
            setCleanupMessage(msg);
            setTimeout(() => {
                if (cleanupStatus !== 'cleaning') {
                    setCleanupStatus('');
                    setCleanupMessage('');
                }
            }, 5000);
        } catch (err) {
            console.error('Cleanup error:', err);
            setCleanupStatus('error');
            setCleanupMessage('Error: ' + err.message);
        }
    };

    return (
        <div className="options-container">
            <h2>Options</h2>

            {/* Schedule Picker */}
            <div className="options-section">
                <h3>⏰ Search Schedule</h3>
                <p className="options-description">
                    Click time slots to toggle when automatic searches run (JST / {timeZoneName} displayed).
                </p>
                <div className="schedule-controls">
                    <div className="schedule-interval-toggle" role="group" aria-label="Schedule interval">
                        <button
                            type="button"
                            className={`segment-btn ${scheduleInterval === 60 ? 'active' : ''}`}
                            onClick={() => changeScheduleInterval(60)}
                        >
                            1 hour
                        </button>
                        <button
                            type="button"
                            className={`segment-btn ${scheduleInterval === 30 ? 'active' : ''}`}
                            onClick={() => changeScheduleInterval(30)}
                        >
                            30 min
                        </button>
                    </div>
                </div>
                <div className={`hour-grid ${scheduleInterval === 30 ? 'half-hour-grid' : ''}`}>
                    {Array.from({ length: (24 * 60) / scheduleInterval }, (_, i) => i * scheduleInterval).map(slot => (
                        <button
                            key={slot}
                            className={`hour-btn ${enabledSlots.includes(slot) ? 'active' : ''}`}
                            onClick={() => toggleSlot(slot)}
                            title={`JST ${formatSlot(slot)} / ${timeZoneName} ${formatSlot(jstToLocalSlot(slot))}`}
                        >
                            <span className="jst-hour">{formatSlot(slot)} JST</span>
                            <span className="cst-hour">{formatSlot(jstToLocalSlot(slot))} {timeZoneName}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Site & Scraper Settings */}
            <div className="options-section">
                <h3>🌍 Site & Scraper Settings</h3>
                <p className="options-description">
                    Control which sites to search and how strict the keyword matching should be.
                </p>

                <div className="sites-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '15px', marginTop: '15px' }}>
                    {['mercari', 'yahoo', 'paypay', 'fril', 'surugaya', 'mandarake', 'taobao', 'goofish'].map(site => {
                        const siteName = site === 'yahoo' ? 'Yahoo Auctions' :
                            site === 'fril' ? 'Rakuma (Fril)' :
                                site === 'paypay' ? 'PayPay Flea Market' :
                                    site === 'surugaya' ? 'Suruga-ya' :
                                        site === 'mandarake' ? 'Mandarake' :
                                            site === 'taobao' ? 'Taobao' :
                                                site === 'goofish' ? 'Goofish (Xianyu)' : 'Mercari';
                        return (
                            <div key={site} className="site-card" style={{ background: '#2a2a2a', padding: '15px', borderRadius: '8px', border: '1px solid #333' }}>
                                <h4 style={{ textTransform: 'capitalize', marginTop: 0, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    {siteName}
                                </h4>

                                <div style={{ marginBottom: '8px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', opacity: (site === 'taobao' && !settings.enabledSites?.taobao && !settings.hasTaobaoCookies) || (site === 'goofish' && !settings.enabledSites?.goofish && !settings.hasGoofishCookies) ? 1 : 1 }}>
                                        <input
                                            type="checkbox"
                                            checked={settings.enabledSites?.[site] !== false}
                                            onChange={async (e) => {
                                                const checked = e.target.checked;
                                                if (site === 'taobao' && checked) {
                                                    // Verify cookies before enabling
                                                    try {
                                                        const res = await authenticatedFetch('/api/taobao/status');
                                                        const data = await res.json();
                                                        if (!data.hasCookies) {
                                                            setCookieSite('taobao');
                                                            // setShowCookieModal(true); // Removed in favor of inline
                                                            return; // Do not toggle yet
                                                        }
                                                    } catch (err) {
                                                        console.error('Error checking Taobao status:', err);
                                                        return;
                                                    }
                                                }
                                                if (site === 'goofish' && checked) {
                                                    // Verify cookies before enabling
                                                    try {
                                                        const res = await authenticatedFetch('/api/goofish/status');
                                                        const data = await res.json();
                                                        if (!data.hasCookies) {
                                                            setCookieSite('goofish');
                                                            // setShowCookieModal(true); // Removed
                                                            return; // Do not toggle yet
                                                        }
                                                    } catch (err) {
                                                        console.error('Error checking Goofish status:', err);
                                                        return;
                                                    }
                                                }
                                                if (site === 'mandarake' && checked) {
                                                    // Verify cookies before enabling
                                                    try {
                                                        const res = await authenticatedFetch('/api/mandarake/status');
                                                        const data = await res.json();
                                                        if (!data.hasCookies) {
                                                            setCookieSite('mandarake');
                                                            return; // Do not toggle yet
                                                        }
                                                    } catch (err) {
                                                        console.error('Error checking Mandarake status:', err);
                                                        return;
                                                    }
                                                }
                                                handleNestedChange('enabledSites', site, checked);
                                            }}
                                            style={{ marginRight: '8px' }}
                                        />
                                        Enable Search
                                    </label>

                                    {(site === 'taobao' || site === 'goofish' || site === 'mandarake') && (
                                        <div style={{ marginTop: '5px', marginLeft: '24px' }}>
                                            <button
                                                className="edit-btn"
                                                onClick={() => {
                                                    if (cookieSite === site) {
                                                        // Toggle off
                                                        setCookieSite(null);
                                                        setCookieContent('');
                                                        setCookieError('');
                                                        setCookieSuccess('');
                                                    } else {
                                                        setCookieSite(site);
                                                        setCookieContent('');
                                                        setCookieError('');
                                                        setCookieSuccess('');
                                                    }
                                                }}
                                                style={{ fontSize: '0.8rem', padding: '2px 8px' }}
                                            >
                                                {cookieSite === site ? '❌ Cancel' : '🍪 Update Cookies'}
                                            </button>

                                            {/* Inline Cookie Edit Form */}
                                            {cookieSite === site && (
                                                <div style={{ marginTop: '10px', background: '#333', padding: '10px', borderRadius: '8px', border: '1px solid #444' }}>
                                                    <p style={{ color: '#aaa', fontSize: '0.8rem', marginBottom: '8px', lineHeight: '1.4' }}>
                                                        1. Install <b>Cookie-Editor</b> extension.<br />
                                                        2. Log in to <b>{site === 'taobao' ? 'Taobao' : site === 'goofish' ? 'Goofish' : 'Mandarake'}</b>.<br />
                                                        3. Click <b>Export</b> - <b>Export as JSON</b>.<br />
                                                        4. Paste below and Save.
                                                    </p>

                                                    <textarea
                                                        value={cookieContent}
                                                        onChange={(e) => setCookieContent(e.target.value)}
                                                        placeholder="Paste JSON here"
                                                        rows={6}
                                                        className="settings-input"
                                                        style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.75rem', marginBottom: '8px' }}
                                                    />

                                                    {cookieError && <div style={{ color: 'red', marginBottom: '8px', fontSize: '0.8rem' }}>{cookieError}</div>}
                                                    {cookieSuccess && <div style={{ color: 'green', marginBottom: '8px', fontSize: '0.8rem' }}>{cookieSuccess}</div>}

                                                    <button
                                                        className="page-btn active"
                                                        onClick={handleCookieSave}
                                                        disabled={!cookieContent}
                                                        style={{ width: '100%', padding: '6px' }}
                                                    >
                                                        Save Cookies
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={settings.strictFiltering?.[site] !== false}
                                            onChange={(e) => handleNestedChange('strictFiltering', site, e.target.checked)}
                                            style={{ marginRight: '8px' }}
                                        />
                                        Strict Filtering
                                    </label>
                                    <div style={{ fontSize: '0.75rem', color: '#888', marginLeft: '24px', marginTop: '2px' }}>
                                        {settings.strictFiltering?.[site] !== false
                                            ? 'Only matches exact title keywords (or synonyms).'
                                            : 'Accepts all search results from site.'}
                                    </div>
                                </div>

                                {site === 'yahoo' && (
                                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #444' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={settings.allowYahooInternationalShipping || false}
                                                onChange={(e) => handleChange({ target: { name: 'allowYahooInternationalShipping', type: 'checkbox', checked: e.target.checked } })}
                                                style={{ marginRight: '8px' }}
                                            />
                                            Allow International Shipping
                                        </label>
                                        <div style={{ fontSize: '0.75rem', color: '#888', marginLeft: '24px', marginTop: '2px' }}>
                                            Include items marked as "International Shipping" (国際便).
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="options-section">
                <h3>📧 Email Notifications</h3>
                <p className="options-description">
                    Receive email alerts when new items are found during scheduled searches.
                </p>

                <div className="option-row">
                    <label>
                        <input
                            type="checkbox"
                            name="emailEnabled"
                            checked={settings.emailEnabled}
                            onChange={handleChange}
                        />
                        Enable email notifications
                    </label>
                </div>

                <div className="option-row">
                    <label>Notification Email:</label>
                    <input
                        type="email"
                        name="email"
                        value={settings.email}
                        onChange={handleChange}
                        placeholder="your@email.com"
                        className="option-input"
                    />
                </div>

                <div className="option-row">
                    <label>Dashboard Base URL (for email links):</label>
                    <input
                        type="text"
                        name="baseUrl"
                        value={settings.baseUrl || ''}
                        onChange={handleChange}
                        placeholder="http://localhost:5173 or https://your-domain.com"
                        className="option-input"
                    />
                </div>

                <details className="smtp-details">
                    <summary>SMTP Settings (Optional)</summary>
                    <p className="options-description">
                        Leave blank to use a test email service (Ethereal). Configure for production use.
                    </p>

                    <div className="option-row">
                        <label>SMTP Host:</label>
                        <input
                            type="text"
                            name="smtpHost"
                            value={settings.smtpHost}
                            onChange={handleChange}
                            placeholder="smtp.gmail.com"
                            className="option-input"
                        />
                    </div>

                    <div className="option-row">
                        <label>SMTP Port:</label>
                        <input
                            type="number"
                            name="smtpPort"
                            value={settings.smtpPort}
                            onChange={handleChange}
                            placeholder="587"
                            className="option-input small"
                        />
                    </div>

                    <div className="option-row">
                        <label>SMTP Username:</label>
                        <input
                            type="text"
                            name="smtpUser"
                            value={settings.smtpUser}
                            onChange={handleChange}
                            placeholder="username"
                            className="option-input"
                        />
                    </div>

                    <div className="setting-group" style={{ background: '#2a2a2a', padding: '15px', borderRadius: '8px', marginTop: '10px' }}>
                        <p style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '10px' }}>
                            {settings.hasSmtpPass ? '✅ Password is set.' : '⚠️ No password set.'}
                        </p>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <input
                                type="password"
                                value={newSmtpPass}
                                onChange={(e) => {
                                    setNewSmtpPass(e.target.value);
                                    setSmtpPassError('');
                                }}
                                placeholder="Set SMTP Password"
                                className="settings-input"
                                style={{ flex: '1', minWidth: '200px' }}
                            />
                            <button
                                className="save-btn small"
                                onClick={async () => {
                                    if (!newSmtpPass) {
                                        setSmtpPassError('Password cannot be empty');
                                        return;
                                    }
                                    try {
                                        const res = await authenticatedFetch('/api/settings', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ smtpPass: newSmtpPass })
                                        });
                                        const data = await res.json();
                                        if (data.error) throw new Error(data.error);

                                        setNewSmtpPass('');
                                        setSmtpPassError('');
                                        setSmtpPassSaved(true);
                                        setTimeout(() => setSmtpPassSaved(false), 3000);
                                        fetchSettings();
                                    } catch (err) {
                                        console.error('Error saving SMTP password:', err);
                                        setSmtpPassError(err.message || 'Failed to save');
                                    }
                                }}
                                disabled={!newSmtpPass}
                                style={{ padding: '8px 16px', backgroundColor: '#4a90e2', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: !newSmtpPass ? 0.6 : 1 }}
                            >
                                Save SMTP Password
                            </button>
                        </div>
                        {smtpPassError && <div style={{ color: 'red', marginTop: '5px', fontSize: '0.9rem' }}>{smtpPassError}</div>}
                        {smtpPassSaved && <div style={{ color: 'green', marginTop: '5px', fontSize: '0.9rem' }}>SMTP Password Saved!</div>}
                    </div>
                </details>

                <button
                    className={`test-email-btn ${testStatus}`}
                    onClick={sendTestEmail}
                    disabled={testStatus === 'sending'}
                >
                    {testStatus === 'sending' ? '📤 Sending...' :
                        testStatus === 'success' ? '✅ Sent!' :
                            testStatus === 'error' ? '❌ Failed' :
                                '📧 Send Test Email'}
                </button>
            </div>

            {/* Ntfy Notifications */}
            <div className="options-section">
                <h3>🔔 Ntfy Notifications (Priority Alerts)</h3>
                <p className="options-description">
                    Receive high-priority alerts on your phone using the free <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer" style={{ color: '#4a90e2' }}>ntfy app</a>.
                    Set a unique topic name below and subscribe to it in the app.
                </p>

                <div className="option-row">
                    <label>
                        <input
                            type="checkbox"
                            name="ntfyEnabled"
                            checked={settings.ntfyEnabled || false}
                            onChange={handleChange}
                        />
                        Enable Ntfy notifications
                    </label>
                </div>

                <div className="option-row">
                    <label>Topic Name:</label>
                    <input
                        type="text"
                        name="ntfyTopic"
                        value={settings.ntfyTopic || ''}
                        onChange={handleChange}
                        placeholder="e.g. secret-gkwatch-alerts"
                        className="option-input"
                    />
                </div>
                <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '-5px', marginBottom: '10px' }}>
                    Subscribe to <code>ntfy.sh/your-topic-name</code> in the app. Keep this secret!
                </p>

                <div className="option-row">
                    <label>Server URL:</label>
                    <input
                        type="text"
                        name="ntfyServer"
                        value={settings.ntfyServer || 'https://ntfy.sh'}
                        onChange={handleChange}
                        placeholder="https://ntfy.sh"
                        className="option-input"
                    />
                </div>

                <button
                    className={`test-email-btn ${ntfyTestStatus}`}
                    onClick={sendTestNtfy}
                    disabled={ntfyTestStatus === 'sending' || !settings.ntfyTopic}
                    style={{ marginTop: '10px' }}
                >
                    {ntfyTestStatus === 'sending' ? '📤 Sending...' :
                        ntfyTestStatus === 'success' ? '✅ Sent!' :
                            ntfyTestStatus === 'error' ? '❌ Failed' :
                                '🔔 Send Test Notification (Priority 5)'}
                </button>
            </div>

            {/* Login Protection */}
            <div className="options-section">
                <h3>🔐 Login Protection</h3>
                <p className="options-description">
                    Require a password to access this application.
                </p>

                <div className="login-control" style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center' }}>
                        <input
                            type="checkbox"
                            checked={settings.loginEnabled || false}
                            name="loginEnabled"
                            onChange={handleChange}
                            style={{ marginRight: '10px' }}
                        />
                        Enable Login Protection (Requires saved password)
                    </label>
                </div>

                <div className="setting-group" style={{ marginLeft: '1.5rem', background: '#2a2a2a', padding: '15px', borderRadius: '8px' }}>
                    <p style={{ fontSize: '0.9rem', color: '#aaa', marginBottom: '0.5rem' }}>
                        {settings.hasLoginPassword ? '✅ Password is currently set.' : '⚠️ No password set.'}
                    </p>

                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => {
                                setNewPassword(e.target.value);
                                setPasswordError('');
                            }}
                            placeholder="Set New Password (Min 5 Characters)"
                            className="settings-input"
                            style={{ flex: '1', minWidth: '200px' }}
                        />
                        <button
                            className="save-btn small"
                            onClick={savePassword}
                            disabled={!newPassword || newPassword.length < 5}
                            style={{ padding: '8px 16px', backgroundColor: '#4a90e2', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: (!newPassword || newPassword.length < 5) ? 0.6 : 1 }}
                        >
                            Save Password
                        </button>
                    </div>
                    {passwordError && <div style={{ color: 'red', marginTop: '5px', fontSize: '0.9rem' }}>{passwordError}</div>}
                    {passwordSaved && <div style={{ color: 'green', marginTop: '5px', fontSize: '0.9rem' }}>Password Saved Successfully!</div>}
                </div>
            </div>

            <div className="options-section">
                <h3>📋 Watchlist Backup</h3>
                <p className="options-description">
                    Export your watchlist to a text file or import terms from a file.
                    Format: One search term per line.
                </p>

                <div className="backup-buttons">
                    <button className="backup-btn export-btn" onClick={exportWatchlist}>
                        📤 Export Watchlist
                    </button>

                    <label className="backup-btn import-btn">
                        📥 Import Watchlist
                        <input
                            type="file"
                            accept=".txt"
                            onChange={importWatchlist}
                            style={{ display: 'none' }}
                        />
                    </label>
                </div>
            </div>

            {/* System Maintenance */}
            <div className="options-section">
                <h3>🛠️ System Maintenance</h3>
                <p className="options-description">
                    Manually trigger system cleanup to rotate logs, remove expired results, and clear temporary files.
                </p>

                <div className="option-row">
                    <button
                        className={`save-btn ${cleanupStatus === 'cleaning' ? 'disabled' : ''}`}
                        onClick={runManualCleanup}
                        disabled={cleanupStatus === 'cleaning'}
                        style={{ backgroundColor: cleanupStatus === 'error' ? '#ef5350' : '#4a90e2' }}
                    >
                        {cleanupStatus === 'cleaning' ? '🧹 Cleaning System...' : '🧹 Clean System Now'}
                    </button>
                    {cleanupMessage && (
                        <div style={{ marginTop: '10px', fontSize: '0.9rem', color: cleanupStatus === 'success' ? '#66bb6a' : (cleanupStatus === 'error' ? '#ef5350' : '#ddd') }}>
                            {cleanupMessage}
                        </div>
                    )}
                </div>
            </div>

            {saved && (
                <div className="auto-save-indicator">✓ Settings saved</div>
            )}
        </div>
    );
};

export default OptionsManager;
