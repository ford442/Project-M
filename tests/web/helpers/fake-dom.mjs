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
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    /** Lazily mints one element per selector, so repeat lookups are stable. */
    querySelector(selector) {
        if (!this._bySelector.has(selector)) {
            this._bySelector.set(selector, new FakeElement('div'));
        }
        return this._bySelector.get(selector);
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
