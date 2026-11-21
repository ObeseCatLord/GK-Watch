import React from 'react';
import Icon from './Icon';

const availablePrice = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text && !/^n\/?a$/i.test(text) ? text : null;
};

const ResultCard = ({ item, onBlock, onFavoriteToggle, isNew }) => {
    const { title, image, price, source, endTime } = item;
    const sourceClass = (source || '').trim().toLowerCase().replace(/\s+/g, '-');
    const link = item.link || item.url;
    const listedPrice = availablePrice(price);
    const explicitBid = availablePrice(item.bidPrice);
    const explicitBuy = availablePrice(item.binPrice);
    const isAuction = /yahoo/i.test(source || '') || Boolean(explicitBid);
    const bid = explicitBid || (isAuction && !explicitBuy ? listedPrice : null);
    const buy = explicitBuy || (isAuction ? null : listedPrice);
    const [failedImage, setFailedImage] = React.useState(null);
    const [timeLeft, setTimeLeft] = React.useState('');
    const isUpdated = item.isUpdated || item.newType === 'updated';
    const showStatusRibbon = isNew || isUpdated;

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
        window.open(fjUrl, '_blank', 'noopener,noreferrer');
    };

    const handleFavoriteToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onFavoriteToggle) {
            onFavoriteToggle(item);
        }
    };

    return (
        <article className="listing">
            <a href={link} target="_blank" rel="noopener noreferrer" className={`result-card ${showStatusRibbon ? 'is-new' : ''} ${isUpdated ? 'is-updated' : ''}`}>
                <div className="card-image-container">
                    {image && image !== failedImage ? (
                        <img src={image} alt="" className="card-image" loading="lazy" decoding="async"
                            referrerPolicy="no-referrer" onError={() => setFailedImage(image)} />
                    ) : (
                        <span className="no-image">No image</span>
                    )}
                    {showStatusRibbon && (
                        <span className={`new-ribbon ${isUpdated ? 'updated-ribbon' : ''}`}>
                            {isUpdated ? 'Updated' : 'New'}
                        </span>
                    )}
                </div>
                <div className="card-content">
                    <div className="card-meta">
                        <span className={`source-badge ${sourceClass}`}>{source || 'Unknown source'}</span>
                        {timeLeft && <span title="Time remaining">{timeLeft}</span>}
                    </div>
                    <h3 className="card-title" title={title}>{title}</h3>
                    {(bid || buy) && (
                        <div className="card-price">
                            {bid && <span className="bid-price">{bid} <small>bid</small></span>}
                            {buy && <span className="buy-price">{buy} <small>buy</small></span>}
                        </div>
                    )}
                </div>
            </a>
            <div className="listing-actions">
                {onFavoriteToggle && (
                    <button type="button" className={`favorite-btn ${item.isFavorite ? 'active' : ''}`}
                        onClick={handleFavoriteToggle} aria-pressed={Boolean(item.isFavorite)}
                        title={item.isFavorite ? 'Remove favorite' : 'Add favorite'}
                        aria-label={item.isFavorite ? 'Remove favorite' : 'Add favorite'}
                    >
                        <Icon name={item.isFavorite ? 'favorite' : 'unfavorite'} />
                    </button>
                )}
                {link && (
                    <button type="button" className="fj-btn" onClick={handleFromJapan}
                        title="Open in FromJapan" aria-label="Open in FromJapan"><Icon name="external" /></button>
                )}
                {onBlock && (
                    <button type="button" className="block-btn" onClick={handleBlock}
                        title="Permanently block" aria-label="Permanently block"><Icon name="block" /></button>
                )}
            </div>
        </article>
    );
};

export default React.memo(ResultCard);
