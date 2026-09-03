// Render worker for projectM (OffscreenCanvas path).
//
// Opt-in alternative to the main-thread render loop in projectm-core.html.
// The main thread transfers control of the WebGL canvas to this worker via
// canvas.transferControlToOffscreen(), then this worker loads the same WASM
// module used on the main thread and drives _start_render()/the Emscripten
// main loop here instead.
//
// Message protocol (host -> worker):
//   { type: 'init', canvas, scriptSrc, width, height, targetFps, governor, meshQuality }
//   { type: 'resize', width, height }
//   { type: 'pcm', buffer, channels }                 // only when the ring cannot be shared
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
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerMessage} RenderWorkerMessage
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * The Emscripten factory `importScripts(scriptSrc)` defines on the worker
 * global. Declared here because the glue is loaded at runtime, not imported.
 *
 * @type {((config: Record<string, unknown>) => Promise<ProjectMModule>) | undefined}
 */
// eslint-disable-next-line no-var
var createModule;

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
        qualityTier: Module._get_quality_tier ? Module._get_quality_tier() : -1
    });
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

    if (typeof createModule !== 'function') {
        postToHost({ type: 'unsupported', reason: 'createModule not defined after importScripts' });
        return;
    }

    try {
        Module = await createModule({
            canvas: msg.canvas,
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
                return `${prefix || ''}${remapped}`;
            },
        });
    } catch (error) {
        postToHost({ type: 'error', message: `module init failed: ${error}` });
        return;
    }

    Module._start_render(msg.width, msg.height);

    if (Module._set_target_fps && msg.targetFps) {
        Module._set_target_fps(msg.targetFps);
    }
    if (Module._set_quality_governor && msg.governor !== undefined) {
        Module._set_quality_governor(msg.governor ? 1 : 0);
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
            if (Module && Module._set_window_size) {
                Module._set_window_size(msg.width, msg.height);
            }
            break;
        case 'pcm':
            if (msg.buffer) {
                writePcmToRing(msg.buffer, msg.channels === 1 ? 1 : 2);
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
