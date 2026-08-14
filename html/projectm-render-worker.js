// Render worker for projectM (OffscreenCanvas path).
//
// Opt-in alternative to the main-thread render loop in projectm-core.html.
// The main thread transfers control of the WebGL canvas to this worker via
// canvas.transferControlToOffscreen(), then this worker loads the same WASM
// module used on the main thread and drives _start_render()/the Emscripten
// main loop here instead.
//
// Message protocol (host -> worker):
//   { type: 'init', canvas, scriptSrc, width, height, pcm, targetFps, governor, meshQuality }
//   { type: 'resize', width, height }
//   { type: 'pcm', buffer, channels }                 // only used when SAB ring is unavailable
//   { type: 'ccall', name, returnType, argTypes, args, requestId }
//
// Message protocol (worker -> host):
//   { type: 'ready' }
//   { type: 'unsupported', reason }
//   { type: 'error', message }
//   { type: 'stats', fps, fboFormat, qualityTier }
//   { type: 'ccall-result', requestId, result }

/**
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingInit} PcmRingInit
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerHostMessage} RenderWorkerHostMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerInitMessage} RenderWorkerInitMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerCcallMessage} RenderWorkerCcallMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerMessage} RenderWorkerMessage
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * Reader half of the SharedArrayBuffer PCM ring. The host owns the write index
 * (published through `header[0]` with Atomics); this side keeps its own cursor.
 *
 * @typedef {object} PcmRingReader
 * @property {Int32Array} header Single-element view holding the write index.
 * @property {Float32Array} data Interleaved stereo sample storage.
 * @property {number} capacityPairs
 * @property {number} readIndex
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
/** @type {PcmRingReader | null} */
let pcmRing = null;
let statsInterval = 0;
let lastFrameTime = 0;
let lastFps = 0;

/**
 * @param {PcmRingInit | null | undefined} pcm
 * @returns {PcmRingReader | null}
 */
function setupPcmRing(pcm) {
    if (!pcm || !pcm.sab) return null;
    const header = new Int32Array(pcm.sab, 0, 1);
    const data = new Float32Array(pcm.sab, 4, pcm.capacityPairs * 2);
    return { header, data, capacityPairs: pcm.capacityPairs, readIndex: 0 };
}

function drainPcmRing() {
    if (!pcmRing || !Module || !Module._projectm_pcm_add_float_wrapper) return;

    const writeIndex = Atomics.load(pcmRing.header, 0);
    let available = writeIndex - pcmRing.readIndex;
    if (available <= 0) return;

    if (available > pcmRing.capacityPairs) {
        // Reader fell behind by more than the ring capacity; drop the oldest data.
        pcmRing.readIndex = writeIndex - pcmRing.capacityPairs;
        available = pcmRing.capacityPairs;
    }

    const interleaved = new Float32Array(available * 2);
    const start = pcmRing.readIndex % pcmRing.capacityPairs;
    const firstPairs = Math.min(available, pcmRing.capacityPairs - start);
    interleaved.set(pcmRing.data.subarray(start * 2, (start + firstPairs) * 2), 0);
    if (firstPairs < available) {
        const remaining = available - firstPairs;
        interleaved.set(pcmRing.data.subarray(0, remaining * 2), firstPairs * 2);
    }

    pcmRing.readIndex = writeIndex;
    feedInterleavedPcm(interleaved, available);
}

/**
 * @param {Float32Array} interleaved
 * @param {number} samplesPerChannel
 */
function feedInterleavedPcm(interleaved, samplesPerChannel) {
    // Mirrors feedPcmFloat() in html/generated/projectm-wasm-api.js (worker cannot import ES modules).
    if (!Module || !Module._malloc || !Module.HEAPF32 || !Module._projectm_pcm_add_float_wrapper) return;

    const ptr = Module._malloc(interleaved.length * 4);
    if (!ptr) return;
    try {
        Module.HEAPF32.set(interleaved, ptr >> 2);
        Module._projectm_pcm_add_float_wrapper(0, ptr, samplesPerChannel, 2);
    } finally {
        Module._free(ptr);
    }
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

    pcmRing = setupPcmRing(msg.pcm);

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

    if (pcmRing) {
        // Drain the PCM ring on a short interval independent of the render
        // loop, so audio data is consumed even if frame timing varies.
        setInterval(drainPcmRing, 16);
    }

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
            if (!pcmRing && msg.buffer) {
                const channels = msg.channels === 1 ? 1 : 2;
                let interleaved = msg.buffer;
                let samplesPerChannel = interleaved.length;
                if (channels === 1) {
                    // Duplicate mono to stereo to match _projectm_pcm_add_float_wrapper's expectations.
                    const stereo = new Float32Array(interleaved.length * 2);
                    for (let i = 0; i < interleaved.length; i++) {
                        stereo[i * 2] = interleaved[i];
                        stereo[i * 2 + 1] = interleaved[i];
                    }
                    interleaved = stereo;
                } else {
                    samplesPerChannel = interleaved.length / 2;
                }
                feedInterleavedPcm(interleaved, samplesPerChannel);
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
