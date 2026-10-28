// Render worker for projectM (OffscreenCanvas path).
//
// The default render topology (see projectm-render-worker-host.js), with the
// main-thread render loop in projectm-core.html as the fallback.
// The main thread transfers control of the WebGL canvas to this worker via
// canvas.transferControlToOffscreen(), then this worker loads the same WASM
// module used on the main thread and drives _start_render()/the Emscripten
// main loop here instead.
//
// Message protocol (host -> worker):
//   { type: 'init', canvas, scriptSrc, width, height, targetFps, governor, meshQuality,
//     contextConfig, renderPathOverrides }
//   { type: 'resize', width, height, host }
//   { type: 'pcm', buffer, channels }                 // only when the ring cannot be shared
//   { type: 'preset', vfsPath, bytes, mode, host }
//   { type: 'ccall', name, returnType, argTypes, args, requestId, host }
//   { type: 'recover-context', host }                 // rebuild the engine after a context loss
//   { type: 'set-flash-limit', enabled, threshold, host }   // the engine's flash limiter
//   { type: 'capture-frame', requestId, renderFrame, timeoutMs, host }  // read back the next frame
//   { type: 'shutdown' }                              // stop the stats tick, destruct the engine
//
//   `host` is the engine the message is for (what 'ready' reported); the worker
//   selects it before acting. Absent or 0 means the worker's own engine.
//
// Message protocol (worker -> host):
//   { type: 'ready', host }                           // host = this worker's engine handle
//   { type: 'unsupported', reason }
//   { type: 'init-error', code, message }             // init() failed or threw; the host falls back
//   { type: 'error', message }
//   { type: 'stats', fps, fboFormat, qualityTier, renderScale, renderPathOverrides }
//   { type: 'pcm-ring', descriptor }
//   { type: 'ccall-result', requestId, result }
//   { type: 'ccall-rejected', requestId, message }    // the ccall with that requestId threw
//   { type: 'shutdown-complete' }                     // answer to 'shutdown'; terminate now
//   { type: 'context-lost' }                          // webglcontextlost on the OffscreenCanvas
//   { type: 'context-restored' }                      // webglcontextrestored; engine not rebuilt yet
//   { type: 'context-recovered', status }             // outcome of 'recover-context' (init() code)
//   { type: 'perf-frames', frames }                   // perf-HUD frames, batched (~100 ms)
//   { type: 'perf-hud', enabled }                     // set_perf_hud() toggled the instrumentation
//   { type: 'rhythm-event', event }                   // a beat/bar/section (set_rhythm_events(1))
//   { type: 'frame-captured', requestId, width, height, pixels, frameIndex } | { ..., error }
//
// Audio: the module owns its PCM ring (src/wasm/WasmPcmRing.cpp) and drains it
// in render_frame(), exactly as on the main thread. This worker's only jobs are
// to hand the host the ring descriptor when the memory is shareable, and to
// write posted PCM into the ring when it is not. It no longer runs a drain of
// its own — the C++ drain replaced it, which is what makes the two topologies
// behave identically.

/**
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingDescriptor} PcmRingDescriptor
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerHostMessage} RenderWorkerHostMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerInitMessage} RenderWorkerInitMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerCcallMessage} RenderWorkerCcallMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerPresetMessage} RenderWorkerPresetMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerMessage} RenderWorkerMessage
 * @typedef {import('./projectm-render-worker-types.ts').PerfFrameStats} PerfFrameStats
 * @typedef {import('./projectm-render-worker-types.ts').RhythmEvent} RhythmEvent
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerCaptureFrameMessage} RenderWorkerCaptureFrameMessage
 * @typedef {import('./projectm-render-worker-types.ts').FlashLimitSettings} FlashLimitSettings
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * The module as this worker probes it. ProjectMModule types every manifest
 * export as present, and each is still checked with `typeof ... === 'function'`
 * before a call because an older bundle may lack it; these are the runtime
 * members the manifest does not describe at all.
 *
 * @typedef {ProjectMModule & {
 *   HEAPU8?: Uint8Array,
 *   specialHTMLTargets?: Record<string, unknown>,
 *   _create_host_with_config?: (...args: number[]) => number,
 *   FS?: { writeFile: (path: string, data: Uint8Array | string) => void, mkdirTree?: (path: string) => void },
 * }} WorkerModule
 */

/**
 * The engine-to-host hooks the C++ side looks up on `globalThis` — in a worker,
 * this scope (see WasmPerfGovernor.cpp / WasmRhythm.cpp).
 *
 * @typedef {object} EngineHooks
 * @property {(...args: unknown[]) => void} [pmOnGovernorRenderScaleChange]
 * @property {(stats: PerfFrameStats) => void} [pmOnPerfFrame]
 * @property {(...args: unknown[]) => void} [pmSetPerfHudEnabled]
 * @property {(event: RhythmEvent) => void} [pmOnRhythmEvent]
 */

/** `self`, with the engine hooks this worker publishes on it. */
const hookScope = /** @type {typeof self & EngineHooks} */ (self);

/**
 * The Emscripten factory that `importScripts(scriptSrc)` defines on the worker
 * global. The glue is loaded at run time, not imported, so there is nothing to
 * declare a binding for.
 *
 * Read through `self` rather than a bare `var createModule`. In a classic worker
 * the two are the same binding, but any bundler that wraps this file in a module
 * or IIFE scope turns the bare declaration into a *local* that importScripts can
 * never assign — and Vite's `new Worker(new URL(..., import.meta.url))` pipeline
 * does exactly that to every npm consumer of @projectm/web. The factory then
 * reads as permanently undefined, init() bails with "createModule not defined
 * after importScripts", and a minifier that can prove it dead-code-eliminates
 * the preset and ccall handlers along with it.
 *
 * @returns {((config: Record<string, unknown>) => Promise<ProjectMModule>) | undefined}
 */
function getCreateModule() {
    return /** @type {{ createModule?: (config: Record<string, unknown>) => Promise<ProjectMModule> }} */ (
        /** @type {unknown} */ (self)
    ).createModule;
}

/**
 * Posts a reply to the host.
 *
 * Wrapping `self.postMessage` is what makes the worker->host half of the
 * protocol checkable: the raw signature takes `any`, so a renamed or mistyped
 * field would post happily and fail only at runtime on the other side. Going
 * through {@link RenderWorkerMessage} turns that into a build error.
 *
 * @param {RenderWorkerMessage} message
 * @param {Transferable[]} [transfer]
 */
function postToHost(message, transfer = []) {
    self.postMessage(message, transfer);
}

/** @type {WorkerModule | null} */
let Module = null;
/** This worker's engine: create_host_with_config()'s handle, 0 until it exists. */
let engineHost = 0;
let statsInterval = 0;
let lastFrameTime = 0;
let lastFps = 0;

/**
 * The transferred canvas. The host cannot touch its width/height any more —
 * assigning to a transferred canvas throws there — so every backing-store
 * resize has to happen on this side.
 *
 * @type {OffscreenCanvas | null}
 */
let surface = null;

/** Layout size in device pixels, before the governor's render scale. */
let surfaceWidth = 0;
let surfaceHeight = 0;

/**
 * Governor v2 internal render scale (1.0/0.75/0.5). Same contract as the
 * main-thread path in html/projectm-context.js: the backing store shrinks
 * while the CSS box (which lives on the main thread and is not ours) stays
 * put, and the browser upscales on present.
 */
let renderScale = 1;

/**
 * Resize the drawing surface to the layout size times the governor's render
 * scale, then tell the engine. Called for host resizes and for governor tier
 * changes alike, so the two cannot disagree about the final size.
 */
function applySurfaceSize() {
    if (!surface || surfaceWidth <= 0 || surfaceHeight <= 0) return;

    const scale = renderScale > 0 ? renderScale : 1;
    const width = Math.max(1, Math.round(surfaceWidth * scale));
    const height = Math.max(1, Math.round(surfaceHeight * scale));

    if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
    }
    if (Module && Module._set_window_size) {
        Module._set_window_size(width, height);
    }
}

/**
 * Makes `host` (or this worker's engine, for 0/absent) the active one before a
 * control message acts on it. Mirrors bindModuleToHost() on the main thread:
 * with two engines in this module, which one a call reaches must come from the
 * message, not from whichever was activated last.
 *
 * @param {number | undefined} host
 */
function selectEngine(host) {
    const target = host || engineHost;
    if (!target || !Module) return;
    // The common case — one engine, already active — costs no make-current.
    const module = Module;
    if (typeof module._get_active_host === 'function' && module._get_active_host() === target) return;
    try {
        Module.ccall('set_active_host', null, ['number'], [target]);
    } catch (_) {
        // A bundle without the export has one engine; nothing to select.
    }
}

/**
 * Reads an engine callback in either bundle shape — 040+ passes the engine's
 * handle first, older ones only the payload (`fieldCount` values) — and says
 * whether it is about this worker's engine. Mirrors decodeWasmCallback() in
 * html/projectm-wasm-callbacks.js; duplicated because this classic worker
 * cannot import it.
 *
 * @param {unknown[]} args
 * @param {number} fieldCount
 * @returns {{ ours: boolean, values: unknown[] }}
 */
function engineCallback(args, fieldCount) {
    const scoped = args.length > fieldCount;
    const host = scoped ? Number(args[0]) : null;
    // Before create_host_with_config() returns, engineHost is still 0 and the
    // engine being created is the only one there is.
    const ours = host === null || !engineHost || host === engineHost;
    return { ours, values: scoped ? args.slice(1) : args };
}

// WasmPerfGovernor.cpp pushes tier changes through globalThis — which in a
// worker is this scope, not a window. That is the whole point of the
// globalThis migration in src/wasm/: the same C++ hook reaches the host in
// either topology, and governor v2 is no longer main-thread-only.
/** @param {unknown[]} args `(host, scale)`, or `(scale)` before bundle 040. */
const onGovernorRenderScaleChange = (...args) => {
    const { ours, values } = engineCallback(args, 1);
    if (!ours) return;
    renderScale = Number(values[0]) || 1;
    applySurfaceSize();
};
hookScope.pmOnGovernorRenderScaleChange = onGovernorRenderScaleChange;

// The perf HUD (html/projectm-perf.js) lives on the page, but the engine reports
// to `globalThis.pmOnPerfFrame` / `pmSetPerfHudEnabled` — this scope. Relay both,
// so `?perfhud=1` works in the default topology rather than only with
// `?renderWorker=0`.
//
// Frames are batched: the HUD repaints at most every 200 ms, and a postMessage
// per frame would be 60+ structured clones a second for nothing. A benchmark
// still sees every frame, because the host replays the batch in order.
const PERF_FLUSH_INTERVAL_MS = 100;
/** @type {PerfFrameStats[]} */
let perfFrames = [];
let perfLastFlush = 0;

function flushPerfFrames() {
    if (perfFrames.length === 0) return;
    const frames = perfFrames;
    perfFrames = [];
    perfLastFlush = performance.now();
    postToHost({ type: 'perf-frames', frames });
}

/** @param {PerfFrameStats} stats */
const onPerfFrame = (stats) => {
    if (typeof stats?.host === 'number' && engineHost && stats.host !== engineHost) return;
    perfFrames.push(stats);
    if (performance.now() - perfLastFlush >= PERF_FLUSH_INTERVAL_MS) {
        flushPerfFrames();
    }
};
hookScope.pmOnPerfFrame = onPerfFrame;

/** @param {unknown[]} args `(host, enabled)`, or `(enabled)` before bundle 040. */
const onPerfHudEnabled = (...args) => {
    const { ours, values } = engineCallback(args, 1);
    if (!ours) return;
    const enabled = !!values[0];
    if (!enabled) {
        // Whatever is buffered was measured; hand it over before the HUD goes.
        flushPerfFrames();
    }
    postToHost({ type: 'perf-hud', enabled });
};
hookScope.pmSetPerfHudEnabled = onPerfHudEnabled;

// Beat/bar/section events (src/wasm/WasmRhythm.cpp) land in this scope too.
// Relayed one by one: the engine only reports frames that carry an event, a few
// a second, and batching them would make every beat arrive late.
/** @param {RhythmEvent} event */
const onRhythmEvent = (event) => {
    if (engineHost && event.host !== engineHost) return;
    postToHost({ type: 'rhythm-event', event: { ...event } });
};
hookScope.pmOnRhythmEvent = onRhythmEvent;

/**
 * Reads the module's PCM ring descriptor. Mirrors readPcmRingDescriptor() in
 * html/projectm-pcm-ring.js — this is a classic worker (importScripts, no ES
 * module imports), so the few lines are duplicated rather than imported.
 *
 * @returns {PcmRingDescriptor | null}
 */
function readPcmRingDescriptor() {
    const m = Module;
    if (!m || typeof m._get_pcm_ring_data_ptr !== 'function') return null;

    let dataPtr = m._get_pcm_ring_data_ptr();
    if (!dataPtr && typeof m._pcm_ring_init === 'function') {
        m._pcm_ring_init(0);
        dataPtr = m._get_pcm_ring_data_ptr();
    }
    const headerPtr = m._get_pcm_ring_header_ptr();
    const capacityFrames = m._get_pcm_ring_capacity_frames();
    const indexModulus = m._get_pcm_ring_index_modulus();
    const memory = m.HEAPF32?.buffer;
    if (!dataPtr || !headerPtr || capacityFrames <= 0 || indexModulus <= 0 || !memory) {
        return null;
    }
    return { memory, headerPtr, dataPtr, capacityFrames, indexModulus };
}

/**
 * Hands the host the ring descriptor, if the module's memory can cross the
 * postMessage boundary. Without cross-origin isolation it is a plain
 * ArrayBuffer, which cannot be shared, and the host keeps posting PCM instead.
 */
function publishPcmRing() {
    const descriptor = readPcmRingDescriptor();
    if (!descriptor) return;
    if (typeof SharedArrayBuffer === 'undefined'
        || !(descriptor.memory instanceof SharedArrayBuffer)) {
        return;
    }
    postToHost({ type: 'pcm-ring', descriptor });
}

/**
 * Writes posted PCM into the module's ring. Mirrors createPcmRingWriter().write()
 * in html/projectm-pcm-ring.js, for the same no-imports reason.
 *
 * @param {Float32Array} buffer Interleaved stereo, or mono when channels is 1.
 * @param {number} channels
 */
function writePcmToRing(buffer, channels) {
    const descriptor = readPcmRingDescriptor();
    if (!descriptor || !buffer || buffer.length === 0) return;

    const { memory, headerPtr, dataPtr, capacityFrames, indexModulus } = descriptor;
    const header = new Int32Array(memory, headerPtr, 4);
    const data = new Float32Array(memory, dataPtr, capacityFrames * 2);

    const stereo = channels === 2;
    let frames = stereo ? (buffer.length >> 1) : buffer.length;
    if (frames <= 0) return;

    let offset = 0;
    if (frames > capacityFrames) {
        offset = frames - capacityFrames;
        frames = capacityFrames;
    }

    const writeIndex = Atomics.load(header, 0);
    for (let i = 0; i < frames; i += 1) {
        const slot = ((writeIndex + i) % capacityFrames) * 2;
        const src = offset + i;
        if (stereo) {
            data[slot] = buffer[src * 2];
            data[slot + 1] = buffer[src * 2 + 1];
        } else {
            const sample = buffer[src];
            data[slot] = sample;
            data[slot + 1] = sample;
        }
    }
    Atomics.store(header, 0, (writeIndex + frames) % indexModulus);
}

/**
 * The ring header counters for the stats message. Mirrors readPcmRingCounters()
 * in html/projectm-pcm-ring.js.
 *
 * @returns {import('./projectm-render-worker-types.ts').PcmRingCounters | undefined}
 */
function readPcmRingCounters() {
    const descriptor = readPcmRingDescriptor();
    if (!descriptor) return undefined;
    const header = new Int32Array(descriptor.memory, descriptor.headerPtr, 4);
    return {
        writeIndex: Atomics.load(header, 0),
        readIndex: Atomics.load(header, 2),
        overruns: Atomics.load(header, 3),
        capacityFrames: descriptor.capacityFrames,
        indexModulus: descriptor.indexModulus,
        sampledAt: performance.now(),
    };
}

/**
 * `webglcontextlost` / `webglcontextrestored` fire on the OffscreenCanvas, which
 * lives in this scope — the page gave the canvas away and cannot hear them. So
 * this side does what the main-thread path does in the page (preventDefault so
 * the browser may restore the context, then tear down projectM's GL state with
 * pm_handle_context_loss()) and only *tells* the host; the host drives the
 * re-init with 'recover-context', exactly as it does on the main thread.
 *
 * @param {OffscreenCanvas} canvas
 */
function installContextLossHandlers(canvas) {
    if (typeof canvas.addEventListener !== 'function') return;

    canvas.addEventListener('webglcontextlost', (event) => {
        // Required for the browser to consider restoring the context at all.
        event.preventDefault();
        const module = Module;
        if (module && typeof module._pm_handle_context_loss === 'function') {
            module._pm_handle_context_loss();
        }
        postToHost({ type: 'context-lost' });
    });
    canvas.addEventListener('webglcontextrestored', () => {
        postToHost({ type: 'context-restored' });
    });
}

/**
 * Rebuilds the engine on the restored context: `init()` is the re-init export
 * (it replaces whatever engine is left and refuses with code 5 while the
 * context is still lost), and `start_render()` re-creates the dual-FBO pipeline
 * at the surface's current size. The PCM ring is re-published because a host
 * that lost its ring writer with the engine must be able to map it again.
 */
/** @param {number | undefined} host */
function recoverContext(host) {
    if (!Module || !surface) {
        postToHost({ type: 'context-recovered', status: -1 });
        return;
    }

    let status;
    try {
        selectEngine(host);
        status = Module._init();
        if (status === 0) {
            Module._start_render(surface.width, surface.height);
        }
    } catch (error) {
        postToHost({ type: 'error', message: `context recovery failed: ${error}` });
        postToHost({ type: 'context-recovered', status: -1 });
        return;
    }
    if (status === 0) {
        publishPcmRing();
    }
    postToHost({ type: 'context-recovered', status, ...(status === 0 ? contextSnapshotField() : {}) });
}

/**
 * get_context_snapshot() as a message field, so the host reads what the worker's
 * context negotiated without a round trip it would have to wait for. Absent from
 * a bundle that predates the export.
 *
 * @returns {{ contextSnapshot?: number }}
 */
function contextSnapshotField() {
    const m = Module;
    return m && typeof m._get_context_snapshot === 'function'
        ? { contextSnapshot: m._get_context_snapshot() }
        : {};
}

function postStats() {
    // A render loop that stopped (hidden tab, lost context) would otherwise
    // strand the last partial batch until it resumed.
    flushPerfFrames();
    if (!Module) return;

    const now = performance.now();
    if (lastFrameTime) {
        const delta = now - lastFrameTime;
        if (delta > 0) {
            lastFps = 1000 / delta;
        }
    }
    lastFrameTime = now;

    const pcmRing = readPcmRingCounters();
    postToHost({
        type: 'stats',
        fps: lastFps,
        fboFormat: Module._dual_fbo_get_format ? Module._dual_fbo_get_format() : -1,
        qualityTier: Module._get_quality_tier ? Module._get_quality_tier() : -1,
        renderScale,
        renderPathOverrides: Module._get_render_path_overrides ? Module._get_render_path_overrides() : -1,
        ...(pcmRing ? { pcmRing } : {}),
    });
}

/**
 * Writes a preset into the module's VFS and acts on it.
 *
 * The write and the call belong together: a load against a path that was never
 * written is a preset-parser error with no useful message, so a failure on
 * either half is reported the same way.
 *
 * @param {ProjectMModule} module
 * @param {RenderWorkerPresetMessage} msg
 */
function handlePreset(module, msg) {
    const fs = /** @type {WorkerModule} */ (module).FS;
    if (!fs) {
        postToHost({ type: 'error', message: 'preset write failed: module has no FS' });
        return;
    }
    try {
        // A bundle that preloads no presets has no /presets to write into, and
        // the failure is a bare ErrnoError 44 that says nothing useful.
        const dir = msg.vfsPath.slice(0, msg.vfsPath.lastIndexOf('/'));
        if (dir && fs.mkdirTree) fs.mkdirTree(dir);
    } catch (_) {
        // Already there, or the FS has no mkdirTree; the write below reports it.
    }
    try {
        fs.writeFile(msg.vfsPath, msg.bytes);
    } catch (error) {
        postToHost({ type: 'error', message: `preset write failed for ${msg.vfsPath}: ${error}` });
        return;
    }

    const symbol = msg.mode === 'add'
        ? 'add_preset_file'
        : (msg.mode === 'load-hard' ? 'load_preset_file_hard' : 'load_preset_file');
    try {
        module.ccall(symbol, null, ['string'], [msg.vfsPath]);
    } catch (error) {
        postToHost({ type: 'error', message: `${symbol} failed for ${msg.vfsPath}: ${error}` });
    }
}

/**
 * @param {ProjectMModule} module Passed in so the caller's readiness check narrows here too.
 * @param {RenderWorkerCcallMessage} msg
 */
function handleCcall(module, msg) {
    let result;
    try {
        result = module.ccall(msg.name, msg.returnType || null, msg.argTypes || [], msg.args || []);
    } catch (error) {
        const message = `ccall ${msg.name} failed: ${error}`;
        // A call with a requestId has a promise waiting on the host; settle it.
        // Fire-and-forget calls have nobody to answer, so they stay an error.
        if (msg.requestId !== undefined) {
            postToHost({ type: 'ccall-rejected', requestId: msg.requestId, message });
        } else {
            postToHost({ type: 'error', message });
        }
        return;
    }
    if (msg.requestId !== undefined) {
        postToHost({ type: 'ccall-result', requestId: msg.requestId, result });
    }
}

/**
 * Turns the selected engine's flash limiter on or off, threshold first, so a
 * limiter switched on never runs a frame on the previous threshold. Mirrors the
 * main-thread transport's setFlashLimit(). A bundle without the limiter ignores it.
 *
 * @param {FlashLimitSettings} settings
 */
function applyFlashLimit(settings) {
    const m = Module;
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
    const m = Module;
    /** @param {string} error */
    const fail = (error) => postToHost({ type: 'frame-captured', requestId: msg.requestId, error });
    if (!m || typeof m._capture_frame_request !== 'function') {
        fail('this projectM bundle predates frame capture (capture_frame_request)');
        return;
    }
    selectEngine(msg.host);
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
        selectEngine(msg.host);
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

/**
 * Where this worker is in its one boot. A worker hosts one engine on one
 * transferred canvas, so a second 'init' is refused rather than run: it would
 * start a second stats tick next to the first and point the engine hooks at an
 * engine the host never heard about.
 *
 * @type {'idle' | 'booting' | 'ready' | 'failed' | 'shut-down'}
 */
let bootState = 'idle';

function stopStats() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = 0;
    }
}

/** The engine's init error code, or -1 when there is no module to ask. */
function lastInitErrorCode() {
    const m = /** @type {{ _get_last_init_error?: () => number } | null} */ (Module);
    try {
        return typeof m?._get_last_init_error === 'function' ? Number(m._get_last_init_error()) : -1;
    } catch (_) {
        return -1;
    }
}

/**
 * Runs {@link init} and turns every way it can fail into an `init-error` the
 * host acts on. Without this a throw after createModule() resolved — from
 * create_host_with_config(), start_render() or any setter after it — was an
 * unhandled rejection in this scope: `worker.onerror` does not fire for those,
 * so the host waited for a 'ready' that never came.
 *
 * @param {RenderWorkerInitMessage} msg
 */
function runInit(msg) {
    if (bootState !== 'idle') {
        postToHost({ type: 'init-error', code: -1, message: `render worker already initialised (state: ${bootState})` });
        return;
    }
    bootState = 'booting';
    init(msg).then(
        (ok) => {
            if (bootState === 'booting') bootState = ok ? 'ready' : 'failed';
        },
        (error) => {
            stopStats();
            if (bootState === 'shut-down') return;
            bootState = 'failed';
            postToHost({
                type: 'init-error',
                code: lastInitErrorCode(),
                message: `render worker init threw: ${error}`,
            });
        },
    );
}

/**
 * Ends this worker's engine before the host terminates it: stops the stats
 * tick, hands over buffered perf frames, and destructs the engine the way the
 * main-thread transport does. Answers 'shutdown-complete' so the host can
 * terminate without waiting out its deadline.
 */
function shutdown() {
    const wasBooting = bootState === 'booting';
    bootState = 'shut-down';
    stopStats();
    flushPerfFrames();
    const m = /** @type {{ _destruct?: () => void } | null} */ (Module);
    // A boot still in flight has no engine yet; init() sees the state and stops.
    if (!wasBooting && m && typeof m._destruct === 'function') {
        try {
            m._destruct();
        } catch (error) {
            postToHost({ type: 'error', message: `engine shutdown failed: ${error}` });
        }
    }
    Module = null;
    engineHost = 0;
    surface = null;
    postToHost({ type: 'shutdown-complete' });
}

/**
 * @param {RenderWorkerInitMessage} msg
 * @returns {Promise<boolean>} Whether the engine is running and 'ready' was posted.
 */
async function init(msg) {
    if (typeof OffscreenCanvas === 'undefined' || typeof importScripts !== 'function') {
        postToHost({ type: 'unsupported', reason: 'OffscreenCanvas or importScripts unavailable in worker' });
        return false;
    }

    try {
        importScripts(msg.scriptSrc);
    } catch (error) {
        postToHost({ type: 'unsupported', reason: `failed to load ${msg.scriptSrc}: ${error}` });
        return false;
    }

    const createModule = getCreateModule();
    if (typeof createModule !== 'function') {
        postToHost({ type: 'unsupported', reason: 'createModule not defined after importScripts' });
        return false;
    }

    try {
        Module = await createModule({
            canvas: msg.canvas,
            // The wrapper's main() calls init() the moment the module loads,
            // and init() needs the canvas registered below — which cannot
            // happen until the module object exists. So boot it inert and run
            // init() ourselves, exactly as ProjectMContext does on the main
            // thread.
            noInitialRun: true,
            // Where the pthread pool Workers load their copy of the glue from.
            //
            // Emscripten derives that URL from the running script's own
            // location, which inside this classic worker is html/, not the
            // directory we importScripts()'d the glue from. Every pool worker
            // then re-loaded *this* script, none joined the pool, and
            // createModule() waited forever for a pool that could not fill —
            // the silent boot hang that kept this topology opt-in. The glue
            // honours this override via src/wasm/pthread_script_url.pre.js.
            mainScriptUrlOrBlob: msg.scriptSrc,
            // Smoke wrapper embeds projectm-v.030-thread.wasm; deploy renames to
            // projectm-v.<ver>-thread.*. Remap from the loaded script URL so pm/
            // does not 404 to the UTF-16 HTML ErrorDocument.
            /**
             * @param {string} path
             * @param {string} [prefix]
             */
            locateFile(path, prefix = '') {
                const smoke = 'projectm-v.030-thread';
                const match = /projectm-v\.\d+-thread/.exec(msg.scriptSrc || '');
                const target = match ? match[0] : null;
                let remapped = path;
                if (target && target !== smoke && typeof path === 'string' && path.includes(smoke)) {
                    remapped = path.split(smoke).join(target);
                }
                // The sibling .wasm/.ww.js live next to the *glue* we
                // importScripts()'d, not next to this worker script. Emscripten's
                // `prefix` is the latter — this worker's own directory — so using
                // it fetches html/projectm-v.0NN-thread.wasm, gets the 404 body,
                // and fails with "expected magic word". Resolve against the glue
                // URL the host gave us instead.
                if (msg.scriptSrc) {
                    try {
                        return new URL(remapped, msg.scriptSrc).href;
                    } catch (_) {
                        // Not a resolvable URL (a bare filename in a test); fall
                        // through to Emscripten's own prefix.
                    }
                }
                return `${prefix || ''}${remapped}`;
            },
        });
    } catch (error) {
        postToHost({ type: 'init-error', code: -1, message: `module init failed: ${error}` });
        return false;
    }
    // The host gave up (shutdown) while the module was loading.
    if (bootState === 'shut-down') {
        return false;
    }

    // Give the engine its canvas. emscripten_webgl_create_context("#mcanvas")
    // resolves that selector through findEventTarget(), which checks
    // specialHTMLTargets first and falls back to document.querySelector() —
    // and there is no document here. Registering the transferred canvas under
    // the selector the engine already uses means the C++ side needs no
    // worker-specific path at all.
    const targets = Module.specialHTMLTargets;
    if (!targets) {
        postToHost({
            type: 'unsupported',
            reason: 'bundle does not export specialHTMLTargets; rebuild with the current EXPORTED_RUNTIME_METHODS',
        });
        return false;
    }
    targets['#mcanvas'] = msg.canvas;

    // Both are decided when the engine is created — the context attributes are
    // baked into the context it creates, the render paths are fixed before the
    // first preset — and neither can be read from here: this scope has no page
    // URL. The render paths go first; the context config is an argument of the
    // create call itself, the same shape the main thread passes.
    const overrides = msg.renderPathOverrides;
    if (overrides && Module._set_render_path_overrides) {
        Module._set_render_path_overrides(overrides.blurCopyPath ? 1 : 0,
            overrides.copyShaderPath ? 1 : 0, overrides.perPixelForceCpu ? 1 : 0);
    }

    if (typeof Module._create_host_with_config !== 'function') {
        // The host falls back to the main thread, which still drives bundles
        // like this one through the old configure-then-init exports.
        postToHost({
            type: 'unsupported',
            reason: 'bundle predates create_host_with_config(); rebuild, or render on the main thread',
        });
        return false;
    }
    const cfg = msg.contextConfig;
    const host = Module.ccall('create_host_with_config', 'number',
        ['string', 'string', 'number', 'number', 'number'],
        ['#mcanvas', '', cfg.flags, cfg.powerPreference, cfg.fboPrecision]);
    if (!host) {
        const code = Module._get_last_init_error ? Module._get_last_init_error() : -1;
        postToHost({
            type: 'init-error',
            message: `projectM engine creation failed in the render worker (init code ${code})`,
            code,
        });
        return false;
    }
    engineHost = Number(host);

    surface = msg.canvas;
    installContextLossHandlers(msg.canvas);
    surfaceWidth = msg.width;
    surfaceHeight = msg.height;

    // Before start_render(): a viewer who needs the limiter must never be shown
    // an unlimited frame.
    if (msg.flashLimit) {
        applyFlashLimit(msg.flashLimit);
    }

    Module._start_render(msg.width, msg.height);

    if (Module._set_target_fps && msg.targetFps) {
        Module._set_target_fps(msg.targetFps);
    }
    if (Module._set_quality_governor && msg.governor !== undefined) {
        Module._set_quality_governor(msg.governor ? 1 : 0);
    }
    if (Module._get_governor_render_scale) {
        renderScale = Module._get_governor_render_scale() || 1;
        applySurfaceSize();
    }
    if (Module._set_mesh && msg.meshQuality) {
        const grid = msg.meshQuality === 'low' ? [64, 48] : [80, 60];
        Module._set_mesh(grid[0], grid[1]);
    }

    publishPcmRing();

    stopStats();
    statsInterval = setInterval(postStats, 500);

    postToHost({ type: 'ready', host: engineHost, ...contextSnapshotField() });
    return true;
}

self.onmessage = (event) => {
    const msg = /** @type {RenderWorkerHostMessage} */ (event.data);
    switch (msg.type) {
        case 'init':
            runInit(msg);
            break;
        case 'shutdown':
            shutdown();
            break;
        case 'resize':
            // The host sends the layout size; the backing store is that times
            // the governor's render scale, and only this side can set it.
            surfaceWidth = msg.width;
            surfaceHeight = msg.height;
            selectEngine(msg.host);
            applySurfaceSize();
            break;
        case 'pcm':
            if (msg.buffer) {
                writePcmToRing(msg.buffer, msg.channels === 1 ? 1 : 2);
            }
            break;
        case 'preset':
            if (Module) {
                selectEngine(msg.host);
                handlePreset(Module, msg);
            }
            break;
        case 'ccall':
            if (Module) {
                selectEngine(msg.host);
                handleCcall(Module, msg);
            } else if (msg.requestId !== undefined) {
                // Before boot or after shutdown: say so rather than leave the
                // caller's promise pending forever.
                postToHost({ type: 'ccall-rejected', requestId: msg.requestId, message: `ccall ${msg.name}: no engine in the render worker` });
            }
            break;
        case 'recover-context':
            recoverContext(msg.host);
            break;
        case 'set-flash-limit':
            if (Module) {
                selectEngine(msg.host);
                applyFlashLimit(msg);
            }
            break;
        case 'capture-frame':
            captureFrame(msg).catch((error) => {
                postToHost({ type: 'frame-captured', requestId: msg.requestId, error: `captureFrame() threw: ${error}` });
            });
            break;
        default:
            break;
    }
};
