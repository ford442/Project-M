// context/render.js
//
// ProjectMContext's render side: sizing the canvas (and the governor's
// internal render scale), following the container's size, the frame-rate
// monitor, the bound engine view, and the read-only reports about rendering
// (the WebGL context snapshot, the flash limiter's stats).

import { watchDevicePixelRatio } from '../projectm-init.js';
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
 * The devicePixelRatio to size the canvas with: the host's explicit
 * `devicePixelRatio` option when it set one, otherwise the window's current
 * ratio, read at the time of the call so zoom and display changes are seen.
 *
 * @param {{ devicePixelRatio?: number; windowRef?: { devicePixelRatio?: number } }} options
 * @returns {number}
 */
export function resolveDevicePixelRatio(options) {
    return options.devicePixelRatio || options.windowRef?.devicePixelRatio || globalThis.devicePixelRatio || 1;
}

/**
 * A size in device pixels, as a ResizeObserver's `devicePixelContentBoxSize`
 * reports it.
 *
 * @typedef {{ width: number, height: number }} DevicePixelSize
 */

/**
 * Sets a canvas's backing store, but only when it differs: assigning
 * `width`/`height` clears the drawing buffer even when the value is the same.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} width
 * @param {number} height
 * @returns {boolean} Whether anything was assigned.
 */
export function setBackingStore(canvas, width, height) {
    if (canvas.width === width && canvas.height === height) {
        return false;
    }
    canvas.width = width;
    canvas.height = height;
    return true;
}

/**
 * @param {{ transport: RenderTransport | null; container: Element; mainCanvas: HTMLCanvasElement; secondaryCanvas?: HTMLCanvasElement | null; aspectCorrection?: boolean; devicePixelRatio?: number; renderScale?: number; devicePixelSize?: DevicePixelSize | null }} options
 *   `devicePixelSize` is the container's exact content box in device pixels
 *   (ResizeObserver `device-pixel-content-box`). When given it is the layout
 *   size; otherwise that is the CSS rect times `devicePixelRatio`, which can be
 *   a pixel off where the browser snaps the box differently.
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
    devicePixelSize = null,
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

    // The canvas backing store (width/height attributes) is rendered at
    // renderScale * the layout size in device pixels, while its CSS box
    // (style.width/height) stays at the full, unscaled size. When renderScale <
    // 1 (governor v2 stepped down, see html/projectm-fps-governor.js) the
    // browser stretches the smaller backing store over the unchanged box with
    // its normal (filtered) canvas scaling: that is the "present upscale".
    const scale = renderScale > 0 ? renderScale : 1;
    let layoutWidth;
    let layoutHeight;
    if (devicePixelSize && devicePixelSize.width > 0 && devicePixelSize.height > 0) {
        layoutWidth = Math.round(devicePixelSize.width);
        layoutHeight = Math.round(devicePixelSize.height);
    } else {
        const rect = container.getBoundingClientRect();
        layoutWidth = Math.max(1, Math.round(rect.width * devicePixelRatio));
        layoutHeight = Math.max(1, Math.round(rect.height * devicePixelRatio));
    }
    const width = Math.max(1, Math.round(layoutWidth * scale));
    const height = Math.max(1, Math.round(layoutHeight * scale));

    // The CSS box is the device-pixel layout size over the DPR rather than the
    // raw (often fractional) container rect, so at full render scale the
    // bitmap lands 1:1 on device pixels instead of being resampled by a fraction.
    const cssWidth = `${layoutWidth / devicePixelRatio}px`;
    const cssHeight = `${layoutHeight / devicePixelRatio}px`;

    for (const canvas of [mainCanvas, secondaryCanvas]) {
        if (!canvas) continue;
        if (ownsBackingStore) {
            setBackingStore(canvas, width, height);
        }
        if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
        if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
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
 * The device-pixel content box an observer entry reports, if it has one
 * (Chrome 84+, Firefox 93+; Safari reports none and the caller falls back to
 * rect × devicePixelRatio).
 *
 * @param {ResizeObserverEntry | undefined} entry
 * @returns {DevicePixelSize | null}
 */
export function devicePixelSizeOf(entry) {
    const box = entry?.devicePixelContentBoxSize?.[0];
    if (!box || !(box.inlineSize > 0) || !(box.blockSize > 0)) {
        return null;
    }
    return { width: box.inlineSize, height: box.blockSize };
}

/**
 * Follows the container's size: a ResizeObserver on its
 * `device-pixel-content-box` where there is one (falling back to the content
 * box where that box is not supported), window resizes on the given window
 * otherwise. Either way it also follows the window's devicePixelRatio, which
 * can change without the container resizing.
 *
 * `onResize` gets the container's size in device pixels when the observer
 * reported one, and null when the caller should measure (a DPR change, a
 * window resize, a browser without the device-pixel box).
 *
 * @param {object} options
 * @param {Element} options.container
 * @param {any} [options.windowRef]
 * @param {(devicePixelSize: DevicePixelSize | null) => void} options.onResize
 * @returns {{ observer: ResizeObserver | null, dispose: () => void } | null}
 *   Null when there is neither (nothing to undo).
 */
export function followContainerSize({ container, windowRef, onResize }) {
    const target = /** @type {any} */ (windowRef ?? globalThis);
    const stopDprWatch = watchDevicePixelRatio(target, () => onResize(null));
    const Observer = target?.ResizeObserver ?? globalThis.ResizeObserver;
    if (container && typeof Observer === 'function') {
        /** @type {ResizeObserver} */
        const observer = new Observer((/** @type {ResizeObserverEntry[]} */ entries) => {
            onResize(devicePixelSizeOf(entries[entries.length - 1]));
        });
        try {
            observer.observe(container, { box: 'device-pixel-content-box' });
        } catch {
            observer.observe(container);
        }
        return {
            observer,
            dispose: () => {
                observer.disconnect();
                stopDprWatch();
            },
        };
    }
    // No ResizeObserver: fall back to window resizes, on the same window the
    // context is told to use, and take the listener off again.
    if (typeof target?.addEventListener !== 'function') {
        stopDprWatch();
        return null;
    }
    const listener = () => onResize(null);
    target.addEventListener('resize', listener);
    return {
        observer: null,
        dispose: () => {
            target.removeEventListener('resize', listener);
            stopDprWatch();
        },
    };
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
