import React from 'react';

const ResultCard = ({ item, onBlock, isNew }) => {
    const { title, link, image, price, source, endTime } = item;
    const [timeLeft, setTimeLeft] = React.useState('');

    React.useEffect(() => {
        if (!endTime) return;

        const updateTimer = () => {
            const now = Date.now();
            const end = new Date(endTime).getTime();
            const diff = end - now;

            if (diff <= 0) {
                setTimeLeft('Ended');
                return;
            }

            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) {
                setTimeLeft(`${days}d ${hours}h`);
            } else if (hours > 0) {
                setTimeLeft(`${hours}h ${minutes}m`);
            } else {
                setTimeLeft(`${minutes}m`);
            }
        };

        updateTimer();
        const interval = setInterval(updateTimer, 60000); // 1 minute interval

        return () => clearInterval(interval);
    }, [endTime]);


    const handleBlock = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.confirm('Permanently block this item?')) {
            onBlock(item);
        }
    };

    const handleFromJapan = (e) => {
        e.preventDefault();
        e.stopPropagation();

        let fjUrl;
        if (link.includes('auctions.yahoo.co.jp')) {
            // Yahoo Auctions specific format
            fjUrl = `https://www.fromjapan.co.jp/japan/en/auction/yahoo/input/${encodeURIComponent(link)}`;
        } else {
            // Other sites (Mercari, PayPay, Fril, etc.)
            fjUrl = `https://www.fromjapan.co.jp/japan/en/special/order/confirm/${encodeURIComponent(link)}/13_1/`;
        }
        window.open(fjUrl, '_blank');
    };

    const safelyGetSource = () => {
        return (source || 'Unknown').toString();
    };

    return (
        <a href={link} target="_blank" rel="noopener noreferrer" className={`result-card ${isNew ? 'is-new' : ''}`}>
            {isNew && <span className="new-ribbon">NEW</span>}
            {onBlock && (
                <button className="block-btn" onClick={handleBlock} title="Permanently Block">🚫</button>
            )}
            <button className="fj-btn" onClick={handleFromJapan} title="Open in FromJapan">🛒</button>
            <div className="card-image-container">
                {image ? (
                    <img src={image} alt={title} className="card-image" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                    <div className="no-image">No Image</div>
                )}
                <span className={`source-badge ${safelyGetSource().toLowerCase().replace(/\s+/g, '-')}`}>
                    {safelyGetSource()}
                </span>
                {timeLeft && (
                    <span className="time-badge" title="Time Remaining">
                        ⏱ {timeLeft}
                    </span>
                )}
            </div>
            <div className="card-content">
                <h3 className="card-title" title={title}>{title}</h3>
                <div className="card-price">
                    {item.bidPrice && item.binPrice ? (
                        // Yahoo item with both auction and buy-it-now prices
                        <>
                            <span className="price-bid" title="Current Bid">{item.bidPrice} 🔨</span>
                            <span className="price-bin" title="Buy It Now">{item.binPrice} 🛒</span>
                        </>
                    ) : source && source.toLowerCase().includes('yahoo') ? (
                        // Yahoo item - show gavel for auction price
                        <span className="price-bid" title="Current Bid">{price} 🔨</span>
                    ) : (
                        // Other sources - simple price
                        <span>{price}</span>
                    )}
                </div>
            </div>
        </a>
    );
};

export default ResultCard;
