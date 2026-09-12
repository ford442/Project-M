// Main-thread bridge for the OffscreenCanvas render worker
// (projectm-render-worker.js).
//
// Enabled by default: rendering off the main thread is what keeps the embed's
// frame rate independent of whatever the host page is doing on its own thread.
// `?renderWorker=0` (or localStorage.renderWorker = '0') opts out, and stays a
// supported path — CI covers it. When the browser cannot do it (no
// OffscreenCanvas/transferControlToOffscreen, or no Worker), setupRenderWorker()
// returns null and the caller falls back to the main-thread render path
// unchanged.

import { WASM_API_SYMBOLS } from './generated/projectm-wasm-api.js';
import { createPcmRingWriter } from './projectm-pcm-ring.js';

/**
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingDescriptor} PcmRingDescriptor
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingWriter} PcmRingWriter
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerHandle} RenderWorkerHandle
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerMessage} RenderWorkerMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerStatsMessage} RenderWorkerStatsMessage
 */

/**
 * Whether the host *wants* the render worker. Says nothing about whether the
 * browser can provide one — that is isRenderWorkerSupported() /
 * canUseRenderWorker() in projectm-render-transport.js.
 *
 * The default is on. Both the query parameter and the stored preference are
 * read as explicit opt-outs ('0') or opt-ins ('1'); any other value is neither
 * and leaves the default in place, so a stale or garbled setting cannot
 * silently pin a page to the slower topology.
 *
 * @param {object} [options]
 * @param {string} [options.search]
 * @param {Storage | null} [options.storage]
 * @returns {boolean}
 */
export function isRenderWorkerEnabled({ search = location.search, storage = (() => {
    try { return window.localStorage; } catch (_) { return null; }
})() } = {}) {
    const params = new URLSearchParams(search);
    if (params.has('renderWorker')) {
        const value = params.get('renderWorker');
        if (value === '0') return false;
        if (value === '1') return true;
    }
    const stored = storage ? storage.getItem('renderWorker') : null;
    if (stored === '0') return false;
    if (stored === '1') return true;
    return true;
}

/**
 * Doubles as the narrowing guard for {@link setupRenderWorker}: past this
 * check, `canvas` is present and can be transferred offscreen.
 *
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @returns {canvas is HTMLCanvasElement}
 */
export function isRenderWorkerSupported(canvas) {
    return !!(
        canvas &&
        typeof canvas.transferControlToOffscreen === 'function' &&
        typeof Worker !== 'undefined' &&
        typeof OffscreenCanvas !== 'undefined'
    );
}

// Transfers `canvas` to a new render worker and starts the WASM module
// there. Returns null if unsupported (caller should fall back to the
// main-thread path). Otherwise returns a handle for the host to drive the
// worker (resize, PCM, generic ccall) and react to stats/errors.
/**
 * Transfers `canvas` to a new render worker and starts the WASM module there.
 *
 * @param {object} [options]
 * @param {HTMLCanvasElement} [options.canvas]
 * @param {string} [options.scriptSrc]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.targetFps]
 * @param {boolean} [options.governor]
 * @param {string} [options.meshQuality]
 * @param {() => void} [options.onReady]
 * @param {(reason: string) => void} [options.onUnsupported]
 * @param {(message: string) => void} [options.onError]
 * @param {(stats: RenderWorkerStatsMessage) => void} [options.onStats]
 * @returns {RenderWorkerHandle | null} null when unsupported — the caller must
 *   fall back to the main-thread render path.
 */
export function setupRenderWorker({
    canvas,
    scriptSrc,
    width,
    height,
    targetFps,
    governor,
    meshQuality,
    onReady,
    onUnsupported,
    onError,
    onStats
} = {}) {
    if (!isRenderWorkerSupported(canvas)) {
        if (onUnsupported) onUnsupported('OffscreenCanvas/transferControlToOffscreen/Worker unavailable');
        return null;
    }

    let offscreen;
    try {
        offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
        if (onUnsupported) onUnsupported(`transferControlToOffscreen failed: ${error}`);
        return null;
    }

    const worker = new Worker(new URL('./projectm-render-worker.js', import.meta.url));

    // The ring is owned by the worker's WASM module, so it only exists once the
    // module has booted there and only when its memory is shareable (COOP/COEP).
    // Until then — and forever, without cross-origin isolation — PCM goes over
    // postMessage and the worker writes it into the same ring on arrival.
    /** @type {PcmRingWriter | null} */
    let pcmRing = null;

    let nextRequestId = 1;
    /** @type {Map<number, (result: unknown) => void>} */
    const pendingCcalls = new Map();

    worker.onmessage = (event) => {
        const msg = /** @type {RenderWorkerMessage} */ (event.data);
        switch (msg.type) {
            case 'ready':
                if (onReady) onReady();
                break;
            case 'unsupported':
                if (onUnsupported) onUnsupported(msg.reason);
                break;
            case 'error':
                if (onError) onError(msg.message);
                break;
            case 'stats':
                if (onStats) onStats(msg);
                break;
            case 'pcm-ring':
                try {
                    pcmRing = createPcmRingWriter(msg.descriptor);
                } catch (error) {
                    if (onError) onError(`PCM ring map failed: ${error}`);
                    pcmRing = null;
                }
                break;
            case 'ccall-result': {
                const resolve = pendingCcalls.get(msg.requestId);
                if (resolve) {
                    pendingCcalls.delete(msg.requestId);
                    resolve(msg.result);
                }
                break;
            }
            default:
                break;
        }
    };

    worker.onerror = (event) => {
        if (onError) onError(event.message || String(event));
    };

    worker.postMessage({
        type: 'init',
        canvas: offscreen,
        scriptSrc,
        width,
        height,
        targetFps,
        governor,
        meshQuality
    }, [offscreen]);

    return {
        worker,

        /** @returns {PcmRingWriter | null} */
        getPcmRing() {
            return pcmRing;
        },

        /**
         * The one entry point hosts should use: writes straight into the
         * worker's PCM ring when it is shared, and posts the chunk otherwise.
         * Either way the audio lands in the same ring and is drained by
         * render_frame() on the worker side.
         *
         * @param {Float32Array} buffer
         * @param {number} channels
         */
        feedPcm(buffer, channels) {
            if (pcmRing) {
                pcmRing.write(buffer, channels);
                return;
            }
            // postMessage transfers the backing buffer, so hand over a copy:
            // callers reuse their chunks.
            const copy = new Float32Array(buffer);
            worker.postMessage({ type: 'pcm', buffer: copy, channels }, [copy.buffer]);
        },

        /**
         * @param {number} w
         * @param {number} h
         */
        postResize(w, h) {
            worker.postMessage({ type: 'resize', width: w, height: h });
        },

        /**
         * Raw transfer of `buffer` to the worker. Prefer {@link feedPcm}, which
         * picks the transport; this stays for callers that already own a
         * throwaway buffer and want to avoid the copy.
         *
         * @param {Float32Array} buffer
         * @param {number} channels
         */
        postPcm(buffer, channels) {
            worker.postMessage({ type: 'pcm', buffer, channels }, [buffer.buffer]);
        },

        /**
         * Hands a preset to the worker's module: the bytes are written into its
         * VFS and then loaded/added there, since that filesystem is the one the
         * engine reads.
         *
         * @param {string} vfsPath
         * @param {Uint8Array} bytes
         * @param {'load' | 'load-hard' | 'add'} [mode]
         */
        postPreset(vfsPath, bytes, mode = 'load') {
            // Transferred, so hand over a copy: callers may still own theirs.
            const copy = new Uint8Array(bytes);
            worker.postMessage({ type: 'preset', vfsPath, bytes: copy, mode }, [copy.buffer]);
        },

        /**
         * @param {string} name
         * @param {string | null} returnType
         * @param {string[]} argTypes
         * @param {unknown[]} args
         * @returns {Promise<unknown>}
         */
        ccall(name, returnType, argTypes, args) {
            return new Promise((resolve) => {
                const requestId = nextRequestId++;
                pendingCcalls.set(requestId, resolve);
                worker.postMessage({ type: 'ccall', name, returnType, argTypes, args, requestId });
            });
        },

        /**
         * @param {string} name
         * @param {string[]} argTypes
         * @param {unknown[]} args
         */
        ccallVoid(name, argTypes, args) {
            worker.postMessage({ type: 'ccall', name, returnType: null, argTypes, args });
        }
    };
}
