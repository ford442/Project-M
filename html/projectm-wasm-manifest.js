// Fetches the deployed WASM build manifest (`pm/builds.json`) and registers it
// with projectm-wasm-version.js, so buildWasmBundlePaths() and
// normalizeWasmVersion() use the deployed list of builds instead of the
// built-in table.
//
// The manifest is generated at deploy time by
// scripts/generate_wasm_builds_manifest.mjs and served with
// `Cache-Control: no-cache` (html/.htaccess), so a new build or a new default
// version is live without redeploying any host page. Every failure (offline,
// 404 soft-redirect to an HTML page, bad JSON, wrong schema, timeout) resolves
// null and leaves the built-in table in charge: the manifest can only improve
// boot, never break it. See docs/adr/0001-wasm-and-media-hosting.md.

import {
    PROJECTM_WASM_BUILDS_MANIFEST_PATH,
    parseWasmBuildsManifest,
    setWasmBuildsManifest,
} from './projectm-wasm-version.js';

/** @typedef {import('./projectm-wasm-version.js').WasmBuildsManifest} WasmBuildsManifest */

/** How long boot waits for the manifest before using the built-in table. */
export const WASM_BUILDS_MANIFEST_TIMEOUT_MS = 2500;

/** @type {Map<string, Promise<WasmBuildsManifest | null>>} */
const inFlight = new Map();

/**
 * @param {string | undefined} baseUrl
 * @returns {string}
 */
export function wasmBuildsManifestUrl(baseUrl) {
    const base = baseUrl
        || (typeof document !== 'undefined' ? document.baseURI : undefined)
        || globalThis.location?.href
        || 'https://localhost/';
    return new URL(PROJECTM_WASM_BUILDS_MANIFEST_PATH, base).href;
}

/**
 * Fetches, validates and registers `pm/builds.json` relative to `baseUrl`.
 * Concurrent and repeated calls for the same URL share one request; `force`
 * starts a new one.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] Page or site root the `pm/` directory hangs off.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.force]
 * @param {AbortSignal} [options.signal] Stops *this caller* waiting (resolves
 *   null); the shared request carries on for the others.
 * @returns {Promise<WasmBuildsManifest | null>}
 */
export function loadWasmBuildsManifest({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = WASM_BUILDS_MANIFEST_TIMEOUT_MS,
    force = false,
    signal,
} = {}) {
    let url;
    try {
        url = wasmBuildsManifestUrl(baseUrl);
    } catch {
        return Promise.resolve(null);
    }
    const pending = force ? null : inFlight.get(url);
    return untilAborted(pending || startRequest(url, fetchImpl, timeoutMs), signal);
}

/**
 * @param {Promise<WasmBuildsManifest | null>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<WasmBuildsManifest | null>}
 */
function untilAborted(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
        const onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        });
    });
}

/**
 * @param {string} url
 * @param {typeof fetch | undefined} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<WasmBuildsManifest | null>}
 */
function startRequest(url, fetchImpl, timeoutMs) {
    const request = fetchManifest(url, fetchImpl, timeoutMs).then((manifest) => {
        if (manifest) setWasmBuildsManifest(manifest);
        return manifest;
    });
    inFlight.set(url, request);
    // A failed fetch is not remembered: the next boot (e.g. a context restart
    // after the network came back) tries again.
    void request.then((manifest) => {
        if (!manifest && inFlight.get(url) === request) inFlight.delete(url);
    });
    return request;
}

/**
 * @param {string} url
 * @param {typeof fetch | undefined} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<WasmBuildsManifest | null>}
 */
async function fetchManifest(url, fetchImpl, timeoutMs) {
    if (typeof fetchImpl !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // Never keeps a process (tests, SSR) alive on its own.
    /** @type {any} */ (timer)?.unref?.();
    try {
        const response = await fetchImpl(url, {
            cache: 'no-cache',
            credentials: 'omit',
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) return null;
        // DreamHost answers a missing file with a 302 to an HTML 404 page,
        // which fetch follows to a 200: check the type before parsing.
        const type = response.headers?.get?.('content-type') || '';
        if (type && !/json/i.test(type)) return null;
        return parseWasmBuildsManifest(await response.json());
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Test hook: forget every cached request. */
export function resetWasmBuildsManifestCache() {
    inFlight.clear();
}
