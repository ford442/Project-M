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
//   { type: 'texture-frame', name, width, height, bitmap | pixels, host }  // a live-texture frame
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
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerTextureFrameMessage} RenderWorkerTextureFrameMessage
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
 *   _texture_slot_buffer?: (...args: number[]) => number,
 *   _texture_slot_generation?: (...args: number[]) => number,
 *   _load_preset_data?: (...args: number[]) => number,
 *   FS?: { writeFile: (path: string, data: Uint8Array | string) => void, mkdirTree?: (path: string) => void },
 * }} WorkerModule
 */


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
    const engine = selectEngine(engineHost);

    const scale = renderScale > 0 ? renderScale : 1;
    const width = Math.max(1, Math.round(surfaceWidth * scale));
    const height = Math.max(1, Math.round(surfaceHeight * scale));

    if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
    }
    if (engine && engine._set_window_size) {
        engine._set_window_size(width, height);
    }
}

/** @type {WeakMap<object, Map<number, WorkerModule>>} */
const engineViews = new WeakMap();

/**
 * The module as seen by `host` (this worker's engine for 0/absent): every
 * engine call made through it acts on that engine. Mirrors bindModuleToHost()
 * on the main thread, which this classic script cannot import: with two
 * engines in this module, which one a call reaches must come from the message,
 * not from whichever was activated last.
 *
 * An ABI v2 bundle (#352, it exports pm_host_is_live) has a pm_<name>(host, ...)
 * form of every engine call, so the view rewrites `_name(...)` and
 * `ccall('name', ...)` to it and nothing is activated. The calls that already
 * take a handle (projectm_*_wrapper) have no pm_<name> twin and pass through.
 * An older bundle has no pm_ exports: the view is the module itself, with
 * `host` made active first.
 *
 * @param {number | undefined} host
 * @returns {WorkerModule | null}
 */
function selectEngine(host) {
    const module = Module;
    if (!module) return null;
    const target = host || engineHost;
    if (typeof module._pm_host_is_live === 'function') {
        let views = engineViews.get(module);
        if (!views) {
            views = new Map();
            engineViews.set(module, views);
        }
        let view = views.get(target);
        if (!view) {
            view = hostView(module, target);
            views.set(target, view);
        }
        return view;
    }
    if (!target) return module;
    // The common case — one engine, already active — costs no make-current.
    if (typeof module._get_active_host === 'function' && module._get_active_host() === target) return module;
    try {
        module.ccall('set_active_host', null, ['number'], [target]);
    } catch (_) {
        // A bundle without the export has one engine; nothing to select.
    }
    return module;
}

/**
 * @param {WorkerModule} module An ABI v2 bundle.
 * @param {number} host
 * @returns {WorkerModule}
 */
function hostView(module, host) {
    /** @param {string} name */
    const pmExport = (name) => /** @type {unknown} */ (Reflect.get(module, `_pm_${name}`));
    return new Proxy(module, {
        get(obj, property) {
            const value = Reflect.get(obj, property);
            if (typeof property !== 'string' || typeof value !== 'function') return value;
            if (property === 'ccall') {
                /** @type {(name: string, returnType: unknown, argTypes: unknown[], args: unknown[], ...rest: unknown[]) => unknown} */
                const routed = (name, returnType, argTypes, args, ...rest) =>
                    typeof pmExport(name) === 'function'
                        ? value.call(obj, `pm_${name}`, returnType, ['number', ...(argTypes || [])], [host, ...(args || [])], ...rest)
                        : value.call(obj, name, returnType, argTypes, args, ...rest);
                return routed;
            }
            if (!property.startsWith('_') || property.startsWith('_pm_')) return value;
            const pm = pmExport(property.slice(1));
            if (typeof pm !== 'function') return value;
            return (/** @type {unknown[]} */ ...args) => pm.call(obj, host, ...args);
        },
    });
}

/**
 * The rest of the worker, as classic scripts next to this one (relative URLs
 * resolve against this script). Each publishes one factory on `self`; the
 * state they read stays here and is handed over as accessors.
 */
importScripts('./worker/engine-hooks.js', './worker/pcm-ring.js', './worker/capture.js', './worker/live-texture.js');

const { flushPerfFrames } = self.installWorkerEngineHooks({
    getEngineHost: () => engineHost,
    postToHost,
    setRenderScale: (scale) => {
        renderScale = scale;
        applySurfaceSize();
    },
});
const { publishPcmRing, writePcmToRing, readPcmRingCounters } = self.createWorkerPcmRing({
    getModule: () => selectEngine(engineHost),
    postToHost,
});
const { applyFlashLimit, captureFrame } = self.createWorkerCapture({ selectEngine, postToHost });
const { writeTextureFrame } = self.createWorkerLiveTexture({ selectEngine, postToHost });


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
        const engine = /** @type {WorkerModule} */ (selectEngine(host));
        status = engine._init();
        if (status === 0) {
            engine._start_render(surface.width, surface.height);
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
    const m = selectEngine(engineHost);
    return m && typeof m._get_context_snapshot === 'function'
        ? { contextSnapshot: m._get_context_snapshot() }
        : {};
}

function postStats() {
    // A render loop that stopped (hidden tab, lost context) would otherwise
    // strand the last partial batch until it resumed.
    flushPerfFrames();
    const engine = selectEngine(engineHost);
    if (!engine) return;

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
        fboFormat: engine._dual_fbo_get_format ? engine._dual_fbo_get_format() : -1,
        qualityTier: engine._get_quality_tier ? engine._get_quality_tier() : -1,
        renderScale,
        renderPathOverrides: engine._get_render_path_overrides ? engine._get_render_path_overrides() : -1,
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
 * A bundle with load_preset_data() (#352 D) takes the bytes in one call; the
 * FS sequence below is for bundles built before it. This is the worker's copy
 * of html/projectm-preset-store.js (a classic worker cannot import it).
 *
 * @param {ProjectMModule} module
 * @param {RenderWorkerPresetMessage} msg
 */
function handlePreset(module, msg) {
    const engine = /** @type {WorkerModule} */ (module);
    if (typeof engine._load_preset_data === 'function' && engine.HEAPU8) {
        // load_preset_data()'s mode argument (PRESET_STORE_MODES in projectm-preset-store.js).
        const mode = msg.mode === 'add' ? 2 : (msg.mode === 'load-hard' ? 1 : 0);
        const ptr = engine._malloc(Math.max(msg.bytes.byteLength, 1));
        if (!ptr) {
            postToHost({ type: 'error', message: `preset write failed for ${msg.vfsPath}: no WASM heap left` });
            return;
        }
        try {
            engine.HEAPU8.set(msg.bytes, ptr);
            const stored = engine.ccall('load_preset_data', 'number', ['number', 'number', 'string', 'number'],
                [ptr, msg.bytes.byteLength, msg.vfsPath, mode]);
            if (!stored) postToHost({ type: 'error', message: `load_preset_data refused ${msg.vfsPath}` });
        } catch (error) {
            postToHost({ type: 'error', message: `load_preset_data failed for ${msg.vfsPath}: ${error}` });
        } finally {
            engine._free(ptr);
        }
        return;
    }

    const fs = engine.FS;
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
    const m = /** @type {{ _destruct?: () => void } | null} */ (selectEngine(engineHost));
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

    const engine = /** @type {WorkerModule} */ (selectEngine(engineHost));
    engine._start_render(msg.width, msg.height);

    if (engine._set_target_fps && msg.targetFps) {
        engine._set_target_fps(msg.targetFps);
    }
    if (engine._set_quality_governor && msg.governor !== undefined) {
        engine._set_quality_governor(msg.governor ? 1 : 0);
    }
    if (engine._get_governor_render_scale) {
        renderScale = engine._get_governor_render_scale() || 1;
        applySurfaceSize();
    }
    if (engine._set_mesh && msg.meshQuality) {
        const grid = msg.meshQuality === 'low' ? [64, 48] : [80, 60];
        engine._set_mesh(grid[0], grid[1]);
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
            applySurfaceSize();
            break;
        case 'pcm':
            if (msg.buffer) {
                writePcmToRing(msg.buffer, msg.channels === 1 ? 1 : 2);
            }
            break;
        case 'preset':
            if (Module) {
                handlePreset(/** @type {WorkerModule} */ (selectEngine(msg.host)), msg);
            }
            break;
        case 'ccall':
            if (Module) {
                handleCcall(/** @type {WorkerModule} */ (selectEngine(msg.host)), msg);
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
                applyFlashLimit(msg, msg.host);
            }
            break;
        case 'texture-frame':
            writeTextureFrame(msg);
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
