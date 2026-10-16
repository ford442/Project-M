// projectm-frame-capture.js
//
// Reads one presented frame back from an engine on this thread: the main-thread
// half of ProjectMContext#captureFrame(). The render worker does the same steps
// in its own scope (html/projectm-render-worker.js, a classic worker that cannot
// import this) and posts the pixels back.
//
// The engine takes the frame inside render_frame(), after the compositor and
// before a manual-present commit (src/wasm/WasmPresent.cpp), so neither path
// needs preserveDrawingBuffer. On a manual-present host the read is
// asynchronous (a pixel-pack buffer behind a fence); this polls for it once per
// animation frame, or takes it at once when the caller rendered the frame itself.

import {
    captureFrameDataPtr,
    captureFrameHeight,
    captureFrameIndex,
    captureFrameRelease,
    captureFrameRequest,
    captureFrameResolve,
    captureFrameWidth,
    renderFrame as wasmRenderFrame,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMCapturedFrame} ProjectMCapturedFrame
 * @typedef {import('./projectm-context-types.ts').ProjectMCaptureFrameOptions} ProjectMCaptureFrameOptions
 */

/** capture_frame_status() values (FrameCaptureStatus in src/wasm/WasmHost.hpp). */
export const CAPTURE_STATUS = Object.freeze({
    idle: 0,
    requested: 1,
    pending: 2,
    ready: 3,
    failed: 4,
});

/** How long captureFrame() waits for the frame before giving up, by default. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;

/**
 * Waits for the next animation frame where there is one, else a short timer.
 *
 * @returns {Promise<void>}
 */
function nextTick() {
    return new Promise((resolve) => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 4);
        }
    });
}

/**
 * Whether `module` can capture frames at all (bundles before the present pass cannot).
 *
 * @param {any} module
 * @returns {boolean}
 */
export function supportsFrameCapture(module) {
    return !!module && typeof module._capture_frame_request === 'function';
}

/**
 * Captures the next frame `engine` renders and copies it off the module heap.
 *
 * `engine` is the module bound to one host (bindModuleToHost()), so every
 * export it calls reaches that host's own capture buffer however long this
 * waits — a sibling context capturing at the same time cannot take its frame.
 *
 * @param {any} engine
 * @param {ProjectMCaptureFrameOptions & { tick?: () => Promise<void>, now?: () => number }} [options]
 * @returns {Promise<ProjectMCapturedFrame>}
 */
export async function captureFrameFromModule(engine, {
    renderFrame = false,
    timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    tick = nextTick,
    now = () => Date.now(),
} = {}) {
    if (!supportsFrameCapture(engine)) {
        throw new Error('this projectM bundle predates frame capture (capture_frame_request)');
    }
    if (!captureFrameRequest(engine)) {
        throw new Error('captureFrame(): the engine has no WebGL context');
    }
    if (renderFrame) {
        // The offline-export path: the caller paused the render loop and owns
        // the clock, so this tick is the frame.
        wasmRenderFrame(engine);
    }

    const deadline = now() + timeoutMs;
    for (;;) {
        // A frame rendered just now can be taken at once; a live one is picked
        // up when its read has finished, without stalling the next frame.
        const status = captureFrameResolve(engine, renderFrame);
        if (status === CAPTURE_STATUS.ready) {
            break;
        }
        if (status === CAPTURE_STATUS.failed || status === CAPTURE_STATUS.idle) {
            throw new Error(`captureFrame(): the frame could not be read (status ${status})`);
        }
        if (now() >= deadline) {
            captureFrameRelease(engine);
            throw new Error(`captureFrame(): no frame was rendered within ${timeoutMs} ms`);
        }
        await tick();
    }

    const width = captureFrameWidth(engine);
    const height = captureFrameHeight(engine);
    const ptr = captureFrameDataPtr(engine);
    const frameIndex = captureFrameIndex(engine);
    const length = width * height * 4;
    // A copy: the heap view would change under the caller with the next capture,
    // and a shared-memory view cannot be transferred.
    const data = new Uint8ClampedArray(length);
    data.set(engine.HEAPU8.subarray(ptr, ptr + length));
    captureFrameRelease(engine);
    return { width, height, data, frameIndex };
}
