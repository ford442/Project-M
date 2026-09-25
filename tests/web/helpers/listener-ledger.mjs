// A ledger of the event listeners a piece of code leaves registered on a target.
//
// Wrap `addEventListener` / `removeEventListener` on any object (a fake window,
// a fake element, a real EventTarget) and ask afterwards what is still
// attached. The point is the balance after teardown: a context that adds a
// `message` listener on start and never removes it passes every functional test
// and still leaks one handler per start()/destroy() cycle.
//
// Registration follows the DOM's identity rule — (type, listener, capture) is
// one registration, so adding the same tuple twice is still one — because that
// is what decides whether a later removeEventListener() actually detaches it.

/**
 * @param {any} options
 * @returns {boolean}
 */
function isCapture(options) {
    return options === true || (typeof options === 'object' && options !== null && options.capture === true);
}

/**
 * @param {any} target Anything with addEventListener/removeEventListener.
 * @param {string} [label] Used in failure messages.
 */
export function trackListeners(target, label = 'target') {
    const originalAdd = target.addEventListener;
    const originalRemove = target.removeEventListener;
    const hadOwnAdd = Object.prototype.hasOwnProperty.call(target, 'addEventListener');
    const hadOwnRemove = Object.prototype.hasOwnProperty.call(target, 'removeEventListener');

    /** @type {Map<string, Set<{ listener: unknown, capture: boolean }>>} */
    const live = new Map();
    let adds = 0;
    let removes = 0;

    const find = (/** @type {string} */ type, /** @type {unknown} */ listener, /** @type {boolean} */ capture) => {
        for (const entry of live.get(type) ?? []) {
            if (entry.listener === listener && entry.capture === capture) {
                return entry;
            }
        }
        return null;
    };

    target.addEventListener = function (/** @type {string} */ type, /** @type {unknown} */ listener, /** @type {any} */ options) {
        adds += 1;
        const capture = isCapture(options);
        if (!find(type, listener, capture)) {
            if (!live.has(type)) live.set(type, new Set());
            /** @type {Set<any>} */ (live.get(type)).add({ listener, capture });
        }
        return originalAdd?.call(this, type, listener, options);
    };

    target.removeEventListener = function (/** @type {string} */ type, /** @type {unknown} */ listener, /** @type {any} */ options) {
        removes += 1;
        const capture = isCapture(options);
        const entry = find(type, listener, capture);
        if (entry) {
            /** @type {Set<any>} */ (live.get(type)).delete(entry);
        }
        return originalRemove?.call(this, type, listener, options);
    };

    return {
        /** Listener count per event type, omitting types with none left. */
        outstanding() {
            /** @type {Record<string, number>} */
            const result = {};
            for (const [type, entries] of live) {
                if (entries.size > 0) result[type] = entries.size;
            }
            return result;
        },
        /** Total listeners still attached. */
        total() {
            let sum = 0;
            for (const entries of live.values()) sum += entries.size;
            return sum;
        },
        get adds() { return adds; },
        get removes() { return removes; },
        /**
         * Fails when anything is still attached, naming what.
         * @param {{ deepEqual: (a: unknown, b: unknown, message?: string) => void }} assert
         * @param {string} [message]
         */
        assertBalanced(assert, message) {
            assert.deepEqual(this.outstanding(), {}, message ?? `${label} still has listeners attached after teardown`);
        },
        /** Puts the target's own methods back. */
        restore() {
            if (hadOwnAdd) target.addEventListener = originalAdd;
            else delete target.addEventListener;
            if (hadOwnRemove) target.removeEventListener = originalRemove;
            else delete target.removeEventListener;
        },
    };
}
