// Render-worker support probes for projectm-render-worker-host.js: the
// ?renderWorker / render-path query switches, OffscreenCanvas + WebGL2
// feature detection, and the record of canvases handed to a worker. Split
// out of projectm-render-worker-host.js, which re-exports these.

/**
 * @typedef {import('./projectm-render-worker-types.ts').RenderPathOverrides} RenderPathOverrides
 */

/**
 * The render-path ablation switches in a page query string: `?blurPath=copy`,
 * `?copyPath=shader`, `?perPixelEval=cpu` (values case-insensitive). The page
 * reads them and hands them to the module with `set_render_path_overrides()` —
 * directly on the main thread, through the worker's `init` message otherwise,
 * since a worker's own `location` is its script URL and has no query.
 *
 * @param {string} [search]
 * @returns {RenderPathOverrides}
 */
export function resolveRenderPathOverrides(search = globalThis.location?.search ?? '') {
    const params = new URLSearchParams(search);
    /** @param {string} key @param {string} value */
    const is = (key, value) => (params.get(key) || '').toLowerCase() === value;
    return {
        blurCopyPath: is('blurPath', 'copy'),
        copyShaderPath: is('copyPath', 'shader'),
        perPixelForceCpu: is('perPixelEval', 'cpu'),
    };
}

/**
 * Whether the host *wants* the render worker. Says nothing about whether the
 * browser can provide one — that is isRenderWorkerSupported() /
 * canUseRenderWorker() in projectm-render-transport.js.
 *
 * The default is on. Both the query parameter and the stored preference are
 * read as explicit opt-outs ('0') or opt-ins ('1'); any other value is neither
 * and leaves the default in place, so a stale or garbled setting cannot
 * silently pin a page to the slower topology.
 *
 * @param {object} [options]
 * @param {string} [options.search]
 * @param {Storage | null} [options.storage]
 * @returns {boolean}
 */
export function isRenderWorkerEnabled({ search = location.search, storage = (() => {
    try { return window.localStorage; } catch (_) { return null; }
})() } = {}) {
    const params = new URLSearchParams(search);
    if (params.has('renderWorker')) {
        const value = params.get('renderWorker');
        if (value === '0') return false;
        if (value === '1') return true;
    }
    const stored = storage ? storage.getItem('renderWorker') : null;
    if (stored === '0') return false;
    if (stored === '1') return true;
    return true;
}

/**
 * Probe results, per OffscreenCanvas constructor (a page has one; tests swap it).
 *
 * @type {WeakMap<object, boolean>}
 */
const offscreenWebgl2Probes = new WeakMap();

/**
 * Whether an OffscreenCanvas can give out a WebGL2 context at all.
 *
 * This is the check that has to happen *before* the transfer.
 * `transferControlToOffscreen()` is one-way: once the canvas belongs to the
 * worker, a worker that then fails to create its context leaves the main-thread
 * fallback with a canvas it can no longer draw into. Safari 16.4–16.x — inside
 * this bundle's browser floor — ships OffscreenCanvas and the transfer but only
 * the 2D context; WebGL on OffscreenCanvas arrived in Safari 17. Without this
 * probe such a browser would transfer the canvas and render nothing.
 *
 * Probed on this thread: no shipping browser offers WebGL2 on a worker's
 * OffscreenCanvas but not on the main thread's, or the other way round. The
 * probe context is released immediately and the answer cached.
 *
 * @returns {boolean}
 */
export function offscreenCanvasSupportsWebGL2() {
    if (typeof OffscreenCanvas === 'undefined') {
        return false;
    }
    const cached = offscreenWebgl2Probes.get(OffscreenCanvas);
    if (cached !== undefined) {
        return cached;
    }
    let supported = false;
    try {
        const probe = new OffscreenCanvas(1, 1);
        const gl = /** @type {WebGL2RenderingContext | null} */ (probe.getContext('webgl2'));
        supported = !!gl;
        // Contexts are a scarce per-page resource; do not keep this one.
        gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
    } catch (_) {
        supported = false;
    }
    offscreenWebgl2Probes.set(OffscreenCanvas, supported);
    return supported;
}

/**
 * Why this browser cannot host the render worker, or null when it can. The
 * reason is what `onUnsupported` reports, so a fallback says which capability
 * was missing instead of a generic list.
 *
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @returns {string | null}
 */
export function renderWorkerUnsupportedReason(canvas) {
    if (!canvas || typeof canvas.transferControlToOffscreen !== 'function') {
        return 'canvas.transferControlToOffscreen() unavailable';
    }
    if (typeof Worker === 'undefined') {
        return 'Worker unavailable';
    }
    if (typeof OffscreenCanvas === 'undefined') {
        return 'OffscreenCanvas unavailable';
    }
    if (!offscreenCanvasSupportsWebGL2()) {
        return 'OffscreenCanvas has no WebGL2 context (Safari < 17); keeping the canvas on the main thread';
    }
    return null;
}

/**
 * Doubles as the narrowing guard for {@link setupRenderWorker}: past this
 * check, `canvas` is present and can be transferred offscreen.
 *
 * Matches the browser matrix in docs/PERFORMANCE.md ("Render-worker browser
 * matrix"): Chromium and Firefox 105+ pass; Safari passes from 17, when WebGL on
 * OffscreenCanvas shipped, and falls back to the main thread before that.
 *
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @returns {canvas is HTMLCanvasElement}
 */
export function isRenderWorkerSupported(canvas) {
    return renderWorkerUnsupportedReason(canvas) === null;
}

/**
 * Canvases whose control went to a render worker. `transferControlToOffscreen()`
 * is one-way, so after a worker that took one fails to boot, the main-thread
 * fallback has to draw into a different element — see
 * {@link replaceTransferredCanvas}.
 *
 * @type {WeakSet<object>}
 */
const transferredCanvases = new WeakSet();

/**
 * Records that `canvas` was handed to a render worker.
 *
 * @param {HTMLCanvasElement} canvas
 */
export function markCanvasTransferred(canvas) {
    transferredCanvases.add(canvas);
}

/**
 * Whether `canvas` was handed to a render worker (and so can no longer give
 * out a drawing context on this thread).
 *
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @returns {boolean}
 */
export function isCanvasTransferred(canvas) {
    return !!canvas && transferredCanvases.has(canvas);
}

/**
 * Swaps a transferred canvas for a fresh copy of the element (same id, classes
 * and inline style, no children, no context) in the same place in the
 * document, and returns the copy. What the main-thread fallback draws into
 * after a render worker took the original and then failed to boot.
 *
 * Selectors keep resolving: the copy carries the original's id and classes.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {HTMLCanvasElement}
 */
export function replaceTransferredCanvas(canvas) {
    const fresh = /** @type {HTMLCanvasElement} */ (canvas.cloneNode(false));
    if (canvas.parentNode) {
        canvas.parentNode.replaceChild(fresh, canvas);
    }
    return fresh;
}
