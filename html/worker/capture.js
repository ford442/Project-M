// Part of the render worker (html/projectm-render-worker.js), which loads it with
// importScripts() before it handles any message. A classic script: no imports, no
// top-level state of its own beyond the one factory it publishes on `self`.
//
// The present-pass controls: the flash limiter and frame capture.

/**
 * @typedef {object} CaptureDeps
 * @property {(host: number | undefined) => WorkerModule | null} selectEngine The module as seen by one engine (see selectEngine() in projectm-render-worker.js).
 * @property {(message: RenderWorkerMessage, transfer?: Transferable[]) => void} postToHost
 */

/**
 * @param {CaptureDeps} deps
 */
function createWorkerCapture(deps) {
    const { postToHost } = deps;

    /**
     * Turns the selected engine's flash limiter on or off, threshold first, so a
     * limiter switched on never runs a frame on the previous threshold. Mirrors the
     * main-thread transport's setFlashLimit(). A bundle without the limiter ignores it.
     *
     * @param {FlashLimitSettings} settings
     * @param {number} [host] The engine; this worker's own when absent.
     */
    function applyFlashLimit(settings, host) {
        const m = deps.selectEngine(host);
        if (!m || typeof m._set_flash_limit_enabled !== 'function') return;
        if (typeof settings.threshold === 'number' && Number.isFinite(settings.threshold)) {
            m._set_flash_limit_threshold(settings.threshold);
        }
        m._set_flash_limit_enabled(settings.enabled ? 1 : 0);
    }

    /** capture_frame_status() values (FrameCaptureStatus in src/wasm/WasmHost.hpp). */
    const CAPTURE_IDLE = 0;
    const CAPTURE_READY = 3;
    const CAPTURE_FAILED = 4;
    const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;

    /**
     * Reads back the next frame the engine presents and posts its pixels to the
     * host. Mirrors captureFrameFromModule() in html/projectm-frame-capture.js,
     * duplicated for the same no-imports reason as the PCM ring helpers. Only this
     * side can read the frame: the drawing buffer is this worker's, and only holds
     * the image inside the render_frame() that drew it, which is where the engine
     * takes it (src/wasm/WasmPresent.cpp).
     *
     * @param {RenderWorkerCaptureFrameMessage} msg
     */
    async function captureFrame(msg) {
        // Every call through the view lands on msg.host's engine (a bundle
        // before ABI v2: the view is the module with that host activated, so
        // the wait below selects it again).
        let m = deps.selectEngine(msg.host);
        /** @param {string} error */
        const fail = (error) => postToHost({ type: 'frame-captured', requestId: msg.requestId, error });
        if (!m || typeof m._capture_frame_request !== 'function') {
            fail('this projectM bundle predates frame capture (capture_frame_request)');
            return;
        }
        if (!m._capture_frame_request()) {
            fail('captureFrame(): the engine has no WebGL context');
            return;
        }
        if (msg.renderFrame) {
            m._render_frame();
        }
        const timeoutMs = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : DEFAULT_CAPTURE_TIMEOUT_MS;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            // The render loop (or a sibling message) may have selected another
            // engine while this waited; the capture is this engine's.
            m = deps.selectEngine(msg.host) ?? m;
            const status = m._capture_frame_resolve(msg.renderFrame ? 1 : 0);
            if (status === CAPTURE_READY) break;
            if (status === CAPTURE_FAILED || status === CAPTURE_IDLE) {
                fail(`captureFrame(): the frame could not be read (status ${status})`);
                return;
            }
            if (performance.now() >= deadline) {
                m._capture_frame_release();
                fail(`captureFrame(): no frame was rendered within ${timeoutMs} ms`);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 4));
        }
        const width = m._capture_frame_width();
        const height = m._capture_frame_height();
        const ptr = m._capture_frame_data_ptr();
        const frameIndex = m._capture_frame_index();
        const length = width * height * 4;
        // Copied out of the (shared) heap into a buffer of its own, which is then
        // transferred rather than cloned.
        // Read the view now, not before the wait: a heap that grew meanwhile has a new one.
        const heap = m.HEAPU8;
        if (!heap) {
            m._capture_frame_release();
            fail('captureFrame(): this projectM bundle does not export HEAPU8');
            return;
        }
        const pixels = new ArrayBuffer(length);
        new Uint8Array(pixels).set(heap.subarray(ptr, ptr + length));
        m._capture_frame_release();
        postToHost({ type: 'frame-captured', requestId: msg.requestId, width, height, pixels, frameIndex }, [pixels]);
    }

    return { applyFlashLimit, captureFrame };
}

// `self` is the worker global in a real worker, but not in a bundler-wrapped or
// node:vm scope: publish on it explicitly so the entry script finds it.
self.createWorkerCapture = createWorkerCapture;
