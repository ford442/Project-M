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
//   { type: 'init', canvas, scriptSrc, width, height, targetFps, governor, meshQuality }
//   { type: 'resize', width, height }
//   { type: 'pcm', buffer, channels }                 // only when the ring cannot be shared
//   { type: 'preset', vfsPath, bytes, mode }
//   { type: 'ccall', name, returnType, argTypes, args, requestId }
//
// Message protocol (worker -> host):
//   { type: 'ready' }
//   { type: 'unsupported', reason }
//   { type: 'error', message }
//   { type: 'stats', fps, fboFormat, qualityTier }
//   { type: 'pcm-ring', descriptor }
//   { type: 'ccall-result', requestId, result }
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
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
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
 */
function postToHost(message) {
    self.postMessage(message);
}

/** @type {ProjectMModule | null} */
let Module = null;
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

// WasmPerfGovernor.cpp pushes tier changes through globalThis — which in a
// worker is this scope, not a window. That is the whole point of the
// globalThis migration in src/wasm/: the same C++ hook reaches the host in
// either topology, and governor v2 is no longer main-thread-only.
/** @param {number} scale */
const onGovernorRenderScaleChange = (scale) => {
    renderScale = scale || 1;
    applySurfaceSize();
};
/** @type {any} */ (self).pmOnGovernorRenderScaleChange = onGovernorRenderScaleChange;

/**
 * Reads the module's PCM ring descriptor. Mirrors readPcmRingDescriptor() in
 * html/projectm-pcm-ring.js — this is a classic worker (importScripts, no ES
 * module imports), so the few lines are duplicated rather than imported.
 *
 * @returns {PcmRingDescriptor | null}
 */
function readPcmRingDescriptor() {
    const m = /** @type {any} */ (Module);
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

function postStats() {
    if (!Module) return;

    const now = performance.now();
    if (lastFrameTime) {
        const delta = now - lastFrameTime;
        if (delta > 0) {
            lastFps = 1000 / delta;
        }
    }
    lastFrameTime = now;

    postToHost({
        type: 'stats',
        fps: lastFps,
        fboFormat: Module._dual_fbo_get_format ? Module._dual_fbo_get_format() : -1,
        qualityTier: Module._get_quality_tier ? Module._get_quality_tier() : -1,
        renderScale
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
    const fs = /** @type {any} */ (module).FS;
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
        postToHost({ type: 'error', message: `ccall ${msg.name} failed: ${error}` });
        return;
    }
    if (msg.requestId !== undefined) {
        postToHost({ type: 'ccall-result', requestId: msg.requestId, result });
    }
}

/** @param {RenderWorkerInitMessage} msg */
async function init(msg) {
    if (typeof OffscreenCanvas === 'undefined' || typeof importScripts !== 'function') {
        postToHost({ type: 'unsupported', reason: 'OffscreenCanvas or importScripts unavailable in worker' });
        return;
    }

    try {
        importScripts(msg.scriptSrc);
    } catch (error) {
        postToHost({ type: 'unsupported', reason: `failed to load ${msg.scriptSrc}: ${error}` });
        return;
    }

    const createModule = getCreateModule();
    if (typeof createModule !== 'function') {
        postToHost({ type: 'unsupported', reason: 'createModule not defined after importScripts' });
        return;
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
        postToHost({ type: 'error', message: `module init failed: ${error}` });
        return;
    }

    // Give the engine its canvas. emscripten_webgl_create_context("#mcanvas")
    // resolves that selector through findEventTarget(), which checks
    // specialHTMLTargets first and falls back to document.querySelector() —
    // and there is no document here. Registering the transferred canvas under
    // the selector the engine already uses means the C++ side needs no
    // worker-specific path at all.
    const targets = /** @type {any} */ (Module).specialHTMLTargets;
    if (!targets) {
        postToHost({
            type: 'unsupported',
            reason: 'bundle does not export specialHTMLTargets; rebuild with the current EXPORTED_RUNTIME_METHODS',
        });
        return;
    }
    targets['#mcanvas'] = msg.canvas;

    const initStatus = Module._init();
    if (initStatus !== 0) {
        postToHost({ type: 'error', message: `projectM init() failed in the render worker (code ${initStatus})` });
        return;
    }

    surface = msg.canvas;
    surfaceWidth = msg.width;
    surfaceHeight = msg.height;

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

    statsInterval = setInterval(postStats, 500);

    postToHost({ type: 'ready' });
}

self.onmessage = (event) => {
    const msg = /** @type {RenderWorkerHostMessage} */ (event.data);
    switch (msg.type) {
        case 'init':
            init(msg);
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
                handlePreset(Module, msg);
            }
            break;
        case 'ccall':
            if (Module) {
                handleCcall(Module, msg);
            }
            break;
        default:
            break;
    }
};
