import React from 'react';

const ResultCard = ({ item, onBlock, isNew }) => {
    const { title, link, image, price, source } = item;

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

    return (
        <a href={link} target="_blank" rel="noopener noreferrer" className={`result-card ${isNew ? 'is-new' : ''}`}>
            {isNew && <span className="new-ribbon">NEW</span>}
            {onBlock && (
                <button className="block-btn" onClick={handleBlock} title="Permanently Block">🚫</button>
            )}
            <button className="fj-btn" onClick={handleFromJapan} title="Open in FromJapan">🛒</button>
            <div className="card-image-container">
                {image ? (
                    <img src={image} alt={title} className="card-image" loading="lazy" />
                ) : (
                    <div className="no-image">No Image</div>
                )}
                <span className={`source-badge ${source.toLowerCase().replace(/\s+/g, '-')}`}>
                    {source}
                </span>
            </div>
            <div className="card-content">
                <h3 className="card-title" title={title}>{title}</h3>
                <div className="card-price">
                    {item.bidPrice && item.binPrice ? (
                        // Yahoo item with both auction and buy-it-now prices
                        <>
                            <span className="price-bid" title="Current Bid">🔨 {item.bidPrice}</span>
                            <span className="price-bin" title="Buy It Now">🛒 {item.binPrice}</span>
                        </>
                    ) : source && source.toLowerCase().includes('yahoo') ? (
                        // Yahoo item - show gavel for auction price
                        <span className="price-bid" title="Current Bid">🔨 {price}</span>
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
