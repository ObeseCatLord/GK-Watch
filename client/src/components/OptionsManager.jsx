import React, { useState, useEffect } from 'react';

const OptionsManager = ({ authenticatedFetch }) => {
    const [settings, setSettings] = useState({
        email: '',
        emailEnabled: false,
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
    const [showPassword, setShowPassword] = useState(false);
    const [showLoginPassword, setShowLoginPassword] = useState(false);
    const [enabledHours, setEnabledHours] = useState([]);
    const saveTimeoutRef = React.useRef(null);

    const [timeZoneName, setTimeZoneName] = useState('Local');

    // Password State
    const [newPassword, setNewPassword] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [passwordSaved, setPasswordSaved] = useState(false);

    // SMTP Password State
    const [newSmtpPass, setNewSmtpPass] = useState('');
    const [smtpPassError, setSmtpPassError] = useState('');
    const [smtpPassSaved, setSmtpPassSaved] = useState(false);

    useEffect(() => {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
                .formatToParts(new Date());
            const tz = parts.find(p => p.type === 'timeZoneName');
            if (tz) setTimeZoneName(tz.value);
        } catch (e) {
            console.error('Error getting timezone:', e);
        }

        fetchSettings();
        fetchSchedule();
    }, []);




    const fetchSettings = async () => {
        try {
            const res = await authenticatedFetch('/api/settings');
            const data = await res.json();
            setSettings(data);
        } catch (err) {
            console.error('Error fetching settings:', err);
        }
    };

    const fetchSchedule = async () => {
        try {
            const res = await authenticatedFetch('/api/schedule');
            const data = await res.json();
            setEnabledHours(data.enabledHours || []);
        } catch (err) {
            console.error('Error fetching schedule:', err);
        }
    };

    const toggleHour = async (hour) => {
        const newHours = enabledHours.includes(hour)
            ? enabledHours.filter(h => h !== hour)
            : [...enabledHours, hour].sort((a, b) => a - b);

        setEnabledHours(newHours);

        try {
            await authenticatedFetch('/api/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabledHours: newHours })
            });
        } catch (err) {
            console.error('Error saving schedule:', err);
        }
    };

    const jstToLocal = (jstHour) => {
        // JST is UTC+9
        // Calculate offset difference between Local and JST
        const offset = -new Date().getTimezoneOffset() / 60;
        const diff = offset - 9;
        let localHour = (jstHour + diff) % 24;
        if (localHour < 0) localHour += 24;
        return Math.floor(localHour);
    };

    const savePassword = async () => {
        if (!newPassword) {
            setPasswordError('Password cannot be empty');
            return;
        }
        if (newPassword.length < 5) {
            setPasswordError('Password must be at least 5 characters');
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

        // Auto-save with debounce
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

    const saveSettings = async () => {
        try {
            // When manually saving, we need to ensure we send the current state,
            // and handle potential missing password data.
            const settingsToSave = { ...settings };
            // If smtpPass or loginPassword are empty, it means the user didn't change them,
            // so we should not send an empty string to overwrite existing passwords.
            // The backend should handle this by ignoring empty password fields if they were not explicitly changed.
            // For now, we'll just send the current state. The backend logic will need to be robust.

            await authenticatedFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settingsToSave)
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            console.error('Error saving settings:', err);
            alert('Failed to save settings');
        }
    };

    const sendTestEmail = async () => {
        if (!settings.email) {
            alert('Please enter an email address first');
            return;
        }

        setTestStatus('sending');
        try {
            const res = await fetch('/api/settings/test-email', {
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
            const [watchlistRes, blacklistRes, blockedRes] = await Promise.all([
                authenticatedFetch('/api/watchlist'),
                authenticatedFetch('/api/blacklist'),
                authenticatedFetch('/api/blocked')
            ]);

            const watchlist = await watchlistRes.json();
            const blacklist = await blacklistRes.json();
            const blocked = await blockedRes.json();

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
            } catch (e) {
                // Not JSON, fall back to text lines
                isJson = false;
            }

            let added = 0;
            let errors = 0;
            let firstError = null;

            if (isJson) {
                // Handle JSON Backup Import
                const { watchlist, blacklist, blockedItems } = importData;

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

    return (
        <div className="options-container">
            <h2>Options</h2>

            {/* Schedule Picker */}
            <div className="options-section">
                <h3>⏰ Search Schedule</h3>
                <p className="options-description">
                    Click hours to toggle when automatic searches run (JST / {timeZoneName} displayed).
                </p>
                <div className="hour-grid">
                    {Array.from({ length: 24 }, (_, i) => (
                        <button
                            key={i}
                            className={`hour-btn ${enabledHours.includes(i) ? 'active' : ''}`}
                            onClick={() => toggleHour(i)}
                            title={`JST ${i}:00 / ${timeZoneName} ${jstToLocal(i)}:00`}
                        >
                            <span className="jst-hour">{i}:00 JST</span>
                            <span className="cst-hour">{jstToLocal(i)}:00 {timeZoneName}</span>
                        </button>
                    ))}
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

            {saved && (
                <div className="auto-save-indicator">✓ Settings saved</div>
            )}
        </div>
    );
};

export default OptionsManager;
