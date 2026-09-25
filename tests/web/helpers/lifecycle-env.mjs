// A browser-shaped environment small enough to boot the real ProjectMContext and
// <project-m-visualizer> in Node — no module mocking, just the globals they
// reach for — and to say afterwards what they left behind.
//
// What it records, because lifecycle bugs are all "something is still there":
//   - env.workers        every Worker spawned, and whether it was terminated;
//   - env.channels       every BroadcastChannel opened, and whether it was closed;
//   - env.window / env.document listener ledgers (see listener-ledger.mjs);
//   - env.moduleCalls    every ccall a fake Module received, in order.
//
// The fake Module answers any `_symbol` property with a no-op function and
// `ccall()` with a recorded call, so the generated wrappers run unchanged.

import { trackListeners } from './listener-ledger.mjs';

/** Minimal EventTarget with `dispatch()` for tests. */
class FakeEventTarget {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }
    addEventListener(type, listener) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {
        this._listeners.get(type)?.delete(listener);
    }
    dispatch(type, event = {}) {
        for (const listener of [...(this._listeners.get(type) ?? [])]) listener({ type, ...event });
    }
}

/**
 * The selector forms the host modules use: `tag`, `.class`, `tag.class.class`, `#id`.
 * @param {FakeElement} element
 * @param {string} selector
 */
function matches(element, selector) {
    const idMatch = /^#([\w-]+)$/.exec(selector);
    if (idMatch) return element.id === idMatch[1];
    const parts = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(selector);
    if (!parts) return false;
    const [, tag, classes] = parts;
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const wanted = classes.split('.').filter(Boolean);
    const have = String(element.className).split(/\s+/);
    return wanted.every((name) => have.includes(name));
}

export class FakeElement extends FakeEventTarget {
    constructor(tagName = 'div') {
        super();
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this.className = '';
        this.style = {};
        this.width = 0;
        this.height = 0;
        /** @type {FakeElement[]} */
        this.children = [];
        /** @type {FakeElement | null} */
        this.parentElement = null;
        this.isConnected = false;
        this.classList = {
            add: (name) => { if (!String(this.className).split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: (name) => { this.className = String(this.className).split(/\s+/).filter((n) => n !== name).join(' '); },
            contains: (name) => String(this.className).split(/\s+/).includes(name),
        };
        this.innerHTML = '';
        this.textContent = '';
    }
    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }
    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        child._setConnected(this.isConnected);
        return child;
    }
    remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentElement = null;
        this._setConnected(false);
    }
    /** @param {boolean} connected */
    _setConnected(connected) {
        if (this.isConnected === connected) return;
        this.isConnected = connected;
        if (connected) this.connectedCallback?.();
        else this.disconnectedCallback?.();
        for (const child of [...this.children]) child._setConnected(connected);
    }
    *_descendants() {
        for (const child of this.children) {
            yield child;
            yield* child._descendants();
        }
    }
    querySelector(selector) {
        for (const element of this._descendants()) if (matches(element, selector)) return element;
        return null;
    }
    querySelectorAll(selector) {
        return [...this._descendants()].filter((element) => matches(element, selector));
    }
    getBoundingClientRect() {
        return { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 };
    }
    setAttribute() {}
    getAttribute() { return null; }
}

/** A canvas that can hand its control to a render worker exactly once. */
class FakeCanvas extends FakeElement {
    constructor() {
        super('canvas');
        this.transferred = false;
    }
    transferControlToOffscreen() {
        if (this.transferred) throw new Error('InvalidStateError: canvas control already transferred');
        this.transferred = true;
        return { fakeOffscreenCanvas: true };
    }
}

/** Base class standing in for `HTMLElement`, with attributes and lifecycle hooks. */
class FakeHTMLElement extends FakeElement {
    constructor() {
        super('project-m-visualizer');
        /** @type {Map<string, string>} */
        this._attributes = new Map();
        /** @type {{ type: string, detail: any }[]} */
        this.dispatched = [];
    }
    getAttribute(name) {
        return this._attributes.has(name) ? this._attributes.get(name) : null;
    }
    setAttribute(name, value) {
        const previous = this.getAttribute(name);
        this._attributes.set(name, String(value));
        if (this.isConnected && this.constructor.observedAttributes?.includes(name)) {
            this.attributeChangedCallback?.(name, previous, String(value));
        }
    }
    dispatchEvent(event) {
        this.dispatched.push({ type: event.type, detail: event.detail });
        this.dispatch(event.type, event);
        return true;
    }
    /** How many times an event type was dispatched on this element. */
    count(type) {
        return this.dispatched.filter((event) => event.type === type).length;
    }
}

class FakeWorker {
    constructor(url) {
        this.url = String(url);
        this.terminated = false;
        this.messages = [];
        this.onmessage = null;
        this.onerror = null;
        FakeWorker.instances.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    /** Deliver a message from the worker side. */
    emit(data) { this.onmessage?.({ data }); }
}
/** @type {FakeWorker[]} */
FakeWorker.instances = [];

class FakeBroadcastChannel extends FakeEventTarget {
    constructor(name) {
        super();
        this.name = name;
        this.closed = false;
        this.onmessage = null;
        FakeBroadcastChannel.instances.push(this);
    }
    close() {
        this.closed = true;
        // A closed channel drops its listeners, as a real one does; going through
        // removeEventListener keeps the listener ledger honest about it.
        for (const [type, listeners] of [...this._listeners]) {
            for (const listener of [...listeners]) this.removeEventListener(type, listener);
        }
        this.onmessage = null;
    }
}
/** @type {FakeBroadcastChannel[]} */
FakeBroadcastChannel.instances = [];

/**
 * A Module whose every `_symbol` is a no-op and whose `ccall` is recorded.
 *
 * @param {object} [options]
 * @param {number} [options.hostHandle] What `create_host` returns; 0 fails it.
 * @param {(name: string, args: unknown[]) => unknown} [options.onCall] Overrides a call's result.
 */
export function makeFakeModule({ hostHandle = 7, onCall } = {}) {
    /** @type {{ name: string, args: unknown[] }[]} */
    const calls = [];
    const target = {
        calls,
        destructed: false,
        ccall(name, _returnType, _argTypes, args = []) {
            calls.push({ name, args });
            const override = onCall?.(name, args);
            if (override !== undefined) return override;
            if (name === 'create_host') return hostHandle;
            return 0;
        },
        _destruct() {
            target.destructed = true;
            calls.push({ name: '_destruct', args: [] });
        },
    };
    return new Proxy(target, {
        get(obj, property) {
            if (property in obj) return obj[property];
            if (typeof property === 'string' && property.startsWith('_')) {
                return (...args) => {
                    calls.push({ name: property, args });
                    return 0;
                };
            }
            return undefined;
        },
    });
}

const GLOBAL_NAMES = [
    'window', 'document', 'location', 'crossOriginIsolated', 'Worker', 'OffscreenCanvas',
    'BroadcastChannel', 'fetch', 'HTMLElement', 'customElements', 'requestAnimationFrame',
    'cancelAnimationFrame', 'ResizeObserver',
];

/**
 * Installs the environment. Call `restore()` in a `finally`.
 *
 * @param {object} [options]
 * @param {boolean} [options.crossOriginIsolated]
 * @param {boolean} [options.withCustomElements] Also install HTMLElement/customElements.
 * @param {boolean} [options.withResizeObserver]
 */
export function installLifecycleEnv({
    crossOriginIsolated = true,
    withCustomElements = false,
    withResizeObserver = false,
} = {}) {
    const saved = GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const define = (name, value) => {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };

    FakeWorker.instances = [];
    FakeBroadcastChannel.instances = [];

    // A ledger over every fake event target at once, installed before any is
    // created so it also sees what the per-target ledgers below see. It is what
    // catches a listener left on an element the test never thought to watch (a
    // canvas, an overlay).
    const allListeners = trackListeners(FakeEventTarget.prototype, 'any fake target');

    // ---- window / document
    const window = new FakeEventTarget();
    window.location = { search: '', href: 'https://projectm.test/', origin: 'https://projectm.test' };
    window.crossOriginIsolated = crossOriginIsolated;
    window.devicePixelRatio = 1;
    window.postMessage = () => {};
    const windowLedger = trackListeners(window, 'window');

    const document = new FakeElement('html');
    document.isConnected = true;
    document.body = new FakeElement('body');
    document.head = new FakeElement('head');
    document.append(document.head, document.body);
    document.head.isConnected = true;
    document.body.isConnected = true;
    document.createElement = (tag) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag));
    document.getElementById = (id) => document.querySelector(`#${id}`);
    document.baseURI = 'https://projectm.test/';
    // Scripts "load" as soon as they are attached, like a cache hit.
    const bodyAppend = document.body.appendChild.bind(document.body);
    document.body.appendChild = (child) => {
        const attached = bodyAppend(child);
        if (child.tagName === 'SCRIPT') queueMicrotask(() => child.onload?.());
        return attached;
    };
    const documentLedger = trackListeners(document, 'document');

    define('window', window);
    define('document', document);
    define('location', window.location);
    define('crossOriginIsolated', crossOriginIsolated);
    define('Worker', FakeWorker);
    define('OffscreenCanvas', class FakeOffscreenCanvas {});
    define('BroadcastChannel', FakeBroadcastChannel);
    define('fetch', async (url) => ({
        ok: true,
        redirected: false,
        url: String(url),
        headers: { get: () => 'application/javascript' },
        arrayBuffer: async () => new ArrayBuffer(8),
    }));

    /** @type {Map<number, () => void>} */
    const frames = new Map();
    let nextFrame = 1;
    define('requestAnimationFrame', (callback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
    });
    define('cancelAnimationFrame', (id) => { frames.delete(id); });

    if (withResizeObserver) {
        class FakeResizeObserver {
            constructor(callback) {
                this.callback = callback;
                this.observing = 0;
                FakeResizeObserver.instances.push(this);
            }
            observe() { this.observing += 1; }
            disconnect() { this.observing = 0; }
        }
        FakeResizeObserver.instances = [];
        define('ResizeObserver', FakeResizeObserver);
    } else {
        delete globalThis.ResizeObserver;
    }

    let registry = null;
    if (withCustomElements) {
        define('HTMLElement', FakeHTMLElement);
        registry = new Map();
        define('customElements', {
            get: (tag) => registry.get(tag),
            define: (tag, ctor) => { registry.set(tag, ctor); },
        });
    }

    return {
        window,
        document,
        body: document.body,
        windowLedger,
        documentLedger,
        allListeners,
        workers: FakeWorker.instances,
        channels: FakeBroadcastChannel.instances,
        /** Frames requested and not cancelled. */
        pendingFrames: () => frames.size,
        customElementRegistry: registry,
        /** A canvas attached to the document, as a host page would have it. */
        makeCanvas(id) {
            const canvas = new FakeCanvas();
            if (id) canvas.id = id;
            const container = new FakeElement('div');
            container.append(canvas);
            document.body.append(container);
            return canvas;
        },
        /** Channels that were opened and never closed. */
        openChannels: () => FakeBroadcastChannel.instances.filter((channel) => !channel.closed),
        /** Workers that were spawned and never terminated. */
        liveWorkers: () => FakeWorker.instances.filter((worker) => !worker.terminated),
        restore() {
            windowLedger.restore();
            documentLedger.restore();
            allListeners.restore();
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}
