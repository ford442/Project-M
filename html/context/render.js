// context/render.js
//
// ProjectMContext's render side: sizing the canvas (and the governor's
// internal render scale), following the container's size, the frame-rate
// monitor, the bound engine view, and the read-only reports about rendering
// (the WebGL context snapshot, the flash limiter's stats).

import { observeModuleSize } from '../projectm-init.js';
import { decodeContextSnapshot } from '../projectm-context-config.js';
import { bindModuleToHost } from '../generated/projectm-wasm-api.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {import('../projectm-context-types.ts').ProjectMMeshQuality} ProjectMMeshQuality
 * @typedef {import('../projectm-context-types.ts').ProjectMFlashLimitStats} ProjectMFlashLimitStats
 * @typedef {import('../projectm-context-types.ts').ProjectMContextSnapshot} ProjectMContextSnapshot
 * @typedef {import('../projectm-render-worker-types.ts').WasmContextConfig} WasmContextConfig
 */

/**
 * @param {{ transport: RenderTransport | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number; renderScale?: number }} options
 * @returns {boolean}
 */
export function syncCanvasSize({
    transport,
    container,
    mainCanvas,
    secondaryCanvas,
    aspectCorrection,
    devicePixelRatio = globalThis.devicePixelRatio || 1,
    renderScale = 1,
}) {
    if (!transport || !container || !mainCanvas) {
        return false;
    }

    // In the worker topology the canvas has been transferred: assigning to its
    // width/height here throws, and the governor's render scale is applied on
    // the other side (html/projectm-render-worker.js). This thread still owns
    // the CSS box, which is what keeps the present upscale looking the same in
    // both topologies.
    const ownsBackingStore = transport.topology === 'main';

    const rect = container.getBoundingClientRect();
    // The canvas backing store (width/height attributes) is rendered at
    // renderScale * devicePixelRatio, while its CSS box size (style.width/height)
    // always stays at the full, unscaled container size. When renderScale < 1
    // (governor v2 stepped down internal render scale, see
    // html/projectm-fps-governor.js), the browser's own canvas-bitmap-to-CSS-box
    // scaling stretches the smaller backing store to fill the unchanged layout box
    // — this is the "present upscale" for internal FBO render scale; no separate
    // offscreen blit is needed because everything (including the dual-FBO
    // compositor) renders at the backing-store resolution already.
    const scale = renderScale > 0 ? renderScale : 1;
    const layoutWidth = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const layoutHeight = Math.max(1, Math.round(rect.height * devicePixelRatio));
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio * scale));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio * scale));

    if (ownsBackingStore) {
        mainCanvas.width = width;
        mainCanvas.height = height;
    }
    mainCanvas.style.width = `${rect.width}px`;
    mainCanvas.style.height = `${rect.height}px`;

    if (secondaryCanvas) {
        if (ownsBackingStore) {
            secondaryCanvas.width = width;
            secondaryCanvas.height = height;
        }
        secondaryCanvas.style.width = `${rect.width}px`;
        secondaryCanvas.style.height = `${rect.height}px`;
    }

    // The worker scales the layout size by its own copy of the render scale,
    // so sending it the already-scaled size would apply the factor twice.
    transport.resize(
        ownsBackingStore ? width : layoutWidth,
        ownsBackingStore ? height : layoutHeight,
    );
    if (aspectCorrection !== undefined && transport.supports('setAspectCorrection')) {
        transport.callVoid('setAspectCorrection', aspectCorrection);
    }

    return true;
}

/**
 * Follows the container's size: a ResizeObserver where there is one, window
 * resizes on the given window otherwise.
 *
 * @param {object} options
 * @param {Element} options.container
 * @param {EventTarget | undefined} options.windowRef
 * @param {() => void} options.onResize
 * @returns {{ observer: ResizeObserver | null, dispose: () => void } | null}
 *   Null when there is neither (nothing to undo).
 */
export function followContainerSize({ container, windowRef, onResize }) {
    const observer = observeModuleSize({ container, sync: onResize });
    if (observer) {
        return { observer, dispose: () => observer.disconnect() };
    }
    // No ResizeObserver: fall back to window resizes, on the same window the
    // context is told to use, and take the listener off again.
    const target = /** @type {EventTarget | undefined} */ (windowRef ?? globalThis);
    if (typeof target?.addEventListener !== 'function') {
        return null;
    }
    const listener = () => onResize();
    target.addEventListener('resize', listener);
    return { observer: null, dispose: () => target.removeEventListener('resize', listener) };
}

/**
 * The fields of ProjectMContext the frame-rate monitor keeps its state in.
 * They are public (hosts and tests read them), so the monitor writes them
 * rather than keeping a copy.
 *
 * @typedef {{ fpsTimer: number, fpsFrameCount: number, fpsLastSample: number }} FpsCounters
 */

/**
 * Reports the main-thread engine's frame rate once a second, from its frame
 * counter, on animation frames.
 *
 * @param {FpsCounters} counters
 * @param {object} options
 * @param {() => ProjectMModule | null} options.getEngine
 * @param {() => boolean} options.stopped
 * @param {(fps: number) => void} options.onFps
 * @returns {() => void} Stops it.
 */
export function startFpsMonitor(counters, { getEngine, stopped, onFps }) {
    const sample = () => {
        const engine = getEngine();
        if (stopped() || !engine) {
            return;
        }

        const now = performance.now();
        const frameCount = engine._get_rendered_frame_count?.() ?? 0;
        if (!counters.fpsLastSample) {
            counters.fpsLastSample = now;
            counters.fpsFrameCount = frameCount;
        }

        const elapsed = (now - counters.fpsLastSample) / 1000;
        if (elapsed >= 1) {
            const fps = (frameCount - counters.fpsFrameCount) / elapsed;
            onFps(fps);
            counters.fpsLastSample = now;
            counters.fpsFrameCount = frameCount;
        }

        counters.fpsTimer = requestAnimationFrame(sample);
    };
    counters.fpsTimer = requestAnimationFrame(sample);
    return () => {
        if (counters.fpsTimer) {
            cancelAnimationFrame(counters.fpsTimer);
            counters.fpsTimer = 0;
        }
        counters.fpsLastSample = 0;
    };
}

/**
 * The main-thread engine for a module and host: the module bound to `host`
 * (see bindModuleToHost() in generated/projectm-wasm-api.js) so every export
 * called through it selects that host first. Cached, because a bound view is
 * a wrapper per export and the context asks for it on every call.
 *
 * @returns {(module: ProjectMModule | null, host: number) => ProjectMModule | null}
 */
export function createEngineBinder() {
    /** @type {{ module: ProjectMModule, host: number, view: ProjectMModule } | null} */
    let cached = null;
    return (module, host) => {
        if (!module) {
            return null;
        }
        if (cached && cached.module === module && cached.host === host) {
            return cached.view;
        }
        const view = bindModuleToHost(module, host);
        cached = { module, host, view };
        return view;
    };
}

/**
 * The mesh a quality name selects, for the worker topology (on the main thread
 * setMeshQuality() resolves 'auto' against the device itself).
 *
 * @param {ProjectMMeshQuality} quality
 * @returns {[number, number]}
 */
export function meshGridFor(quality) {
    return quality === 'low' ? [64, 48] : [80, 60];
}

/**
 * The transport's `get_context_snapshot()` result, decoded. Null on a bundle
 * without the export: the snapshot is information, and not having it must not
 * fail a start or a recovery.
 *
 * Given the config the engine was created with, the snapshot lists where the
 * context's real attributes differ from it (`mismatches`), and each difference
 * is logged once here: a context without the attributes it was asked for is
 * otherwise invisible until something renders wrong.
 *
 * @param {RenderTransport} transport
 * @param {WasmContextConfig} [requested]
 * @returns {ProjectMContextSnapshot | null}
 */
export function readContextSnapshot(transport, requested) {
    const packed = transport.contextSnapshot();
    const snapshot = packed === null ? null : decodeContextSnapshot(packed, requested);
    if (snapshot && snapshot.mismatches.length > 0) {
        const list = snapshot.mismatches
            .map(({ attribute, requested: want, effective }) => `${attribute} ${String(want)} -> ${String(effective)}`)
            .join(', ');
        console.warn(`[projectM] the WebGL context does not have the requested attributes (requested -> effective): ${list}`);
    }
    return snapshot;
}

/**
 * The flash limiter's state, or null before start() or on a bundle without it.
 *
 * @param {RenderTransport | null} transport
 * @returns {Promise<ProjectMFlashLimitStats | null>}
 */
export async function readFlashLimitStats(transport) {
    if (!transport || !transport.supports('getFlashLimitClampedFrames')) {
        return null;
    }
    const [enabled, threshold, clampedFrames] = await Promise.all([
        transport.call('getFlashLimitEnabled'),
        transport.call('getFlashLimitThreshold'),
        transport.call('getFlashLimitClampedFrames'),
    ]);
    return {
        enabled: !!enabled,
        threshold: Number(threshold),
        clampedFrames: Number(clampedFrames),
    };
}
