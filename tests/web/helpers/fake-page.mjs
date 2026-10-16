// A whole host page's worth of fake DOM, built from the page's own markup.
//
// tests/web/projectm-core-host.test.mjs boots html/projectm-core-host.js
// against html/projectm-core.html. That script reaches for dozens of elements
// by id, class and data-action, and the modules it wires up build UI of their
// own with innerHTML, so this fake (like fake-dom.mjs) mints an element for any
// selector nothing matches. The elements the page's markup declares are real
// entries, found by id, class, tag and `[data-action]`, so a test can click a
// panel button and see what its handler did.

class FakeClassList {
    constructor(initial = []) {
        this._set = new Set(initial);
    }
    add(...names) { for (const name of names) this._set.add(name); }
    remove(...names) { for (const name of names) this._set.delete(name); }
    contains(name) { return this._set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : !!force;
        if (on) this._set.add(name); else this._set.delete(name);
        return on;
    }
    toString() { return [...this._set].join(' '); }
}

export class FakePageElement {
    constructor(tagName = 'div', attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.attributes = { ...attributes };
        this.id = attributes.id ?? '';
        this.className = attributes.class ?? '';
        this.classList = new FakeClassList((attributes.class ?? '').split(/\s+/).filter(Boolean));
        this.dataset = {};
        for (const [name, value] of Object.entries(attributes)) {
            if (name.startsWith('data-')) {
                this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
            }
        }
        this.style = {};
        this.textContent = '';
        this._html = '';
        this.title = attributes.title ?? '';
        this.hidden = 'hidden' in attributes;
        this.value = '';
        this.width = 300;
        this.height = 150;
        this.children = [];
        /** @type {FakePageElement | null} */
        this.parentElement = null;
        this.isConnected = true;
        this.offsetWidth = 0;
        /** @type {Map<string, Array<(event: any) => void>>} */
        this.listeners = new Map();
        this._minted = new Map();
    }
    /** Setting markup parses its tags into (flat) children, so lookups find them. */
    get innerHTML() { return this._html; }
    set innerHTML(html) {
        this._html = String(html);
        this.children = [];
        for (const element of elementsFromMarkup(`<body>${this._html}`)) this.appendChild(element);
    }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
        const list = this.listeners.get(type);
        if (list) this.listeners.set(type, list.filter((entry) => entry !== listener));
    }
    /** Runs the listeners for `type` the way a user event would. */
    dispatch(type, event = {}) {
        const full = { type, target: this, preventDefault() {}, ...event };
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(full);
        return full;
    }
    click() { return this.dispatch('click'); }
    appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        }
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (matches(node, selector)) return node;
        }
        return null;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480 }; }
    querySelector(selector) {
        const own = [...this.descendants()].find((node) => node !== this && matches(node, selector));
        if (own) return own;
        if (!this._minted.has(selector)) {
            const minted = new FakePageElement('div', selector.startsWith('#') ? { id: selector.slice(1) } : {});
            minted.parentElement = this;
            this._minted.set(selector, minted);
        }
        return this._minted.get(selector);
    }
    /** This element and everything below it, minted lookups included. */
    *descendants() {
        yield this;
        for (const child of [...this.children, ...this._minted.values()]) yield* child.descendants();
    }
    querySelectorAll(selector) {
        return [...this.descendants()].filter((node) => node !== this && matches(node, selector));
    }
    focus() {}
    getContext() { return null; }
    requestFullscreen() { return Promise.resolve(); }
}

/** @param {FakePageElement} element @param {string} selector */
function matches(element, selector) {
    const compound = selector.match(/^([a-z]+)(\[.*\])$/i);
    if (compound) return matches(element, compound[1]) && matches(element, compound[2]);
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
    const attr = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
        const value = element.getAttribute(attr[1]);
        return attr[2] === undefined ? value !== null : value === attr[2];
    }
    return element.tagName === selector.toUpperCase();
}

/**
 * Parses the opening tags of `html` into fake elements. Not a parser: enough
 * for attribute lookups on first-party markup.
 *
 * @param {string} html
 */
function elementsFromMarkup(html) {
    const body = html.slice(html.indexOf('<body'));
    const elements = [];
    for (const match of body.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
        const attributes = {};
        for (const attr of match[2].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            attributes[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
        }
        elements.push(new FakePageElement(match[1], attributes));
    }
    return elements;
}

/**
 * @param {string} html The page's markup.
 * @param {{ search?: string, hostname?: string, reducedMotion?: boolean }} [options]
 */
export function createFakePage(html, { search = '', hostname = 'projectm.test', reducedMotion = true } = {}) {
    const elements = elementsFromMarkup(html);
    const document = new FakePageElement('html');
    const head = new FakePageElement('head');
    const body = new FakePageElement('body');
    document.head = head;
    document.body = body;
    document.documentElement = document;
    document.title = '';
    document.hidden = false;
    document.fullscreenElement = null;
    document.exitFullscreen = () => Promise.resolve();
    for (const element of elements) {
        if (element.tagName !== 'BODY') body.appendChild(element);
    }
    const all = () => [...new Set([...elements, ...body.descendants(), ...head.descendants()])];
    document.getElementById = (id) => all().find((element) => element.id === id) ?? null;
    document.querySelector = (selector) => all().find((element) => matches(element, selector))
        ?? FakePageElement.prototype.querySelector.call(document, selector);
    document.querySelectorAll = (selector) => all().filter((element) => matches(element, selector));
    document.createElement = (tag) => new FakePageElement(tag);
    document.createTextNode = (text) => ({ textContent: text });

    const storage = new Map();
    const localStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
    };

    const windowListeners = new FakePageElement('window');
    const window = {
        location: { search, hostname, href: `https://${hostname}/projectm-core.html${search}`, origin: `https://${hostname}`, pathname: '/projectm-core.html', hash: '' },
        innerHeight: 720,
        innerWidth: 1280,
        devicePixelRatio: 1,
        crossOriginIsolated: true,
        matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
        addEventListener: (...args) => windowListeners.addEventListener(...args),
        removeEventListener: (...args) => windowListeners.removeEventListener(...args),
        dispatchEvent: () => true,
        postMessage: () => {},
        open: () => null,
        listeners: windowListeners.listeners,
    };

    return { document, window, localStorage, elements };
}

/**
 * Installs a fake page's globals; returns `restore()`.
 *
 * @param {ReturnType<typeof createFakePage>} page
 */
export function installFakePage(page) {
    const names = ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'ResizeObserver', 'navigator', 'BroadcastChannel'];
    const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    define('document', page.document);
    define('window', page.window);
    define('location', page.window.location);
    define('localStorage', page.localStorage);
    define('HTMLElement', FakePageElement);
    define('ResizeObserver', class { observe() {} disconnect() {} });
    define('navigator', { hardwareConcurrency: 8, mediaDevices: {} });
    // Node's own BroadcastChannel keeps the process alive once opened.
    define('BroadcastChannel', class FakeBroadcastChannel {
        constructor(name) { this.name = name; this.onmessage = null; }
        postMessage() {}
        addEventListener() {}
        removeEventListener() {}
        close() {}
    });
    return () => {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    };
}
