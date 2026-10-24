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

/** `data-pm-action` -> `pmAction`, as the DOM's dataset does. */
const dataKey = (attribute) => attribute.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * The selector forms the host modules use: `tag`, `.class`, `tag.class.class`,
 * `#id`, and `[data-x]` / `[data-x="value"]`.
 * @param {FakeElement} element
 * @param {string} selector
 */
function matches(element, selector) {
    const idMatch = /^#([\w-]+)$/.exec(selector);
    if (idMatch) return element.id === idMatch[1];
    const dataMatch = /^\[(data-[\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (dataMatch) {
        const value = element.dataset?.[dataKey(dataMatch[1])];
        return value !== undefined && (dataMatch[2] === undefined || value === dataMatch[2]);
    }
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
            toggle: (name, force) => {
                const on = force === undefined ? !this.classList.contains(name) : !!force;
                if (on) this.classList.add(name);
                else this.classList.remove(name);
                return on;
            },
        };
        /** @type {Record<string, string>} */
        this.dataset = {};
        this.hidden = false;
        this.offsetWidth = 0;
        this.innerHTML = '';
        this.textContent = '';
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (matches(node, selector)) return node;
        }
        return null;
    }
    replaceChildren(...nodes) {
        for (const child of [...this.children]) child.remove();
        this.append(...nodes);
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
    get parentNode() {
        return this.parentElement;
    }
    /** @param {FakeElement} fresh @param {FakeElement} old */
    replaceChild(fresh, old) {
        const index = this.children.indexOf(old);
        if (index < 0) throw new Error('NotFoundError: not a child');
        old.parentElement = null;
        old._setConnected(false);
        fresh.parentElement = this;
        this.children[index] = fresh;
        fresh._setConnected(this.isConnected);
        return old;
    }
    /** A shallow copy: tag, id, classes and inline style; never children or listeners. */
    cloneNode() {
        const copy = this.tagName === 'CANVAS' ? new FakeCanvas() : new FakeElement(this.tagName);
        copy.id = this.id;
        copy.className = this.className;
        copy.style = { ...this.style };
        return copy;
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
    postMessage(message) {
        this.messages.push(message);
        // A live worker answers shutdown at once (see shutdown() in
        // html/projectm-render-worker.js); a test that wants a wedged one
        // sets `answersShutdown = false`.
        if (message?.type === 'shutdown' && this.answersShutdown !== false && !this.terminated) {
            this.emit({ type: 'shutdown-complete' });
        }
    }
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
 * It models the C++ host registry (src/wasm/WasmHost.cpp) as far as the host
 * layer can observe it: a successful create makes the new host live and
 * active, `set_active_host` switches to a live host and ignores a stale one,
 * `destroy_host` frees one, and `_get_active_host` reads it back.
 * `engineCalls` records which host was active when each call ran, which is
 * what a test of "this landed on the right engine" asserts on.
 *
 * @param {object} [options]
 * @param {number} [options.hostHandle] What `create_host_with_config` / `create_host` returns; 0 fails it.
 * @param {number} [options.initError] What `get_last_init_error` reports after a failed create.
 * @param {(name: string, args: unknown[]) => unknown} [options.onCall] Overrides a call's result.
 */
export function makeFakeModule({ hostHandle = 7, initError = 4, onCall } = {}) {
    /** @type {{ name: string, args: unknown[] }[]} */
    const calls = [];
    /** @type {{ name: string, host: number }[]} */
    const engineCalls = [];
    /** @type {Set<number>} */
    const liveHosts = new Set();
    let activeHost = 0;
    let lastInitError = 0;
    const firstLive = () => liveHosts.values().next().value ?? 0;
    const target = {
        calls,
        engineCalls,
        liveHosts,
        destructed: false,
        get activeHost() {
            return activeHost;
        },
        ccall(name, _returnType, _argTypes, args = []) {
            calls.push({ name, args });
            engineCalls.push({ name, host: activeHost });
            const override = onCall?.(name, args);
            let result = override !== undefined ? override : 0;
            if (override === undefined && isCreateHostCall(name)) result = hostHandle;
            if (isCreateHostCall(name)) {
                lastInitError = result ? 0 : initError;
                if (result) {
                    liveHosts.add(Number(result));
                    activeHost = Number(result);
                }
            } else if (name === 'set_active_host') {
                const handle = Number(args[0]);
                if (handle === 0) activeHost = firstLive();
                else if (liveHosts.has(handle)) activeHost = handle;
            } else if (name === 'destroy_host') {
                liveHosts.delete(Number(args[0]));
                if (activeHost === Number(args[0])) activeHost = firstLive();
            }
            return result;
        },
        _get_active_host() {
            return activeHost;
        },
        _get_last_init_error() {
            return lastInitError;
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
                    engineCalls.push({ name: property, host: activeHost });
                    return 0;
                };
            }
            return undefined;
        },
    });
}

/** Both create exports: the config-taking one and the legacy one. */
export function isCreateHostCall(name) {
    return name === 'create_host_with_config' || name === 'create_host';
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
    // getContext() answers the render worker's pre-transfer WebGL2 probe.
    define('OffscreenCanvas', class FakeOffscreenCanvas { getContext() { return {}; } });
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
