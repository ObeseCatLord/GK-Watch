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
    const [showPassword, setShowPassword] = useState(false);
    const [showLoginPassword, setShowLoginPassword] = useState(false);
    const [enabledHours, setEnabledHours] = useState([]);
    const saveTimeoutRef = React.useRef(null);

    const [timeZoneName, setTimeZoneName] = useState('Local');

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
                await fetch('/api/settings', {
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

    const exportWatchlist = async () => {
        try {
            // Fetch all data
            const [watchlistRes, blacklistRes, blockedRes] = await Promise.all([
                fetch('/api/watchlist'),
                fetch('/api/blacklist'),
                fetch('/api/blocked')
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
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (lines.length === 0) {
                alert('No terms found in file');
                return;
            }

            let added = 0;
            for (const line of lines) {
                try {
                    const terms = line.split(',').map(t => t.trim()).filter(t => t);
                    if (terms.length > 0) {
                        await fetch('/api/watchlist', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                term: terms[0], // for compatibility/name fallback
                                terms: terms
                            })
                        });
                        added++;
                    }
                } catch (err) {
                    console.error(`Failed to add line: ${line}`, err);
                }
            }

            alert(`Imported ${added} of ${lines.length} items!`);
            e.target.value = ''; // Reset file input
        } catch (err) {
            console.error('Error importing watchlist:', err);
            alert('Failed to import watchlist');
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

                    <div className="setting-group">
                        <label>SMTP Password:</label>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            <input
                                type={showPassword ? 'text' : 'password'}
                                name="smtpPass"
                                value={settings.smtpPass || ''}
                                onChange={handleChange}
                                placeholder={settings.hasSmtpPass ? "Change password..." : "Enter password"}
                                className="settings-input"
                            />
                            <button
                                className="icon-btn"
                                onClick={() => setShowPassword(!showPassword)}
                                title={showPassword ? "Hide" : "Show"}
                            >
                                {showPassword ? '👁️' : '🔒'}
                            </button>
                        </div>
                        {settings.hasSmtpPass && <small>Password is set. Enter new one to change.</small>}
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
                            name="loginEnabled"
                            checked={settings.loginEnabled}
                            onChange={handleChange}
                            style={{ marginRight: '10px' }}
                        />
                        Enable Login Protection (Required on site visit)
                    </label>
                </div>

                {settings.loginEnabled && (
                    <div className="setting-group" style={{ marginLeft: '1.5rem' }}>
                        <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
                            {settings.hasLoginPassword ? 'Password is currently set.' : 'No password set!'}
                        </p>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            <input
                                type={showLoginPassword ? 'text' : 'password'}
                                name="loginPassword"
                                value={settings.loginPassword || ''}
                                onChange={handleChange}
                                placeholder="Enter new password to change"
                                className="settings-input"
                            />
                            <button
                                className="icon-btn"
                                onClick={() => setShowLoginPassword(!showLoginPassword)}
                                title={showLoginPassword ? "Hide" : "Show"}
                            >
                                {showLoginPassword ? '👁️' : '🔒'}
                            </button>
                        </div>
                        <small>Leave blank to keep current password.</small>
                    </div>
                )}
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
