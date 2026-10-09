import { loadPresetFile } from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModuleLike
 */

/**
 * @typedef {object} PresetApiOptions
 * @property {ProjectMModuleLike} [module]
 * @property {string} [apiBase]
 * @property {string[]} [apiBases]
 * @property {string} [presetDir]
 * @property {string[]} [fallbackApiBases]
 * @property {boolean} [requireDir]
 * @property {(data: any) => string} [vfsPathForPreset]
 * @property {boolean} [warnOnFallback]
 * @property {number} [count]
 * @property {'all' | 'first' | string} [updateDisplayMode]
 * @property {boolean} [returnPaths]
 * @property {boolean} [logLoaded]
 * @property {(opts: { module?: ProjectMModuleLike }) => void} [startTransitionWhenReady]
 * @property {boolean} [updateDisplay]
 * @property {(vfsPath: string, bytes: Uint8Array) => void} [writeBytes] Where the
 *   fetched preset should be written. Supplied by hosts whose engine (and
 *   therefore whose virtual filesystem) is not on this thread; when omitted the
 *   bytes go straight into `module.FS`.
 */

/**
 * @typedef {object} PresetDisplayOptions
 * @property {Document} [documentRef]
 * @property {Window} [windowRef]
 * @property {string} [selector]
 * @property {string} [prefix]
 * @property {string} [text]
 */

export const DEFAULT_PRESET_API_BASE = 'https://storage.noahcohn.com';
// storage.1ink.us used to be listed here; its /api/presets/random returns 404
// (checked 2026-10-07), so it only added a failing request to every load.
export const FALLBACK_PRESET_API_BASES = [
    'https://storage.noahcohn.com'
];
export const LOCAL_PRESET_MAX_BYTES = 2 * 1024 * 1024;
export const LOCAL_PRESET_LAST_NAME_KEY = 'projectm:lastLocalPresetName';

/**
 * @param {string} name
 * @param {PresetDisplayOptions} [options]
 */
export function updatePresetDisplay(name, {
    documentRef = document,
    windowRef = window,
    selector = '#preset-name',
    prefix = 'Preset: ',
    /** Optional .milk source text for experimental metadata / host bridges. */
    text = undefined
} = {}) {
    if (!name) return;
    const basename = String(name).split('/').pop();
    windowRef.currentPresetName = basename;
    // Track the full VFS path (when available) so a WebGL context-loss recovery
    // (see projectm-context-loss.js) can reload the same preset after re-init.
    if (String(name).includes('/')) {
        windowRef.currentPresetPath = String(name);
    }
    const el = documentRef.querySelector(selector);
    if (el) {
        el.textContent = prefix + basename;
    }
    /** @type {{ name: string | undefined; path: string; text?: string }} */
    const detail = { name: basename, path: windowRef.currentPresetPath || name };
    if (typeof text === 'string') {
        detail.text = text;
        windowRef.dispatchEvent(new CustomEvent('pm:preset-text', { detail: { text, path: detail.path } }));
    }
    windowRef.dispatchEvent(new CustomEvent('pm:preset-loaded', { detail }));
}

/**
 * @param {{ documentRef?: Document; elementId?: string; defaultValue?: string }} [options]
 * @returns {string}
 */
export function getPresetDir({
    documentRef = document,
    elementId = 'presetDir',
    defaultValue = 'any'
} = {}) {
    const el = documentRef.getElementById(elementId);
    const val = el ? el.innerHTML.trim() : 'default';
    return val === 'default' ? defaultValue : val;
}

/**
 * @param {{ preferred?: string; includeStorageOverride?: boolean; fallbacks?: string[] }} [options]
 * @returns {string[]}
 */
export function getPresetApiBases({
    preferred,
    includeStorageOverride = true,
    fallbacks = [DEFAULT_PRESET_API_BASE]
} = {}) {
    let fromStorage = null;
    try {
        fromStorage = includeStorageOverride && typeof localStorage !== 'undefined' ? localStorage.getItem('apiBase') : null;
    } catch (_) {
        // Storage blocked.
    }
    return [...new Set(
        /** @type {string[]} */ ([preferred, fromStorage, ...fallbacks].filter(Boolean))
    )];
}

/**
 * The preset API base for this page: `?presetApi=<url>` wins, then
 * `window.PROJECTM_PRESET_API_BASE`, then the `apiBase` localStorage key, then
 * {@link DEFAULT_PRESET_API_BASE}.
 * @param {{ windowRef?: any; storage?: { getItem(key: string): string | null } | null }} [options]
 * @returns {string}
 */
export function getConfiguredPresetApiBase({
    windowRef = typeof window !== 'undefined' ? window : undefined,
    storage = typeof localStorage !== 'undefined' ? localStorage : null
} = {}) {
    try {
        const search = windowRef?.location?.search;
        const fromQuery = search ? new URLSearchParams(search).get('presetApi') : null;
        if (fromQuery) return fromQuery.replace(/\/+$/, '');
    } catch (_) {
        // Malformed query: fall through.
    }
    if (typeof windowRef?.PROJECTM_PRESET_API_BASE === 'string' && windowRef.PROJECTM_PRESET_API_BASE) {
        return windowRef.PROJECTM_PRESET_API_BASE.replace(/\/+$/, '');
    }
    let fromStorage = null;
    try {
        fromStorage = storage ? storage.getItem('apiBase') : null;
    } catch (_) {
        // Storage blocked (private mode, sandboxed iframe).
    }
    return fromStorage || DEFAULT_PRESET_API_BASE;
}

/** Bases already reported as failing, so a dead endpoint warns once, not per load. */
const warnedPresetApiBases = new Set();

/**
 * Readiness check for the raw `_load_preset_file` Emscripten export. Not part of the
 * generated {@link ProjectMModuleLike} surface (public preset loads route through
 * `loadPresetFile()` / ccall — see html/README.md host-layer notes), but Emscripten
 * still exports every C symbol as `_<name>`, so this checks for it directly rather
 * than widening the shared type just for a readiness probe.
 * @param {ProjectMModuleLike} module
 * @returns {boolean}
 */
function isPresetLoadReady(module) {
    return typeof (/** @type {any} */ (module))._load_preset_file === 'function';
}

/**
 * @param {string} filename
 * @returns {string}
 */
function safePresetName(filename) {
    return String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * @param {string} message
 * @param {{ documentRef?: Document; selector?: string; isError?: boolean }} [options]
 */
function setStatusMessage(message, {
    documentRef = document,
    selector = '#stat',
    isError = false
} = {}) {
    const el = /** @type {HTMLElement | null} */ (documentRef.querySelector(selector));
    if (!el) return;
    el.style.display = 'block';
    el.textContent = message;
    el.style.background = isError ? 'rgba(127, 29, 29, 0.92)' : 'rgba(15, 23, 42, 0.88)';
    el.style.color = isError ? '#fecaca' : '#dbeafe';
    el.style.padding = '0.45rem 0.7rem';
    el.style.borderRadius = '0.45rem';
    el.style.border = isError ? '1px solid rgba(248,113,113,0.5)' : '1px solid rgba(96,165,250,0.35)';
}

/** @param {File} file */
function assertLocalPresetFile(file) {
    if (!file) {
        throw new Error('No preset file selected');
    }
    if (!/\.milk$/i.test(file.name)) {
        throw new Error('Invalid preset file. Choose a .milk file.');
    }
    if (file.size > LOCAL_PRESET_MAX_BYTES) {
        throw new Error(`Preset too large. Limit is ${Math.round(LOCAL_PRESET_MAX_BYTES / (1024 * 1024))}MB.`);
    }
}

/**
 * @param {string} [filename]
 * @returns {string}
 */
export function getLocalPresetVfsPath(filename) {
    const baseName = safePresetName(filename || 'preset.milk');
    return `/presets/local_${baseName}`;
}

/**
 * @param {PresetApiOptions} [options]
 * @returns {Promise<{ vfsPath: string; filename: string; dir: string; url: string; apiBase: string; bytes: Uint8Array }>}
 */
export async function fetchApiPreset({
    module,
    apiBase,
    apiBases,
    presetDir,
    fallbackApiBases = [DEFAULT_PRESET_API_BASE],
    requireDir = false,
    vfsPathForPreset,
    warnOnFallback = true,
    writeBytes
} = {}) {
    // Check where the bytes go before touching the network. In the
    // render-worker topology the main-thread module has no FS; the caller
    // must route the write through the render transport.
    if (!writeBytes && !(module && module.FS)) {
        throw new Error('fetchApiPreset: no VFS on this thread; pass writeBytes (render-worker topology) or a module with FS');
    }
    const dir = presetDir || getPresetDir();
    const bases = apiBases || getPresetApiBases({ preferred: apiBase, fallbacks: fallbackApiBases });
    let lastError = null;

    for (const base of bases) {
        try {
            const res = await fetch(`${base}/api/presets/random?dir=${encodeURIComponent(dir)}`);
            if (!res.ok) throw new Error(`API error ${res.status} from ${base}`);

            const data = await res.json();
            if (!data.url || !data.filename || (requireDir && !data.dir)) {
                throw new Error(`Invalid API response from ${base}`);
            }

            const milkRes = await fetch(data.url);
            if (!milkRes.ok) throw new Error(`Failed to fetch preset milk from ${data.url}`);

            const bytes = new Uint8Array(await milkRes.arrayBuffer());
            const vfsPath = vfsPathForPreset
                ? vfsPathForPreset(data)
                : `/presets/api_${data.dir || dir || 'any'}_${safePresetName(data.filename)}`;

            // `writeBytes` is how the render-worker topology gets presets: the
            // VFS is in the worker, so the caller supplies the write instead of
            // this function reaching for a module that is not on this thread.
            if (writeBytes) {
                writeBytes(vfsPath, bytes);
            } else {
                /** @type {NonNullable<ProjectMModuleLike['FS']>} */ (module?.FS).writeFile(vfsPath, bytes);
            }

            return {
                vfsPath,
                filename: data.filename,
                dir: data.dir || dir,
                url: data.url,
                apiBase: base,
                bytes
            };
        } catch (error) {
            lastError = error;
            if (warnOnFallback && !warnedPresetApiBases.has(base)) {
                warnedPresetApiBases.add(base);
                console.warn('[ProjectM] preset API unavailable, falling back:', base, error instanceof Error ? error.message : error);
            }
        }
    }

    throw lastError || new Error('No preset API base available');
}

/**
 * @param {PresetApiOptions} options
 * @returns {Promise<Array<string | { vfsPath: string; filename: string; dir: string; url: string; apiBase: string; bytes: Uint8Array }>>}
 */
export async function loadStartupApiPresets({
    module,
    count = 0,
    apiBase,
    apiBases,
    fallbackApiBases,
    updateDisplayMode = 'all',
    returnPaths = false,
    logLoaded = false,
    requireDir = false,
    vfsPathForPreset,
    writeBytes
}) {
    const results = [];
    for (let i = 0; i < count; i++) {
        try {
            const result = await fetchApiPreset({
                module,
                apiBase,
                apiBases,
                fallbackApiBases,
                requireDir,
                vfsPathForPreset,
                writeBytes
            });
            results.push(returnPaths ? result.vfsPath : result);
            if (updateDisplayMode === 'all' || (updateDisplayMode === 'first' && i === 0)) {
                updatePresetDisplay(result.filename);
            }
            if (logLoaded) {
                console.log('Startup API preset', i, 'loaded:', result.filename);
            }
        } catch (error) {
            // Every base failed (fetchApiPreset already warned once per base);
            // the rest of the batch would fail the same way.
            console.warn('[ProjectM] startup API presets unavailable; using bundled presets.', error instanceof Error ? error.message : error);
            break;
        }
    }
    return results;
}

/**
 * @param {PresetApiOptions} options
 * @returns {Promise<{ vfsPath: string; filename: string; dir: string; url: string; apiBase: string } | null>}
 */
export async function loadRandomApiPreset({
    module,
    apiBase,
    apiBases,
    fallbackApiBases,
    requireDir = false,
    vfsPathForPreset,
    startTransitionWhenReady,
    updateDisplay = true,
    logLoaded = false,
    presetDir,
    writeBytes
}) {
    // With `writeBytes` the caller owns both the write and the load (the
    // render transport's writePreset does both in the worker).
    if (!writeBytes && (!module || !module.FS || !isPresetLoadReady(module))) {
        console.warn('[ProjectM] random API preset skipped: module not ready');
        return null;
    }

    try {
        const result = await fetchApiPreset({
            module,
            apiBase,
            apiBases,
            fallbackApiBases,
            requireDir,
            vfsPathForPreset,
            presetDir,
            writeBytes
        });
        if (!writeBytes && module) loadPresetFile(module, result.vfsPath);
        if (startTransitionWhenReady) {
            startTransitionWhenReady({ module });
        }
        if (updateDisplay) {
            updatePresetDisplay(result.vfsPath);
        }
        if (logLoaded) {
            console.log('Loaded API preset:', result.filename, 'from', result.dir);
        }
        return result;
    } catch (error) {
        // fetchApiPreset already warned per failing base; callers fall back
        // to the bundled presets on null.
        return null;
    }
}

/**
 * @param {File} file
 * @param {{ module?: ProjectMModuleLike; startTransitionWhenReady?: (opts: { module?: ProjectMModuleLike }) => void; updateDisplay?: boolean; rememberLast?: boolean; documentRef?: Document }} [options]
 * @returns {Promise<{ filename: string; vfsPath: string }>}
 */
export async function loadLocalPresetFile(file, {
    module,
    startTransitionWhenReady,
    updateDisplay = true,
    rememberLast = true,
    documentRef = document
} = {}) {
    if (!module || !module.FS || !isPresetLoadReady(module)) {
        throw new Error('Module not ready');
    }

    assertLocalPresetFile(file);
    setStatusMessage(`Loading local preset: ${file.name}`, { documentRef });

    let bytes;
    try {
        bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
        throw new Error(`Failed to read preset file: ${error instanceof Error ? error.message : error}`);
    }

    const vfsPath = getLocalPresetVfsPath(file.name);
    try {
        module.FS.writeFile(vfsPath, bytes);
    } catch (error) {
        throw new Error(`Failed to write preset to Emscripten FS: ${error instanceof Error ? error.message : error}`);
    }

    try {
        loadPresetFile(module, vfsPath);
    } catch (error) {
        throw new Error(`Preset parser rejected ${file.name}: ${error instanceof Error ? error.message : error}`);
    }

    if (startTransitionWhenReady) {
        startTransitionWhenReady({ module });
    }
    let milkText;
    try {
        milkText = new TextDecoder().decode(bytes);
    } catch (_) {
        milkText = undefined;
    }
    if (updateDisplay) {
        updatePresetDisplay(vfsPath, { documentRef, text: milkText });
    }
    if (rememberLast) {
        localStorage.setItem(LOCAL_PRESET_LAST_NAME_KEY, file.name);
    }
    setStatusMessage(`Loaded local preset: ${file.name}`, { documentRef });

    return {
        filename: file.name,
        vfsPath
    };
}

/**
 * Fetches a `.milk` preset from an HTTP(S) URL, writes it to the Emscripten VFS,
 * and loads it into the running engine.
 *
 * `signal` cancels the load: the fetch is aborted, and if the signal fires while
 * the bytes are still arriving nothing is written to the module. The check
 * matters because the caller aborts when it destroys the engine, and writing
 * into a module that has just been torn down is a use-after-free.
 *
 * @param {string} url Absolute or same-origin preset URL.
 * @param {{ module?: ProjectMModuleLike; vfsPath?: string; updateDisplay?: boolean; startTransitionWhenReady?: (opts: { module?: ProjectMModuleLike }) => void; windowRef?: Window; signal?: AbortSignal }} [options]
 * @returns {Promise<{ url: string, vfsPath: string, filename: string }>}
 */
export async function loadPresetFromUrl(url, {
    module,
    vfsPath,
    updateDisplay = true,
    startTransitionWhenReady,
    windowRef = window,
    signal,
} = {}) {
    if (!module?.FS) {
        throw new Error('Module.FS not available');
    }

    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) {
        throw new Error(`Failed to fetch preset (${response.status}): ${url}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal?.aborted) {
        const error = new Error(`Preset load aborted: ${url}`);
        error.name = 'AbortError';
        throw error;
    }
    const filename = String(url).split('/').pop()?.split('?')[0] || 'preset.milk';
    const resolvedPath = vfsPath || `/presets/url_${safePresetName(filename)}`;

    module.FS.writeFile(resolvedPath, bytes);
    loadPresetFile(module, resolvedPath);

    if (startTransitionWhenReady) {
        startTransitionWhenReady({ module });
    }
    if (updateDisplay) {
        updatePresetDisplay(resolvedPath, { windowRef });
    }

    return {
        url,
        vfsPath: resolvedPath,
        filename,
    };
}
