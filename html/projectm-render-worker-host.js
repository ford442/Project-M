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

import { resolveWasmContextConfig } from './projectm-context-config.js';
import { createPcmRingWriter } from './projectm-pcm-ring.js';
import { isRenderWorkerSupported, markCanvasTransferred, renderWorkerUnsupportedReason } from './projectm-render-worker-support.js';

export {
    isCanvasTransferred,
    isRenderWorkerEnabled,
    isRenderWorkerSupported,
    offscreenCanvasSupportsWebGL2,
    renderWorkerUnsupportedReason,
    replaceTransferredCanvas,
    resolveRenderPathOverrides,
} from './projectm-render-worker-support.js';

/**
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingDescriptor} PcmRingDescriptor
 * @typedef {import('./projectm-render-worker-types.ts').PcmRingWriter} PcmRingWriter
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerHandle} RenderWorkerHandle
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerMessage} RenderWorkerMessage
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerStatsMessage} RenderWorkerStatsMessage
 * @typedef {import('./projectm-render-worker-types.ts').WasmContextConfig} WasmContextConfig
 * @typedef {import('./projectm-render-worker-types.ts').RenderPathOverrides} RenderPathOverrides
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerContextEvent} RenderWorkerContextEvent
 * @typedef {import('./projectm-render-worker-types.ts').PerfFrameStats} PerfFrameStats
 * @typedef {import('./projectm-render-worker-types.ts').RhythmEvent} RhythmEvent
 * @typedef {import('./projectm-render-worker-types.ts').FlashLimitSettings} FlashLimitSettings
 * @typedef {import('./projectm-render-worker-types.ts').RenderWorkerFrameCapturedMessage} RenderWorkerFrameCapturedMessage
 */

/**
 * How long {@link RenderWorkerHandle.shutdown} waits for 'shutdown-complete'
 * before it terminates the worker anyway. The engine's destruct is quick; this
 * only bounds a worker that is wedged.
 */
export const RENDER_WORKER_SHUTDOWN_TIMEOUT_MS = 1000;

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
 * @param {WasmContextConfig} [options.contextConfig] create_host_with_config()
 *   arguments, applied in the worker before init().
 * @param {RenderPathOverrides} [options.renderPathOverrides] The page's
 *   render-path switches, applied in the worker before init().
 * @param {FlashLimitSettings | null} [options.flashLimit] The flash limiter,
 *   applied in the worker before the engine's first frame.
 * @param {() => void} [options.onReady]
 * @param {(reason: string) => void} [options.onUnsupported]
 * @param {(detail: { code: number, message: string }) => void} [options.onInitError]
 *   The worker's boot failed after its module started loading (see
 *   'init-error'). Without this handler the failure goes to `onError`.
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
    contextConfig,
    renderPathOverrides,
    flashLimit = null,
    onReady,
    onUnsupported,
    onInitError,
    onError,
    onStats
} = {}) {
    if (!isRenderWorkerSupported(canvas)) {
        if (onUnsupported) onUnsupported(renderWorkerUnsupportedReason(canvas) ?? 'render worker unsupported');
        return null;
    }

    let offscreen;
    try {
        offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
        if (onUnsupported) onUnsupported(`transferControlToOffscreen failed: ${error}`);
        return null;
    }

    markCanvasTransferred(canvas);

    const worker = new Worker(new URL('./projectm-render-worker.js', import.meta.url));

    // The ring is owned by the worker's WASM module, so it only exists once the
    // module has booted there and only when its memory is shareable (COOP/COEP).
    // Until then — and forever, without cross-origin isolation — PCM goes over
    // postMessage and the worker writes it into the same ring on arrival.
    /** @type {PcmRingWriter | null} */
    let pcmRing = null;

    let nextRequestId = 1;
    /** @type {Map<number, { resolve: (result: unknown) => void, reject: (error: Error) => void }>} */
    const pendingCcalls = new Map();
    /** @type {Map<number, (message: RenderWorkerFrameCapturedMessage) => void>} */
    const pendingCaptures = new Map();

    // The worker's engine, as 'ready' reported it (0 until then, and from a
    // worker that predates the field). Stamped on every control message, so
    // which engine a call reaches never depends on which one was active last
    // — the worker has one engine today, and this is what lets it have two.
    let engineHost = 0;
    // get_context_snapshot() for the worker's context, from 'ready' and from
    // each successful recovery. Null until reported, and for a bundle without it.
    /** @type {number | null} */
    let contextSnapshotBits = null;

    /** @type {Set<(event: RenderWorkerContextEvent) => void>} */
    const contextListeners = new Set();
    /** @type {Promise<number> | null} */
    let pendingRecovery = null;
    /** @type {((status: number) => void) | null} */
    let settleRecovery = null;

    /** @param {RenderWorkerContextEvent} event */
    const emitContextEvent = (event) => {
        for (const listener of [...contextListeners]) {
            listener(event);
        }
    };

    // Perf HUD relay. The engine reports to the worker's own globalThis, and the
    // worker forwards it; whoever draws the HUD subscribes here after boot.
    /** @type {Set<(stats: PerfFrameStats) => void>} */
    const perfFrameListeners = new Set();
    /** @type {Set<(enabled: boolean) => void>} */
    const perfHudListeners = new Set();
    /** @type {Set<(event: RhythmEvent) => void>} */
    const rhythmListeners = new Set();
    /** @type {Set<(stats: RenderWorkerStatsMessage) => void>} */
    const statsListeners = new Set();
    /** @type {RenderWorkerStatsMessage | null} */
    let lastStats = null;

    /**
     * Subscribers are page code (the HUD, a benchmark); one that throws must
     * not take the worker's message handler down with it.
     *
     * @template T
     * @param {Set<(value: T) => void>} listeners
     * @param {T} value
     */
    const notify = (listeners, value) => {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                console.error('[projectM] render worker listener threw:', error);
            }
        }
    };

    /**
     * @template T
     * @param {Set<(value: T) => void>} listeners
     * @param {(value: T) => void} listener
     * @returns {() => void}
     */
    const subscribe = (listeners, listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    let terminated = false;
    /** @type {Promise<void> | null} */
    let shutdownPromise = null;
    /** @type {(() => void) | null} */
    let finishShutdown = null;

    /**
     * Rejects every ccall and capture still waiting: once the worker is gone
     * nothing will answer them, and a promise that never settles is how a
     * caller hangs.
     *
     * @param {string} reason
     */
    const rejectPending = (reason) => {
        for (const { reject } of pendingCcalls.values()) reject(new Error(reason));
        pendingCcalls.clear();
        for (const settle of pendingCaptures.values()) {
            settle({ type: 'frame-captured', requestId: 0, error: reason });
        }
        pendingCaptures.clear();
        if (settleRecovery) settleRecovery(-1);
    };

    const terminate = () => {
        if (terminated) return;
        terminated = true;
        worker.terminate();
        rejectPending('the render worker was terminated');
        finishShutdown?.();
    };

    worker.onmessage = (event) => {
        const msg = /** @type {RenderWorkerMessage} */ (event.data);
        switch (msg.type) {
            case 'ready':
                engineHost = typeof msg.host === 'number' ? msg.host : 0;
                contextSnapshotBits = typeof msg.contextSnapshot === 'number' ? msg.contextSnapshot : null;
                if (onReady) onReady();
                break;
            case 'unsupported':
                if (onUnsupported) onUnsupported(msg.reason);
                break;
            case 'init-error':
                if (onInitError) onInitError({ code: msg.code, message: msg.message });
                else if (onError) onError(msg.message);
                break;
            case 'shutdown-complete':
                terminate();
                break;
            case 'error':
                if (onError) onError(msg.message);
                break;
            case 'stats':
                lastStats = msg;
                if (onStats) onStats(msg);
                notify(statsListeners, msg);
                break;
            case 'perf-frames':
                for (const frame of msg.frames) {
                    notify(perfFrameListeners, frame);
                }
                break;
            case 'perf-hud':
                notify(perfHudListeners, msg.enabled);
                break;
            case 'rhythm-event':
                notify(rhythmListeners, msg.event);
                break;
            case 'pcm-ring':
                try {
                    pcmRing = createPcmRingWriter(msg.descriptor);
                } catch (error) {
                    if (onError) onError(`PCM ring map failed: ${error}`);
                    pcmRing = null;
                }
                break;
            case 'context-lost':
                emitContextEvent('lost');
                break;
            case 'context-restored':
                emitContextEvent('restored');
                break;
            case 'context-recovered':
                if (msg.status === 0) {
                    // A rebuilt engine runs on a new context; describe that one.
                    contextSnapshotBits = typeof msg.contextSnapshot === 'number' ? msg.contextSnapshot : null;
                }
                if (settleRecovery) {
                    settleRecovery(msg.status);
                }
                break;
            case 'frame-captured': {
                const settle = pendingCaptures.get(msg.requestId);
                if (settle) {
                    pendingCaptures.delete(msg.requestId);
                    settle(msg);
                }
                break;
            }
            case 'ccall-result': {
                const pending = pendingCcalls.get(msg.requestId);
                if (pending) {
                    pendingCcalls.delete(msg.requestId);
                    pending.resolve(msg.result);
                }
                break;
            }
            case 'ccall-rejected': {
                const pending = pendingCcalls.get(msg.requestId);
                if (pending) {
                    pendingCcalls.delete(msg.requestId);
                    pending.reject(new Error(msg.message));
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
        meshQuality,
        // Always sent: the worker creates its engine with it (the defaults
        // when the caller has no options of its own).
        contextConfig: contextConfig ?? resolveWasmContextConfig(),
        renderPathOverrides,
        ...(flashLimit ? { flashLimit } : {}),
    }, [offscreen]);

    /** @type {RenderWorkerHandle} */
    const handle = {
        worker,

        /** @returns {number} */
        engineHost() {
            return engineHost;
        },

        /** @returns {number | null} */
        contextSnapshot() {
            return contextSnapshotBits;
        },

        /**
         * @param {(event: RenderWorkerContextEvent) => void} listener
         * @returns {() => void}
         */
        onContextEvent(listener) {
            contextListeners.add(listener);
            return () => {
                contextListeners.delete(listener);
            };
        },

        /** @returns {Promise<number>} */
        recoverContext() {
            if (!pendingRecovery) {
                pendingRecovery = new Promise((resolve) => {
                    settleRecovery = (status) => {
                        pendingRecovery = null;
                        settleRecovery = null;
                        resolve(status);
                    };
                });
                worker.postMessage({ type: 'recover-context', host: engineHost });
            }
            return pendingRecovery;
        },

        /**
         * @param {(stats: PerfFrameStats) => void} listener
         * @returns {() => void}
         */
        onPerfFrame(listener) {
            return subscribe(perfFrameListeners, listener);
        },

        /**
         * @param {(enabled: boolean) => void} listener
         * @returns {() => void}
         */
        onPerfHudEnabled(listener) {
            return subscribe(perfHudListeners, listener);
        },

        /**
         * @param {(event: RhythmEvent) => void} listener
         * @returns {() => void}
         */
        onRhythmEvent(listener) {
            return subscribe(rhythmListeners, listener);
        },

        /** @returns {RenderWorkerStatsMessage | null} */
        getLastStats() {
            return lastStats;
        },

        /**
         * @param {(stats: RenderWorkerStatsMessage) => void} listener
         * @returns {() => void}
         */
        onStats(listener) {
            return subscribe(statsListeners, listener);
        },

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
            worker.postMessage({ type: 'resize', width: w, height: h, host: engineHost });
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
            worker.postMessage({ type: 'preset', vfsPath, bytes: copy, mode, host: engineHost }, [copy.buffer]);
        },

        /**
         * @param {boolean} enabled
         * @param {number} [threshold]
         */
        postFlashLimit(enabled, threshold) {
            worker.postMessage({
                type: 'set-flash-limit',
                enabled: !!enabled,
                ...(typeof threshold === 'number' && Number.isFinite(threshold) ? { threshold } : {}),
                host: engineHost,
            });
        },

        /**
         * @param {string} name
         * @param {number} width
         * @param {number} height
         * @param {{ bitmap?: ImageBitmap, pixels?: ArrayBuffer }} frame
         */
        postTextureFrame(name, width, height, { bitmap, pixels }) {
            /** @type {Transferable[]} */
            const transfer = [];
            if (bitmap) transfer.push(bitmap);
            if (pixels) transfer.push(pixels);
            worker.postMessage(
                {
                    type: 'texture-frame',
                    name,
                    width,
                    height,
                    ...(bitmap ? { bitmap } : {}),
                    ...(pixels ? { pixels } : {}),
                    host: engineHost,
                },
                transfer
            );
        },

        /**
         * @param {{ renderFrame?: boolean, timeoutMs?: number }} [options]
         * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray, frameIndex: number }>}
         */
        captureFrame({ renderFrame = false, timeoutMs } = {}) {
            if (terminated) {
                return Promise.reject(new Error('captureFrame(): the render worker was terminated'));
            }
            return new Promise((resolve, reject) => {
                const requestId = nextRequestId++;
                pendingCaptures.set(requestId, (msg) => {
                    if (msg.error || !msg.pixels) {
                        reject(new Error(msg.error || 'captureFrame(): the worker returned no pixels'));
                        return;
                    }
                    resolve({
                        width: msg.width ?? 0,
                        height: msg.height ?? 0,
                        data: new Uint8ClampedArray(msg.pixels),
                        frameIndex: msg.frameIndex ?? 0,
                    });
                });
                worker.postMessage({
                    type: 'capture-frame',
                    requestId,
                    renderFrame: !!renderFrame,
                    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                    host: engineHost,
                });
            });
        },

        /**
         * @param {string} name
         * @param {string | null} returnType
         * @param {string[]} argTypes
         * @param {unknown[]} args
         * @returns {Promise<unknown>}
         */
        ccall(name, returnType, argTypes, args) {
            if (terminated) {
                return Promise.reject(new Error(`ccall ${name}: the render worker was terminated`));
            }
            return new Promise((resolve, reject) => {
                const requestId = nextRequestId++;
                pendingCcalls.set(requestId, { resolve, reject });
                worker.postMessage({ type: 'ccall', name, returnType, argTypes, args, requestId, host: engineHost });
            });
        },

        /**
         * @param {string} name
         * @param {string[]} argTypes
         * @param {unknown[]} args
         */
        ccallVoid(name, argTypes, args) {
            worker.postMessage({ type: 'ccall', name, returnType: null, argTypes, args, host: engineHost });
        },

        /**
         * @param {{ timeoutMs?: number }} [options]
         * @returns {Promise<void>}
         */
        shutdown({ timeoutMs = RENDER_WORKER_SHUTDOWN_TIMEOUT_MS } = {}) {
            if (terminated) return Promise.resolve();
            if (!shutdownPromise) {
                shutdownPromise = new Promise((resolve) => {
                    const timer = setTimeout(terminate, timeoutMs);
                    finishShutdown = () => {
                        clearTimeout(timer);
                        finishShutdown = null;
                        resolve();
                    };
                });
                worker.postMessage({ type: 'shutdown' });
            }
            return shutdownPromise;
        },

        terminate,

        /** {@link shutdown}, for code that tears every setup*() down the same way. */
        dispose() {
            void handle.shutdown();
        },
    };
    return handle;
}
