// Just enough DOM for the host modules that build a small overlay
// (html/projectm-perf.js's frame-time HUD, html/projectm-fbo-format.js's
// degraded-mode banner). Both write their markup with innerHTML and then read
// it back through querySelector, so the fake resolves selectors lazily:
// asking for a selector mints (and remembers) an element for it, which is
// enough to assert on what the module wrote without parsing HTML.

class FakeClassList {
    constructor() {
        this._set = new Set();
    }
    add(name) { this._set.add(name); }
    remove(name) { this._set.delete(name); }
    contains(name) { return this._set.has(name); }
    toString() { return [...this._set].join(' '); }
}

export class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this.textContent = '';
        this.innerHTML = '';
        this.style = {};
        this.classList = new FakeClassList();
        /** @type {FakeElement[]} */
        this.children = [];
        /** @type {Map<string, FakeElement>} */
        this._bySelector = new Map();
        /** @type {Map<string, Set<(event: any) => void>>} */
        this._listeners = new Map();
        /** @type {FakeElement | null} */
        this.parentNode = null;
        /** @type {Record<string, string>} */
        this.dataset = {};
        /** @type {Map<string, string>} */
        this._attributes = new Map();
        this.hidden = false;
        this.value = '';
    }

    setAttribute(name, value) { this._attributes.set(name, String(value)); }
    getAttribute(name) { return this._attributes.get(name) ?? null; }
    focus() {}
    /** Only an exact match on this element: enough for event delegation tests. */
    closest(selector) { return this._matchedBy?.has(selector) ? this : null; }

    /** Detaches this element from its parent, as a real `remove()` does. */
    remove() {
        this.parentNode?.removeChild(this);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        this._onRemove?.(child);
        return child;
    }

    addEventListener(type, listener) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this._listeners.get(type)?.delete(listener);
    }

    /** Test helper: how many listeners are attached for `type`. */
    listenerCount(type) {
        return this._listeners.get(type)?.size ?? 0;
    }

    /** Test helper: run every listener for `type`, like a click would. */
    dispatch(type, event = {}) {
        for (const listener of [...(this._listeners.get(type) ?? [])]) listener(event);
    }

    appendChild(child) {
        child.parentNode?.removeChild?.(child);
        this.children.push(child);
        child.parentNode = this;
        return child;
    }

    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }

    /** Lazily mints one element per selector, so repeat lookups are stable. */
    querySelector(selector) {
        if (!this._bySelector.has(selector)) {
            const minted = new FakeElement('div');
            minted._matchedBy = new Set([selector]);
            minted.parentNode = this;
            this._bySelector.set(selector, minted);
        }
        return this._bySelector.get(selector);
    }

    /** One minted element per selector, as a list. */
    querySelectorAll(selector) {
        return [this.querySelector(selector)];
    }
}

/**
 * @returns {{ document: any, elementsById: Map<string, FakeElement> }}
 */
export function createFakeDocument() {
    /** @type {Map<string, FakeElement>} */
    const elementsById = new Map();

    const register = (child) => {
        if (child?.id) elementsById.set(child.id, child);
        return child;
    };

    const head = new FakeElement('head');
    const body = new FakeElement('body');
    head.appendChild = (child) => { FakeElement.prototype.appendChild.call(head, child); return register(child); };
    body.appendChild = (child) => { FakeElement.prototype.appendChild.call(body, child); return register(child); };
    // A removed element no longer resolves by id, as in a real document.
    const unregister = (child) => {
        if (child?.id && elementsById.get(child.id) === child) elementsById.delete(child.id);
    };
    head._onRemove = unregister;
    body._onRemove = unregister;

    const document = {
        head,
        body,
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => elementsById.get(id) ?? null,
        querySelector: () => null,
    };

    return { document, elementsById };
}

/**
 * Installs `document`, `window`, `location` and a hand-driven `performance`
 * clock for the duration of a test.
 *
 * The clock matters: html/projectm-perf.js throttles its HUD repaints to one
 * per 200 ms of `performance.now()`, which against the real clock makes the
 * test depend on how long the process happened to take to get here.
 *
 * @param {object} [options]
 * @param {string} [options.search] `location.search`, e.g. '?benchmark=1'.
 * @param {number} [options.now] Starting value for `performance.now()`.
 * @returns {{ document: any, window: any, elementsById: Map<string, FakeElement>,
 *   posted: any[], advanceClock: (ms: number) => void, restore: () => void }}
 */
export function installFakeDom({ search = '', now = 10_000 } = {}) {
    const { document, elementsById } = createFakeDocument();
    /** @type {any[]} */
    const posted = [];
    const windowRef = { postMessage: (message) => posted.push(message) };

    let clock = now;
    const saved = ['document', 'window', 'location', 'performance'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
    ]);

    const define = (name, value) => {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    define('document', document);
    define('window', windowRef);
    define('location', { search, href: `https://projectm.test/${search}`, origin: 'https://projectm.test' });
    define('performance', { now: () => clock });

    return {
        document,
        window: windowRef,
        elementsById,
        posted,
        advanceClock(ms) { clock += ms; },
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}
