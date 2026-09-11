// Minimal in-memory IndexedDB stand-in for the host-layer tests.
//
// html/projectm-preset-cache.js and html/projectm-shader-cache.js are pure
// IndexedDB code — every exported function opens a database, runs one
// transaction and resolves off a request/transaction event. Under Node there
// is no `indexedDB`, so before this helper existed both modules were only
// reachable through the handful of branches that bail out early, which is why
// they sat at ~45% line coverage with no test file of their own.
//
// This implements just the surface those two modules use:
//
//   indexedDB.open(name, version)  -> onupgradeneeded / onsuccess / onerror
//   db.objectStoreNames.contains() / db.createObjectStore({ keyPath })
//   db.transaction(store, mode)    -> oncomplete / onerror
//   store.get / put / delete / clear / openCursor
//
// Semantics that the modules under test actually depend on, and that a
// stub therefore has to get right rather than approximate:
//
//   - requests complete asynchronously, and `tx.oncomplete` fires only after
//     every request queued on that transaction has run — including requests
//     queued from inside another request's `onsuccess` (getCachedPreset()
//     re-`put`s the row it just read to bump its LRU stamp, and relies on
//     that write landing before the transaction completes);
//   - `openCursor()` delivers one row per `onsuccess` and finishes with a
//     null result, so `evictShaderCacheIfNeeded()`'s collect-then-complete
//     pattern terminates;
//   - values are structured-cloned on the way in and out, so a caller that
//     mutates a row it read does not silently edit the store.
//
// Databases persist in this module for the lifetime of the process, exactly
// as a real one persists across `db.close()`; call resetFakeIndexedDb() in a
// test's setup to start from empty.

/** @type {Map<string, Map<string, Map<string, any>>>} */
const databases = new Map();

/** Drops every database. Call from a test's setup for a clean slate. */
export function resetFakeIndexedDb() {
    databases.clear();
}

/**
 * Direct access to a store's rows, for asserting on what a module wrote
 * without going back through the async request machinery.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @returns {Map<string, any>}
 */
export function fakeStoreContents(dbName, storeName) {
    return databases.get(dbName)?.get(storeName) ?? new Map();
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}

class FakeTransaction {
    /**
     * @param {Map<string, Map<string, any>>} stores
     * @param {string | string[]} names
     */
    constructor(stores, names) {
        this._stores = stores;
        this._names = Array.isArray(names) ? names : [names];
        /** @type {Array<() => void>} */
        this._queue = [];
        this._draining = false;
        this._done = false;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
    }

    objectStore(name) {
        if (!this._names.includes(name)) {
            throw new Error(`store ${name} is not in this transaction's scope`);
        }
        const rows = this._stores.get(name);
        if (!rows) {
            throw new Error(`store ${name} does not exist`);
        }
        return new FakeObjectStore(this, rows);
    }

    /** @param {() => void} op */
    _enqueue(op) {
        this._queue.push(op);
        if (!this._draining) {
            this._draining = true;
            queueMicrotask(() => this._drain());
        }
    }

    _drain() {
        // Requests queued from inside an onsuccess handler (the LRU re-put in
        // getCachedPreset()) must run before the transaction completes, so
        // re-check the queue after every step instead of snapshotting it.
        while (this._queue.length > 0) {
            const op = this._queue.shift();
            try {
                op();
            } catch (error) {
                this._draining = false;
                this._fail(error);
                return;
            }
        }
        this._draining = false;
        this._complete();
    }

    _complete() {
        if (this._done) return;
        this._done = true;
        this.oncomplete?.();
    }

    _fail(error) {
        if (this._done) return;
        this._done = true;
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
    }
}

class FakeObjectStore {
    /**
     * @param {FakeTransaction} tx
     * @param {Map<string, any>} rows
     */
    constructor(tx, rows) {
        this._tx = tx;
        this._rows = rows;
    }

    get(id) {
        const req = new FakeRequest();
        this._tx._enqueue(() => {
            req.result = clone(this._rows.get(id));
            req.onsuccess?.();
        });
        return req;
    }

    put(value) {
        const req = new FakeRequest();
        this._tx._enqueue(() => {
            const stored = clone(value);
            this._rows.set(stored.id, stored);
            req.result = stored.id;
            req.onsuccess?.();
        });
        return req;
    }

    delete(id) {
        const req = new FakeRequest();
        this._tx._enqueue(() => {
            this._rows.delete(id);
            req.onsuccess?.();
        });
        return req;
    }

    clear() {
        const req = new FakeRequest();
        this._tx._enqueue(() => {
            this._rows.clear();
            req.onsuccess?.();
        });
        return req;
    }

    openCursor() {
        const req = new FakeRequest();
        const keys = [...this._rows.keys()];
        let index = 0;
        const step = () => {
            if (index >= keys.length) {
                req.result = null;
                req.onsuccess?.();
                return;
            }
            const key = keys[index];
            index += 1;
            req.result = {
                value: clone(this._rows.get(key)),
                continue: () => this._tx._enqueue(step),
            };
            req.onsuccess?.();
        };
        this._tx._enqueue(step);
        return req;
    }
}

class FakeDatabase {
    /**
     * @param {string} name
     * @param {Map<string, Map<string, any>>} stores
     */
    constructor(name, stores) {
        this.name = name;
        this._stores = stores;
        this.closed = false;
        this.objectStoreNames = {
            contains: (storeName) => stores.has(storeName),
        };
    }

    createObjectStore(storeName) {
        if (!this._stores.has(storeName)) {
            this._stores.set(storeName, new Map());
        }
    }

    transaction(names) {
        if (this.closed) {
            throw new Error('transaction on a closed database');
        }
        return new FakeTransaction(this._stores, names);
    }

    close() {
        this.closed = true;
    }
}

/**
 * Installs the fake on `globalThis.indexedDB`.
 *
 * @param {object} [options]
 * @param {boolean} [options.failOpen] Make every open() fail, to exercise the
 *   "IndexedDB unavailable" fallbacks.
 * @returns {() => void} Restores the previous `globalThis.indexedDB`.
 */
export function installFakeIndexedDb({ failOpen = false } = {}) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

    const fake = {
        open(name) {
            const req = new FakeRequest();
            queueMicrotask(() => {
                if (failOpen) {
                    req.error = new Error('fake indexedDB open failure');
                    req.onerror?.();
                    return;
                }
                const isNew = !databases.has(name);
                if (isNew) databases.set(name, new Map());
                const db = new FakeDatabase(name, /** @type {Map<string, Map<string, any>>} */ (databases.get(name)));
                req.result = db;
                if (isNew) req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        },
    };

    Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        writable: true,
        value: fake,
    });

    return () => {
        if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
        else delete globalThis.indexedDB;
    };
}
