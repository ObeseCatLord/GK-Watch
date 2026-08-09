'use strict';

class AdmissionLimitError extends Error {
    constructor(poolName) {
        super(`${poolName} capacity is full; try again shortly`);
        this.name = 'AdmissionLimitError';
        this.code = 'ADMISSION_LIMIT';
        this.statusCode = 503;
    }
}

class AdmissionAbortError extends Error {
    constructor(poolName) {
        super(`${poolName} task was aborted before it could start`);
        this.name = 'AbortError';
        this.code = 'ABORT_ERR';
    }
}

class AdmissionController {
    constructor({ name, maxConcurrent, maxQueue }) {
        if (!name || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 ||
            !Number.isInteger(maxQueue) || maxQueue < 0) {
            throw new TypeError('Invalid admission controller configuration');
        }

        this.name = name;
        this.maxConcurrent = maxConcurrent;
        this.maxQueue = maxQueue;
        this.active = 0;
        this.queue = [];
        this.rejected = 0;
    }

    run(task, { signal } = {}) {
        if (typeof task !== 'function') {
            return Promise.reject(new TypeError('Admission task must be a function'));
        }

        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new AdmissionAbortError(this.name));
                return;
            }

            const entry = { task, resolve, reject, signal, started: false, abortHandler: null };
            entry.abortHandler = () => {
                if (entry.started) return;
                const index = this.queue.indexOf(entry);
                if (index === -1) return;
                this.queue.splice(index, 1);
                signal.removeEventListener('abort', entry.abortHandler);
                reject(new AdmissionAbortError(this.name));
            };
            signal?.addEventListener('abort', entry.abortHandler, { once: true });

            if (this.active < this.maxConcurrent) {
                this.#start(entry);
                return;
            }

            if (this.queue.length >= this.maxQueue) {
                this.rejected += 1;
                signal?.removeEventListener('abort', entry.abortHandler);
                reject(new AdmissionLimitError(this.name));
                return;
            }

            this.queue.push(entry);
        });
    }

    stats() {
        return {
            name: this.name,
            active: this.active,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            maxQueue: this.maxQueue,
            rejected: this.rejected
        };
    }

    #start(entry) {
        if (entry.signal?.aborted) {
            entry.signal.removeEventListener('abort', entry.abortHandler);
            entry.reject(new AdmissionAbortError(this.name));
            const next = this.queue.shift();
            if (next) this.#start(next);
            return;
        }

        entry.started = true;
        entry.signal?.removeEventListener('abort', entry.abortHandler);
        this.active += 1;
        Promise.resolve()
            .then(() => entry.task(entry.signal))
            .then(
                value => this.#finish(entry, true, value),
                error => this.#finish(entry, false, error)
            );
    }

    #finish(entry, succeeded, value) {
        this.active -= 1;
        const next = this.queue.shift();
        if (next) this.#start(next);
        if (succeeded) entry.resolve(value);
        else entry.reject(value);
    }
}

function envInteger(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        console.warn(`[Admission] Ignoring invalid ${name}; expected integer ${min}-${max}`);
        return fallback;
    }
    return value;
}

const searchPool = new AdmissionController({
    name: 'Search',
    maxConcurrent: envInteger('GKWATCH_SEARCH_CONCURRENCY', 3, 1, 10),
    maxQueue: envInteger('GKWATCH_SEARCH_QUEUE', 24, 0, 200)
});

const httpPool = new AdmissionController({
    name: 'HTTP scraper',
    maxConcurrent: envInteger('GKWATCH_HTTP_CONCURRENCY', 6, 1, 30),
    maxQueue: envInteger('GKWATCH_HTTP_QUEUE', 64, 0, 500)
});

const mercariFreshnessPool = new AdmissionController({
    name: 'Mercari freshness',
    maxConcurrent: envInteger('GKWATCH_MERCARI_FRESHNESS_CONCURRENCY', 2, 1, 4),
    maxQueue: envInteger('GKWATCH_MERCARI_FRESHNESS_QUEUE', 24, 0, 100)
});

const browserPool = new AdmissionController({
    name: 'Browser scraper',
    maxConcurrent: envInteger('GKWATCH_BROWSER_CONCURRENCY', 2, 1, 6),
    maxQueue: envInteger('GKWATCH_BROWSER_QUEUE', 16, 0, 100)
});

module.exports = {
    AdmissionController,
    AdmissionLimitError,
    AdmissionAbortError,
    searchPool,
    httpPool,
    mercariFreshnessPool,
    browserPool
};
