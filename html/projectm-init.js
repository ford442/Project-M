// Version constants live in projectm-wasm-version.js (single source of truth).
export {
    PROJECTM_WASM_VERSION,
    PROJECTM_WASM_DEFAULT_VERSION,
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_SMOKE_BUNDLE,
    PROJECTM_WASM_SELECTABLE_VERSIONS,
    PROJECTM_WASM_VERSION_STORAGE_KEY,
    PROJECTM_WASM_SCRIPT,
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    PROJECTM_WASM_DEFAULT_CDN_BASE,
    buildProjectMWasmUrls,
    buildWasmBundlePaths,
    normalizeWasmVersion,
    remapSmokeWasmArtifactName,
} from './projectm-wasm-version.js';
import {
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_DEFAULT_VERSION,
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    PROJECTM_WASM_SMOKE_BUNDLE,
    PROJECTM_WASM_VERSION_STORAGE_KEY,
    buildWasmBundlePaths,
    normalizeWasmVersion,
    remapSmokeWasmArtifactName,
} from './projectm-wasm-version.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

/**
 * @typedef {object} WasmScriptResolveOptions
 * @property {Document} [documentRef]
 * @property {typeof fetch} [fetchFn]
 * @property {string} [baseUrl]
 * @property {string} [pmScript]
 * @property {string} [rootScript]
 * @property {boolean} [forceRefresh]
 * @property {AbortSignal} [signal] Rejects this caller with an AbortError; a
 *   probe other callers share keeps running for them.
 */

/**
 * @typedef {object} LoadScriptOptions
 * @property {Document} [documentRef]
 * @property {boolean} [async]
 * @property {boolean} [defer]
 * @property {string} [charset]
 * @property {string} [type]
 * @property {AbortSignal} [signal]
 */

/**
 * One `<script>` being loaded, shared by every caller asking for the same URL
 * in the same document.
 *
 * @typedef {object} ScriptLoad
 * @property {HTMLScriptElement} script
 * @property {Promise<HTMLScriptElement>} promise
 * @property {number} waiters Callers still interested; only ever decremented by an abort.
 * @property {boolean} settled
 * @property {() => void} cancel Drops the element once the last waiter has aborted.
 */

// Completed probes, keyed by (resolved base, pmScript, rootScript). The version
// is already part of pmScript/rootScript (buildWasmBundlePaths), so this is also
// keyed by version: a later call for another bundle must not be answered with
// the URL that was resolved for the first one.
/** @type {Map<string, string>} */
const resolvedWasmScripts = new Map();

// Probes still running, same key. Two instances booting together share one round
// of HEAD requests instead of racing two.
/** @type {Map<string, Promise<string>>} */
const inFlightResolves = new Map();

// Script elements still loading, per document. Entries live only until the load
// settles: the glue defines a global `createModule`, so remembering a finished
// load would stop a later load of a different bundle from being injected.
/** @type {WeakMap<object, Map<string, ScriptLoad>>} */
let inFlightScriptLoads = new WeakMap();

/** Test seam: forgets every cached probe result and in-flight load. */
export function resetWasmScriptCacheForTests() {
    resolvedWasmScripts.clear();
    inFlightResolves.clear();
    inFlightScriptLoads = new WeakMap();
}

/** @returns {DOMException} */
function abortError() {
    return new DOMException('Aborted', 'AbortError');
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw abortError();
    }
}

/**
 * Settle with `promise`, or reject with an AbortError as soon as `signal`
 * aborts. Only this caller stops waiting: `promise` is left alone because other
 * callers may share it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        promise.catch(() => {});
        return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

/**
 * @param {Document | undefined} documentRef
 * @param {string} [baseUrl]
 * @returns {string | undefined}
 */
function resolveBaseUrl(documentRef, baseUrl) {
    if (baseUrl) {
        return baseUrl;
    }
    if (documentRef?.baseURI) {
        return documentRef.baseURI;
    }
    if (typeof location !== 'undefined') {
        return location.href;
    }
    return undefined;
}

/**
 * True when a probe response is a real WASM glue script, not an HTML ErrorDocument.
 *
 * Hosting that 302s missing paths to a soft-404 page (HTTP 200 text/html) will make
 * bare `response.ok` true for missing ./pm/ files — reject those here.
 *
 * @param {{ ok?: boolean; redirected?: boolean; url?: string; headers?: any } | null | undefined} response
 * @param {string} [requestUrl]
 * @returns {boolean}
 */
export function isUsableWasmScriptResponse(response, requestUrl) {
    if (!response || !response.ok) {
        return false;
    }

    const contentType = (
        typeof response.headers?.get === 'function'
            ? response.headers.get('content-type')
            : response.headers?.['content-type']
    ) || '';
    if (String(contentType).toLowerCase().includes('text/html')) {
        return false;
    }

    // fetch() follows redirects by default; a soft-404 lands on a different URL.
    if (response.redirected && response.url && requestUrl) {
        try {
            const requestedName = new URL(requestUrl, 'https://placeholder.local').pathname.split('/').pop();
            const finalName = new URL(response.url).pathname.split('/').pop();
            if (requestedName && finalName && requestedName !== finalName) {
                return false;
            }
        } catch {
            return false;
        }
    }

    return true;
}

/**
 * Resolves the threaded WASM glue script URL. Tries ./pm/ first (canonical deploy
 * layout), then falls back to ./ at the site root for legacy uploads that only
 * pushed projectm-v.*-thread.{js,1ijs,wasm} without the pm/ mirror.
 *
 * @param {WasmScriptResolveOptions} [options]
 * @returns {Promise<string>}
 */
export async function resolveWasmScriptUrl({
    documentRef = typeof document !== 'undefined' ? document : undefined,
    fetchFn = fetch,
    baseUrl,
    pmScript = PROJECTM_WASM_SCRIPT_PM,
    rootScript = PROJECTM_WASM_SCRIPT_ROOT,
    forceRefresh = false,
    signal,
} = {}) {
    throwIfAborted(signal);

    const resolvedBase = resolveBaseUrl(documentRef, baseUrl);
    const key = `${resolvedBase ?? ''}\n${pmScript}\n${rootScript}`;

    if (!forceRefresh) {
        const cached = resolvedWasmScripts.get(key);
        if (cached) {
            return cached;
        }
    }

    // forceRefresh skips the finished-result cache but still joins a probe that
    // is already running: it started moments ago, so it is as fresh as a new one.
    let probe = inFlightResolves.get(key);
    if (!probe) {
        const started = probeWasmScript({ resolvedBase, key, pmScript, rootScript, fetchFn });
        probe = started;
        inFlightResolves.set(key, started);
        const evict = () => {
            if (inFlightResolves.get(key) === started) {
                inFlightResolves.delete(key);
            }
        };
        started.then(evict, evict);
    }

    return raceAbort(probe, signal);
}

/**
 * The HEAD probes behind {@link resolveWasmScriptUrl}. Deliberately takes no
 * signal: it is shared between callers, and each of them races its own.
 *
 * @param {{
 *   resolvedBase: string | undefined,
 *   key: string,
 *   pmScript: string,
 *   rootScript: string,
 *   fetchFn: typeof fetch,
 * }} args
 * @returns {Promise<string>}
 */
async function probeWasmScript({ resolvedBase, key, pmScript, rootScript, fetchFn }) {
    for (const candidate of [pmScript, rootScript]) {
        const url = resolvedBase ? new URL(candidate, resolvedBase).href : candidate;
        try {
            const response = await fetchFn(url, { method: 'HEAD', cache: 'no-store' });
            if (isUsableWasmScriptResponse(response, url)) {
                resolvedWasmScripts.set(key, candidate);
                return candidate;
            }
        } catch {
            // Try the next candidate.
        }
    }

    // Prefer the legacy root layout when pm/ is missing (common on partial
    // deploys). Not cached: neither probe succeeded, so this is a guess, and a
    // transient network failure must not pin the wrong layout for the session.
    return rootScript;
}

/**
 * Emscripten `locateFile` that remaps smoke-build (v.030) artifact names to the
 * canonical deploy bundle. Pass the result to `createModule({ locateFile })`.
 *
 * Without this (or a matching rewrite in `prepare_deploy_bundle.sh`), loading
 * `./pm/projectm-v.035-thread.js` still fetches `./pm/projectm-v.030-thread.wasm`,
 * which soft-404s as HTML and aborts WASM compile.
 *
 * @param {object} [options]
 * @param {string} [options.targetBundle]
 * @param {string} [options.smokeBundle]
 * @param {(path: string, prefix?: string) => string} [options.locateFile] Optional inner locateFile to wrap
 * @returns {(path: string, prefix?: string) => string}
 */
export function buildProjectMLocateFile({
    targetBundle = PROJECTM_WASM_BUNDLE,
    smokeBundle = PROJECTM_WASM_SMOKE_BUNDLE,
    locateFile,
} = {}) {
    return (path, prefix = '') => {
        const remapped = remapSmokeWasmArtifactName(path, targetBundle, smokeBundle);
        if (typeof locateFile === 'function') {
            return locateFile(remapped, prefix);
        }
        return `${prefix || ''}${remapped}`;
    };
}

/**
 * @param {HTMLScriptElement} script
 */
function discardScript(script) {
    if (typeof script.remove === 'function') {
        script.remove();
    }
}

/**
 * Create the `<script>` for `src`, register it in `loads` and append it.
 *
 * The entry is registered *before* the element is appended: a load that
 * completes synchronously (a cached script in some embedders, a test double)
 * settles inside `appendChild`, and registering afterwards would leave a
 * finished load in the map for the next caller to be handed.
 *
 * @param {Document} documentRef
 * @param {Map<string, ScriptLoad>} loads
 * @param {string} src
 * @param {{ async: boolean, defer: boolean, charset: string | undefined, type: string }} options
 * @returns {ScriptLoad}
 */
function startScriptLoad(documentRef, loads, src, { async, defer, charset, type }) {
    const script = documentRef.createElement('script');
    script.src = src;
    script.async = async;
    script.defer = defer;
    // Legacy .1ijs glue is UTF-16 (iconv). Preferred .js glue is UTF-8.
    script.charset = charset || (/\.1ijs(\?|#|$)/i.test(src) ? 'utf-16' : 'utf-8');
    script.type = type;

    const load = /** @type {ScriptLoad} */ ({ script, waiters: 0, settled: false });

    const settle = () => {
        load.settled = true;
        script.onload = null;
        script.onerror = null;
        if (loads.get(src) === load) {
            loads.delete(src);
        }
    };

    load.cancel = () => {
        // Removing the element does not stop a fetch already in flight (the glue
        // would still define its factory), but it drops the element and its
        // handlers, and nothing is waiting on it any more.
        settle();
        discardScript(script);
    };

    load.promise = new Promise((resolve, reject) => {
        script.onload = () => {
            settle();
            resolve(script);
        };
        script.onerror = () => {
            settle();
            // A failed element left in the body is clutter, and a retry gets its own.
            discardScript(script);
            reject(new Error(`Failed to load ${src}`));
        };
        loads.set(src, load);
        try {
            documentRef.body.appendChild(script);
        } catch (error) {
            settle();
            reject(error);
        }
    });

    return load;
}

/**
 * Wait on a shared load, and leave it if `signal` aborts. The element is only
 * dropped when the *last* interested caller has left.
 *
 * @param {ScriptLoad} load
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<HTMLScriptElement>}
 */
function joinScriptLoad(load, signal) {
    load.waiters += 1;
    return new Promise((resolve, reject) => {
        let done = false;
        const onAbort = () => {
            if (done) {
                return;
            }
            done = true;
            load.waiters -= 1;
            if (load.waiters === 0 && !load.settled) {
                load.cancel();
            }
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        load.promise.then(
            (script) => {
                if (done) {
                    return;
                }
                done = true;
                signal?.removeEventListener('abort', onAbort);
                resolve(script);
            },
            (error) => {
                if (done) {
                    return;
                }
                done = true;
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

/**
 * Load a script, once per URL at a time: simultaneous callers for the same
 * `src` in the same document share one element and one promise. A failed load
 * is forgotten, so calling again retries with a fresh element.
 *
 * @param {string} src
 * @param {LoadScriptOptions} [options]
 * @returns {Promise<HTMLScriptElement>}
 */
export function loadScript(src, {
    documentRef = typeof document !== 'undefined' ? document : undefined,
    async = true,
    defer = false,
    charset,
    type = 'text/javascript',
    signal,
} = {}) {
    if (!documentRef) {
        return Promise.reject(new Error('document is not available to load scripts'));
    }
    if (signal?.aborted) {
        return Promise.reject(abortError());
    }

    let load;
    try {
        let loads = inFlightScriptLoads.get(documentRef);
        if (!loads) {
            loads = new Map();
            inFlightScriptLoads.set(documentRef, loads);
        }
        load = loads.get(src) ?? startScriptLoad(documentRef, loads, src, { async, defer, charset, type });
    } catch (error) {
        return Promise.reject(error);
    }
    return joinScriptLoad(load, signal);
}

/**
 * @param {WasmScriptResolveOptions & LoadScriptOptions} [options]
 * @returns {Promise<HTMLScriptElement>}
 */
export async function loadProjectMWasmScript(options = {}) {
    const scriptSrc = await resolveWasmScriptUrl(options);
    return loadScript(scriptSrc, options);
}

/**
 * Redirect to add `?wasm=` when the URL omits it so the host default bundle loads
 * and stale localStorage picks do not override `PROJECTM_WASM_DEFAULT_VERSION`.
 *
 * @param {object} [options]
 * @param {string} [options.defaultVersion=PROJECTM_WASM_DEFAULT_VERSION]
 * @param {Location} [options.locationRef]
 * @returns {boolean} True when a redirect was started.
 */
export function ensureDefaultWasmQueryParam({
    defaultVersion = PROJECTM_WASM_DEFAULT_VERSION,
    locationRef = typeof location !== 'undefined' ? location : undefined,
} = {}) {
    if (!locationRef) {
        return false;
    }
    try {
        const params = new URLSearchParams(locationRef.search);
        if (params.has('wasm')) {
            return false;
        }
        const version = normalizeWasmVersion(defaultVersion) || PROJECTM_WASM_DEFAULT_VERSION;
        params.set('wasm', version);
        const query = params.toString();
        const next = `${locationRef.pathname}${query ? `?${query}` : ''}${locationRef.hash}`;
        locationRef.replace(next);
        return true;
    } catch {
        return false;
    }
}

/**
 * Pick a selectable WASM version from URL (`?wasm=`), localStorage, or default.
 *
 * @param {object} [options]
 * @param {URLSearchParams | string | null} [options.searchParams]
 * @param {Storage | null} [options.storage]
 * @param {string} [options.fallback=PROJECTM_WASM_DEFAULT_VERSION]
 * @returns {string}
 */
export function resolveSelectedWasmVersion({
    searchParams = typeof location !== 'undefined' ? location.search : null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    fallback = PROJECTM_WASM_DEFAULT_VERSION,
} = {}) {
    const params = typeof searchParams === 'string'
        ? new URLSearchParams(searchParams.startsWith('?') ? searchParams.slice(1) : searchParams)
        : (searchParams || new URLSearchParams());
    const fromUrl = normalizeWasmVersion(params.get('wasm'));
    if (fromUrl) {
        return fromUrl;
    }
    try {
        const fromStorage = normalizeWasmVersion(storage?.getItem?.(PROJECTM_WASM_VERSION_STORAGE_KEY));
        if (fromStorage) {
            return fromStorage;
        }
    } catch {
        // Ignore quota / private-mode storage failures.
    }
    return normalizeWasmVersion(fallback) || PROJECTM_WASM_DEFAULT_VERSION;
}

/**
 * Loads the WASM glue script (if needed) and instantiates the Emscripten module.
 *
 * Extra properties beyond those listed are forwarded to
 * {@link resolveWasmScriptUrl} as {@link WasmScriptResolveOptions}.
 *
 * `documentRef` is the document the glue `<script>` is injected into, and
 * `signal` rejects with an AbortError up to the moment the module factory is
 * invoked. A factory that is already running cannot be cancelled: the promise
 * resolves normally and the caller decides whether to dispose the module.
 *
 * @param {WasmScriptResolveOptions & {
 *   scriptSrc?: string,
 *   createModuleName?: string,
 *   windowRef?: Window & typeof globalThis,
 *   noInitialRun?: boolean,
 *   primaryCanvasSelector?: string,
 *   secondaryCanvasSelector?: string,
 *   moduleConfig?: Record<string, unknown> & {
 *     locateFile?: (path: string, prefix?: string) => string,
 *   },
 *   targetBundle?: string,
 *   wasmVersion?: string,
 * }} [options]
 * @returns {Promise<ProjectMModuleLike>}
 */
export async function createProjectMModule({
    scriptSrc,
    createModuleName = 'createModule',
    windowRef = window,
    noInitialRun = false,
    primaryCanvasSelector,
    secondaryCanvasSelector,
    moduleConfig = {},
    targetBundle = PROJECTM_WASM_BUNDLE,
    wasmVersion,
    documentRef,
    signal,
    ...resolveOptions
} = {}) {
    throwIfAborted(signal);
    const paths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
    const resolvedScript = scriptSrc || await resolveWasmScriptUrl({
        ...resolveOptions,
        documentRef,
        signal,
        ...(paths ? { pmScript: paths.pmScript, rootScript: paths.rootScript } : {}),
    });
    const factory = /** @type {any} */ (windowRef)[createModuleName];
    if (typeof factory !== 'function') {
        // The caller's document, not whichever global one happens to exist; and
        // loadScript() shares one element between simultaneous boots, so two
        // instances starting together do not each inject the glue.
        await loadScript(resolvedScript, { documentRef, signal });
    }
    const readyFactory = /** @type {any} */ (windowRef)[createModuleName];
    if (typeof readyFactory !== 'function') {
        throw new Error(`${createModuleName} is not available after loading ${resolvedScript}`);
    }
    // Last point at which this can still be cancelled.
    throwIfAborted(signal);
    const { locateFile: userLocateFile, ...restModuleConfig } = moduleConfig;
    const locateTarget = paths?.bundle || targetBundle || PROJECTM_WASM_BUNDLE;
    return readyFactory({
        ...restModuleConfig,
        locateFile: buildProjectMLocateFile({
            targetBundle: locateTarget,
            locateFile: /** @type {any} */ (userLocateFile),
        }),
        ...(noInitialRun ? { noInitialRun: true } : {}),
        ...(primaryCanvasSelector ? { primaryCanvasSelector } : {}),
        ...(secondaryCanvasSelector ? { secondaryCanvasSelector } : {}),
    });
}

/**
 * @param {object} [options]
 * @param {ProjectMModuleLike | undefined} [options.module]
 * @param {Element | null} [options.container]
 * @param {HTMLCanvasElement | null} [options.mainCanvas]
 * @param {HTMLCanvasElement | null} [options.secondaryCanvas]
 * @param {boolean} [options.aspectCorrection]
 * @returns {boolean}
 */
export function syncModuleSize({
    module = globalThis.Module,
    container = document.querySelector('#contain1'),
    mainCanvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#mcanvas')),
    secondaryCanvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#scanvas')),
    aspectCorrection
} = {}) {
    if (!module || !container || !mainCanvas || !secondaryCanvas) return false;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    mainCanvas.width = width;
    mainCanvas.height = height;
    secondaryCanvas.width = width;
    secondaryCanvas.height = height;

    mainCanvas.style.width = rect.width + 'px';
    mainCanvas.style.height = rect.height + 'px';
    secondaryCanvas.style.width = rect.width + 'px';
    secondaryCanvas.style.height = rect.height + 'px';

    if (module._set_window_size) module._set_window_size(width, height);
    if (module._set_aspect_correction && aspectCorrection !== undefined) {
        module._set_aspect_correction(aspectCorrection ? 1 : 0);
    }
    return true;
}

/**
 * @param {object} [options]
 * @param {Element | null} [options.container]
 * @param {(entries: ResizeObserverEntry[]) => void} [options.beforeSync]
 * @param {(arg?: any) => any} [options.sync]
 * @param {Record<string, any>} [options.syncOptions] Passed to `sync` on every
 *   resize (e.g. `{ aspectCorrection }` for the default {@link syncModuleSize}).
 *   Without it `sync` is called with no arguments. The observer entries are
 *   never `sync`'s argument: they went in as its options object before, which
 *   only worked because every default happened to apply, and lost
 *   `aspectCorrection`. `beforeSync` and `onResize` still receive them.
 * @param {(entries: ResizeObserverEntry[]) => void} [options.onResize]
 * @returns {ResizeObserver | null}
 */
export function observeModuleSize({
    container = document.querySelector('#contain1'),
    beforeSync,
    sync = syncModuleSize,
    syncOptions,
    onResize
} = {}) {
    if (!container || typeof ResizeObserver === 'undefined') return null;

    const observer = new ResizeObserver((entries) => {
        if (beforeSync) beforeSync(entries);
        if (syncOptions) sync(syncOptions);
        else sync();
        if (onResize) onResize(entries);
    });
    observer.observe(container);
    return observer;
}
