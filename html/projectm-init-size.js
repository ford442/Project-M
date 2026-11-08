// Canvas sizing for the WASM host: keep Module's window size in step with the
// container and devicePixelRatio. Split out of projectm-init.js, which
// re-exports these.

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 */

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

    // The CSS box is the rounded backing store over the DPR, not the raw
    // (often fractional) container size, so the bitmap maps 1:1 onto device
    // pixels instead of being resampled by a fraction of a pixel.
    const cssWidth = width / dpr + 'px';
    const cssHeight = height / dpr + 'px';
    mainCanvas.style.width = cssWidth;
    mainCanvas.style.height = cssHeight;
    secondaryCanvas.style.width = cssWidth;
    secondaryCanvas.style.height = cssHeight;

    if (module._set_window_size) module._set_window_size(width, height);
    if (module._set_aspect_correction && aspectCorrection !== undefined) {
        module._set_aspect_correction(aspectCorrection ? 1 : 0);
    }
    return true;
}

/**
 * Calls `onChange` whenever the window's devicePixelRatio changes: browser
 * zoom, or the window moving to a display with a different pixel density.
 * The second case leaves the container's CSS size alone, so a ResizeObserver
 * never sees it and the backing store would stay at the old density.
 *
 * @param {{ matchMedia?: (query: string) => MediaQueryList, devicePixelRatio?: number } | undefined} windowRef
 * @param {() => void} onChange
 * @returns {() => void} Stops watching.
 */
export function watchDevicePixelRatio(windowRef, onChange) {
    if (!windowRef || typeof windowRef.matchMedia !== 'function') {
        return () => {};
    }
    const win = windowRef;
    /** @type {MediaQueryList | null} */
    let query = null;
    const listener = () => {
        query?.removeEventListener?.('change', listener);
        arm();
        onChange();
    };
    // A resolution query only matches the ratio it was built for, so it is
    // rebuilt for the new ratio after every change.
    const arm = () => {
        query = win.matchMedia?.(`(resolution: ${win.devicePixelRatio || 1}dppx)`) ?? null;
        query?.addEventListener?.('change', listener);
    };
    arm();
    return () => {
        query?.removeEventListener?.('change', listener);
        query = null;
    };
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
