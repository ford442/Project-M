// One teardown idiom for the host layer's setup*() functions.
//
// Every setup*() export returns something with a `dispose()` that undoes what
// it did: listeners off, timers cleared, the DOM it added removed. Without that
// a page that builds a panel twice (a retried init, a second context, a test)
// ends up with two panels, the first one's listeners still bound to stale
// closures. `createDisposables()` is the bookkeeping: register each acquisition
// as it happens, call `dispose()` once.
//
// Listeners are removed with removeEventListener() rather than an AbortSignal.
// Both work in a browser, but only the explicit removal is visible to code that
// wraps add/removeEventListener (the listener ledger the tests assert with), and
// it works on targets that predate the `signal` option.

/**
 * @typedef {import('./projectm-host-types.ts').Disposable} Disposable
 * @typedef {(() => void) | Disposable | null | undefined} DisposeStep
 */

/**
 * Turns a disposer function or a `{ dispose }` object into a function. Anything
 * else is nothing to undo.
 *
 * @param {DisposeStep} step
 * @returns {(() => void) | null}
 */
export function toDisposeFunction(step) {
    if (typeof step === 'function') {
        return step;
    }
    if (step && typeof step.dispose === 'function') {
        return () => step.dispose();
    }
    return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.label] Prefixes the warning a failing step logs.
 */
export function createDisposables({ label = 'projectM' } = {}) {
    /** @type {Array<() => void>} */
    const steps = [];
    let disposed = false;

    /** @param {() => void} step */
    const run = (step) => {
        try {
            step();
        } catch (error) {
            console.warn(`[${label}] cleanup step failed:`, error);
        }
    };

    return {
        /** True once dispose() ran; late async work checks it before touching anything. */
        get disposed() {
            return disposed;
        },

        /**
         * Registers an undo step. After dispose() it runs at once: whatever is
         * acquired after the owner went away must not outlive it.
         *
         * @template {DisposeStep} T
         * @param {T} step
         * @returns {T}
         */
        add(step) {
            const fn = toDisposeFunction(step);
            if (fn) {
                if (disposed) run(fn);
                else steps.push(fn);
            }
            return step;
        },

        /**
         * addEventListener() with the matching removeEventListener() registered.
         * A missing target (an optional element that is not on this page) is a no-op.
         *
         * @param {EventTarget | null | undefined} target
         * @param {string} type
         * @param {EventListenerOrEventListenerObject} listener
         * @param {boolean | AddEventListenerOptions} [options]
         */
        listen(target, type, listener, options) {
            if (disposed || !target || typeof target.addEventListener !== 'function') {
                return;
            }
            target.addEventListener(type, listener, options);
            const capture = typeof options === 'boolean' ? options : !!options?.capture;
            steps.push(() => target.removeEventListener(type, listener, capture));
        },

        /**
         * Appends `node` to `parent` and removes it again on dispose.
         *
         * @template {Node} T
         * @param {Node} parent
         * @param {T} node
         * @returns {T}
         */
        append(parent, node) {
            parent.appendChild(node);
            steps.push(() => {
                if (/** @type {ChildNode} */ (/** @type {unknown} */ (node)).remove) {
                    /** @type {ChildNode} */ (/** @type {unknown} */ (node)).remove();
                } else {
                    node.parentNode?.removeChild(node);
                }
            });
            return node;
        },

        /**
         * @param {() => void} callback
         * @param {number} ms
         */
        setTimeout(callback, ms) {
            const id = setTimeout(() => {
                if (!disposed) callback();
            }, ms);
            steps.push(() => clearTimeout(id));
            return id;
        },

        /**
         * @param {() => void} callback
         * @param {number} ms
         */
        setInterval(callback, ms) {
            const id = setInterval(callback, ms);
            steps.push(() => clearInterval(id));
            return id;
        },

        /** Undoes every step, newest first. Idempotent. */
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const step of steps.splice(0).reverse()) {
                run(step);
            }
        },
    };
}

/** @typedef {ReturnType<typeof createDisposables>} Disposables */

/**
 * Gives a disposer function the `{ dispose }` shape as well, so a setup that
 * has always returned `() => void` satisfies {@link Disposable} without every
 * caller that calls the function directly having to change.
 *
 * @param {() => void} fn
 * @returns {(() => void) & Disposable}
 */
export function asDisposable(fn) {
    return Object.assign(fn, { dispose: fn });
}
