const db = require('./database');
const crypto = require('crypto');

const stmts = {
    getAll: db.prepare(`
        SELECT id, url, title, image, price, bid_price as bidPrice, bin_price as binPrice,
               source, favorited_at as favoritedAt, updated_at as updatedAt
        FROM favorite_items
        ORDER BY favorited_at DESC
    `),
    insert: db.prepare(`
        INSERT OR IGNORE INTO favorite_items
        (id, url, title, image, price, bid_price, bin_price, source, favorited_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    remove: db.prepare('DELETE FROM favorite_items WHERE id = ?'),
    removeByUrl: db.prepare('DELETE FROM favorite_items WHERE url = ?'),
    clearMissingFromResults: db.prepare(`
        DELETE FROM favorite_items
        WHERE NOT EXISTS (
            SELECT 1
            FROM results
            WHERE results.link = favorite_items.url
              AND results.hidden = 0
        )
    `),
    findByUrl: db.prepare(`
        SELECT id, url, title, image, price, bid_price as bidPrice, bin_price as binPrice,
               source, favorited_at as favoritedAt, updated_at as updatedAt
        FROM favorite_items
        WHERE url = ?
    `),
    updateSnapshot: db.prepare(`
        UPDATE favorite_items
        SET title = ?, image = ?, price = ?, bid_price = ?, bin_price = ?, source = ?, updated_at = ?
        WHERE url = ?
    `)
};

let cachedItems = null;

function normalizePrice(value) {
    return String(value || '').trim();
}

function snapshotFromItem(item = {}) {
    return {
        price: normalizePrice(item.price),
        bidPrice: normalizePrice(item.bidPrice),
        binPrice: normalizePrice(item.binPrice)
    };
}

function displayPrice(item = {}) {
    const snapshot = snapshotFromItem(item);
    if (snapshot.bidPrice && snapshot.binPrice) {
        return `${snapshot.bidPrice} / ${snapshot.binPrice}`;
    }
    return snapshot.price || snapshot.bidPrice || snapshot.binPrice || 'N/A';
}

function loadCache() {
    if (cachedItems) return cachedItems;
    cachedItems = stmts.getAll.all();
    return cachedItems;
}

function invalidateCache() {
    cachedItems = null;
}

function add(url, title, image, price, source, bidPrice, binPrice) {
    if (!url) return null;

    const existing = stmts.findByUrl.get(url);
    if (existing) return { ...existing };

    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const normalized = {
        title: title || '',
        image: image || '',
        price: price || '',
        bidPrice: bidPrice || '',
        binPrice: binPrice || '',
        source: source || ''
    };

    stmts.insert.run(
        id,
        url,
        normalized.title,
        normalized.image,
        normalized.price,
        normalized.bidPrice,
        normalized.binPrice,
        normalized.source,
        now,
        now
    );
    invalidateCache();

    return {
        id,
        url,
        ...normalized,
        favoritedAt: now,
        updatedAt: now
    };
}

const FavoriteItems = {
    getAll: () => {
        const list = loadCache();
        return list.map(item => ({ ...item }));
    },

    add,

    remove: (id) => {
        stmts.remove.run(id);
        invalidateCache();
    },

    removeByUrl: (url) => {
        if (!url) return;
        stmts.removeByUrl.run(url);
        invalidateCache();
    },

    clearMissingFromResults: () => {
        const result = stmts.clearMissingFromResults.run();
        invalidateCache();
        return result.changes || 0;
    },

    toggle: (item = {}) => {
        const url = item.link || item.url;
        if (!url) return { favorite: false, item: null };

        const existing = stmts.findByUrl.get(url);
        if (existing) {
            stmts.removeByUrl.run(url);
            invalidateCache();
            return { favorite: false, item: null };
        }

        const favorite = add(url, item.title, item.image, item.price, item.source, item.bidPrice, item.binPrice);
        return { favorite: true, item: favorite };
    },

    isFavorite: (url) => {
        if (!url) return false;
        return !!stmts.findByUrl.get(url);
    },

    annotateResults: (results) => {
        if (!results || results.length === 0) return results;
        const favorites = loadCache();
        if (favorites.length === 0) {
            return results.map(result => ({ ...result, isFavorite: false }));
        }

        const favoriteUrls = new Set(favorites.map(item => item.url));
        return results.map(result => {
            const link = result.link || result.url;
            return { ...result, isFavorite: favoriteUrls.has(link) };
        });
    },

    getByUrlMap: () => {
        const favorites = loadCache();
        return new Map(favorites.map(item => [item.url, { ...item }]));
    },

    getPriceUpdateForResult: (result, favorite) => {
        if (!result || !favorite) return null;

        const oldSnapshot = snapshotFromItem(favorite);
        const newSnapshot = snapshotFromItem(result);
        const hasTrackedOldPrice = oldSnapshot.price || oldSnapshot.bidPrice || oldSnapshot.binPrice;
        const hasTrackedNewPrice = newSnapshot.price || newSnapshot.bidPrice || newSnapshot.binPrice;

        if (!hasTrackedOldPrice || !hasTrackedNewPrice) return null;

        const changed = oldSnapshot.price !== newSnapshot.price ||
            oldSnapshot.bidPrice !== newSnapshot.bidPrice ||
            oldSnapshot.binPrice !== newSnapshot.binPrice;

        if (!changed) return null;

        return {
            ...result,
            isFavorite: true,
            isPriceUpdate: true,
            oldPrice: displayPrice(favorite),
            newPrice: displayPrice(result)
        };
    },

    updateSnapshotFromResult: (result) => {
        if (!result || !result.link) return;
        const now = new Date().toISOString();
        stmts.updateSnapshot.run(
            result.title || '',
            result.image || '',
            result.price || '',
            result.bidPrice || '',
            result.binPrice || '',
            result.source || '',
            now,
            result.link
        );
        invalidateCache();
    },

    _resetCache: () => {
        cachedItems = null;
    }
};

module.exports = FavoriteItems;
