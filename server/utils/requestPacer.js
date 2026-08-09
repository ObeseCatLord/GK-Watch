'use strict';

const { performance } = require('node:perf_hooks');

class RequestPacerAbortError extends Error {
    constructor(name) {
        super(`${name} request was aborted before it could start`);
        this.name = 'AbortError';
        this.code = 'ABORT_ERR';
    }
}

class RequestPacerLimitError extends Error {
    constructor(name) {
        super(`${name} pacing queue is full`);
        this.name = 'RequestPacerLimitError';
        this.code = 'PACE_LIMIT';
    }
}

class RequestPacerClosedError extends Error {
    constructor(name) {
        super(`${name} pacer is closed`);
        this.name = 'RequestPacerClosedError';
        this.code = 'PACE_CLOSED';
    }
}

class RequestPacer {
    constructor({ name, minTimeMs, maxQueue }) {
        if (!name || !Number.isInteger(minTimeMs) || minTimeMs < 0) {
            throw new TypeError('Invalid request pacer configuration');
        }
        if (!Number.isInteger(maxQueue) || maxQueue < 0) {
            throw new TypeError('Invalid request pacer queue limit');
        }

        this.name = name;
        this.minTimeMs = minTimeMs;
        this.maxQueue = maxQueue;
        this.active = 0;
        this.queue = [];
        this.timer = null;
        this.lastStartedAt = Number.NEGATIVE_INFINITY;
        this.rejected = 0;
        this.closed = false;
    }

    schedule(task, { signal } = {}) {
        if (typeof task !== 'function') {
            return Promise.reject(new TypeError('Paced request must be a function'));
        }
        if (this.closed) {
            return Promise.reject(new RequestPacerClosedError(this.name));
        }
        if (signal?.aborted) {
            return Promise.reject(new RequestPacerAbortError(this.name));
        }
        const mustWait = this.active > 0 || this.timer || this.queue.length > 0;
        if (mustWait && this.queue.length >= this.maxQueue) {
            this.rejected += 1;
            return Promise.reject(new RequestPacerLimitError(this.name));
        }

        return new Promise((resolve, reject) => {
            const entry = { task, resolve, reject, signal, started: false, abortHandler: null };
            entry.abortHandler = () => {
                if (entry.started) return;
                const index = this.queue.indexOf(entry);
                if (index === -1) return;
                this.queue.splice(index, 1);
                signal.removeEventListener('abort', entry.abortHandler);
                reject(new RequestPacerAbortError(this.name));
                this.#reschedule();
            };
            signal?.addEventListener('abort', entry.abortHandler, { once: true });
            this.queue.push(entry);
            this.#drain();
        });
    }

    stats() {
        return {
            name: this.name,
            active: this.active,
            queued: this.queue.length,
            minTimeMs: this.minTimeMs,
            maxQueue: this.maxQueue,
            rejected: this.rejected,
            closed: this.closed
        };
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const error = new RequestPacerClosedError(this.name);
        for (const entry of this.queue.splice(0)) {
            entry.signal?.removeEventListener('abort', entry.abortHandler);
            entry.reject(error);
        }
    }

    #reschedule() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.#drain();
    }

    #drain() {
        if (this.closed || this.active > 0 || this.timer || this.queue.length === 0) return;

        const waitMs = Math.max(0, this.lastStartedAt + this.minTimeMs - performance.now());
        if (waitMs > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.#drain();
            }, waitMs);
            this.timer.unref?.();
            return;
        }

        const entry = this.queue.shift();
        entry.started = true;
        entry.signal?.removeEventListener('abort', entry.abortHandler);
        this.active = 1;
        this.lastStartedAt = performance.now();

        Promise.resolve()
            .then(entry.task)
            .then(
                value => this.#finish(entry, true, value),
                error => this.#finish(entry, false, error)
            );
    }

    #finish(entry, succeeded, value) {
        this.active = 0;
        if (succeeded) entry.resolve(value);
        else entry.reject(value);
        this.#drain();
    }
}

module.exports = {
    RequestPacer,
    RequestPacerAbortError,
    RequestPacerLimitError,
    RequestPacerClosedError
};
