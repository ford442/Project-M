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
    PROJECTM_WASM_VERSION,
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
 */

/**
 * @typedef {object} LoadScriptOptions
 * @property {Document} [documentRef]
 * @property {boolean} [async]
 * @property {boolean} [defer]
 * @property {string} [charset]
 * @property {string} [type]
 */

/** @type {string | undefined} */
let resolvedWasmScript;

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
} = {}) {
    if (!forceRefresh && resolvedWasmScript) {
        return resolvedWasmScript;
    }

    const resolvedBase = resolveBaseUrl(documentRef, baseUrl);
    const candidates = [pmScript, rootScript];

    for (const candidate of candidates) {
        const url = resolvedBase ? new URL(candidate, resolvedBase).href : candidate;
        try {
            const response = await fetchFn(url, { method: 'HEAD', cache: 'no-store' });
            if (isUsableWasmScriptResponse(response, url)) {
                resolvedWasmScript = candidate;
                return candidate;
            }
        } catch {
            // Try the next candidate.
        }
    }

    // Prefer the legacy root layout when pm/ is missing (common on partial deploys).
    resolvedWasmScript = rootScript;
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
 * @param {string} src
 * @param {LoadScriptOptions} [options]
 * @returns {Promise<HTMLScriptElement>}
 */
export function loadScript(src, {
    documentRef = typeof document !== 'undefined' ? document : undefined,
    async = true,
    defer = false,
    charset,
    type = 'text/javascript'
} = {}) {
    return new Promise((resolve, reject) => {
        if (!documentRef) {
            reject(new Error('document is not available to load scripts'));
            return;
        }
        const script = documentRef.createElement('script');
        script.src = src;
        script.async = async;
        script.defer = defer;
        // Legacy .1ijs glue is UTF-16 (iconv). Preferred .js glue is UTF-8.
        script.charset = charset || (/\.1ijs(\?|#|$)/i.test(src) ? 'utf-16' : 'utf-8');
        script.type = type;
        script.onload = () => resolve(script);
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        documentRef.body.appendChild(script);
    });
}

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
    ...resolveOptions
} = {}) {
    const paths = wasmVersion ? buildWasmBundlePaths(wasmVersion) : null;
    const resolvedScript = scriptSrc || await resolveWasmScriptUrl({
        ...resolveOptions,
        ...(paths ? { pmScript: paths.pmScript, rootScript: paths.rootScript } : {}),
    });
    const factory = /** @type {any} */ (windowRef)[createModuleName];
    if (typeof factory !== 'function') {
        await loadScript(resolvedScript);
    }
    const readyFactory = /** @type {any} */ (windowRef)[createModuleName];
    if (typeof readyFactory !== 'function') {
        throw new Error(`${createModuleName} is not available after loading ${resolvedScript}`);
    }
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
 * @param {(entries: ResizeObserverEntry[]) => void} [options.onResize]
 * @returns {ResizeObserver | null}
 */
export function observeModuleSize({
    container = document.querySelector('#contain1'),
    beforeSync,
    sync = syncModuleSize,
    onResize
} = {}) {
    if (!container || typeof ResizeObserver === 'undefined') return null;

    const observer = new ResizeObserver((entries) => {
        if (beforeSync) beforeSync(entries);
        sync(entries);
        if (onResize) onResize(entries);
    });
    observer.observe(container);
    return observer;
}
