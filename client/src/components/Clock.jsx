import React, { useState, useEffect } from 'react';

const Clock = () => {
    const [time, setTime] = useState(new Date());
    const [countdown, setCountdown] = useState(null);
    const [isRunning, setIsRunning] = useState(false);

    useEffect(() => {
        const timer = setInterval(() => {
            setTime(new Date());
        }, 1000);

        return () => clearInterval(timer);
    }, []);

    // Fetch status for countdown and running state
    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                setIsRunning(data.isRunning);
                setCountdown(data.minutesUntilNext);
            } catch (err) {
                console.error('Error fetching status:', err);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 30000); // Update every 30 seconds
        return () => clearInterval(interval);
    }, []);

    // Format countdown as HH:MM:SS
    const formatCountdown = (minutes) => {
        if (minutes === null || minutes === undefined) return null;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        // Estimate seconds based on current time (countdown between 0-59)
        const secs = 59 - time.getSeconds();
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    // Format for JST (Japan Standard Time)
    const jstTime = time.toLocaleString('en-US', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    // Format for Local Time
    const localTime = time.toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const [timeZoneName, setTimeZoneName] = useState('Local');

    useEffect(() => {
        try {
            // Extract short timezone name (e.g., CST, EST, JST)
            const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
                .formatToParts(new Date());
            const tz = parts.find(p => p.type === 'timeZoneName');
            if (tz) setTimeZoneName(tz.value);
        } catch (e) {
            console.error('Error getting timezone:', e);
        }
    }, []);

    return (
        <div className="clock-container">
            <div className="clock-item">
                <span className="clock-label">JST</span>
                <span className="clock-time">{jstTime}</span>
            </div>
            <div className="clock-divider">|</div>
            <div className="clock-item">
                <span className="clock-label">{timeZoneName}</span>
                <span className="clock-time">{localTime}</span>
            </div>
            {countdown !== null && (
                <>
                    <div className="clock-divider">|</div>
                    <div className="clock-item">
                        <span className="clock-label">{isRunning ? 'Running' : 'Next'}</span>
                        <span className="clock-time">{isRunning ? '🔄' : formatCountdown(countdown)}</span>
                    </div>
                </>
            )}
        </div>
    );
};

export default Clock;
