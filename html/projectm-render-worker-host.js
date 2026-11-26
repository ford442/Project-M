// GENERATED from projectm-render-worker-host.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { resolveWasmContextConfig } from './projectm-context-config.js';
import { createPcmRingWriter } from './projectm-pcm-ring.js';
import {
    isRenderWorkerSupported,
    markCanvasTransferred,
    renderWorkerUnsupportedReason,
} from './projectm-render-worker-support.js';
import { DEFAULT_HOST } from './generated/projectm-wasm-api.js';
export {
    isCanvasTransferred,
    isRenderWorkerEnabled,
    isRenderWorkerSupported,
    offscreenCanvasSupportsWebGL2,
    renderWorkerUnsupportedReason,
    replaceTransferredCanvas,
    resolveRenderPathOverrides,
} from './projectm-render-worker-support.js';
export const RENDER_WORKER_SHUTDOWN_TIMEOUT_MS = 1e3;
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
    onStats,
}) {
    if (!isRenderWorkerSupported(canvas)) {
        if (onUnsupported) onUnsupported(renderWorkerUnsupportedReason(canvas) ?? 'render worker unsupported');
        return null;
    }
    let offscreen;
    try {
        offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
        if (onUnsupported) onUnsupported(`transferControlToOffscreen failed: ${String(error)}`);
        return null;
    }
    markCanvasTransferred(canvas);
    const worker = new Worker(new URL('./projectm-render-worker.js', import.meta.url));
    const post = (message, transfer = []) => {
        worker.postMessage(message, transfer);
    };
    let pcmRing = null;
    let nextRequestId = 1;
    const pendingCcalls = /* @__PURE__ */ new Map();
    const pendingCaptures = /* @__PURE__ */ new Map();
    let engineHost = DEFAULT_HOST;
    let contextSnapshotBits = null;
    let contextLimitValues = null;
    const limitsOf = (limits) =>
        Array.isArray(limits) && limits.every((n) => typeof n === 'number') ? Object.freeze([...limits]) : null;
    const contextListeners = /* @__PURE__ */ new Set();
    let pendingRecovery = null;
    let settleRecovery = null;
    const emitContextEvent = (event) => {
        for (const listener of [...contextListeners]) {
            listener(event);
        }
    };
    const perfFrameListeners = /* @__PURE__ */ new Set();
    const perfHudListeners = /* @__PURE__ */ new Set();
    const rhythmListeners = /* @__PURE__ */ new Set();
    const statsListeners = /* @__PURE__ */ new Set();
    let lastStats = null;
    const notify = (listeners, value) => {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                console.error('[projectM] render worker listener threw:', error);
            }
        }
    };
    const subscribe = (listeners, listener) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };
    let terminated = false;
    let shutdownPromise = null;
    let finishShutdown = null;
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
        const msg = event.data;
        switch (msg.type) {
            case 'ready':
                engineHost = typeof msg.host === 'number' ? msg.host : DEFAULT_HOST;
                contextSnapshotBits = typeof msg.contextSnapshot === 'number' ? msg.contextSnapshot : null;
                contextLimitValues = limitsOf(msg.contextLimits);
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
                    if (onError) onError(`PCM ring map failed: ${String(error)}`);
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
                    contextSnapshotBits = typeof msg.contextSnapshot === 'number' ? msg.contextSnapshot : null;
                    contextLimitValues = limitsOf(msg.contextLimits);
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
    post(
        {
            type: 'init',
            canvas: offscreen,
            scriptSrc,
            width,
            height,
            ...(targetFps !== void 0 ? { targetFps } : {}),
            ...(governor !== void 0 ? { governor } : {}),
            ...(meshQuality !== void 0 ? { meshQuality } : {}),
            // Always sent: the worker creates its engine with it (the defaults
            // when the caller has no options of its own).
            contextConfig: contextConfig ?? resolveWasmContextConfig(),
            ...(renderPathOverrides !== void 0 ? { renderPathOverrides } : {}),
            ...(flashLimit ? { flashLimit } : {}),
        },
        [offscreen]
    );
    const handle = {
        worker,
        engineHost() {
            return engineHost;
        },
        contextSnapshot() {
            return contextSnapshotBits;
        },
        contextLimits() {
            return contextLimitValues;
        },
        onContextEvent(listener) {
            contextListeners.add(listener);
            return () => {
                contextListeners.delete(listener);
            };
        },
        recoverContext() {
            if (!pendingRecovery) {
                pendingRecovery = new Promise((resolve) => {
                    settleRecovery = (status) => {
                        pendingRecovery = null;
                        settleRecovery = null;
                        resolve(status);
                    };
                });
                post({ type: 'recover-context', host: engineHost });
            }
            return pendingRecovery;
        },
        onPerfFrame(listener) {
            return subscribe(perfFrameListeners, listener);
        },
        onPerfHudEnabled(listener) {
            return subscribe(perfHudListeners, listener);
        },
        onRhythmEvent(listener) {
            return subscribe(rhythmListeners, listener);
        },
        getLastStats() {
            return lastStats;
        },
        onStats(listener) {
            return subscribe(statsListeners, listener);
        },
        getPcmRing() {
            return pcmRing;
        },
        /**
         * The one entry point hosts should use: writes straight into the
         * worker's PCM ring when it is shared, and posts the chunk otherwise.
         * Either way the audio lands in the same ring and is drained by
         * render_frame() on the worker side.
         */
        feedPcm(buffer, channels) {
            if (pcmRing) {
                pcmRing.write(buffer, channels);
                return;
            }
            const copy = new Float32Array(buffer);
            post({ type: 'pcm', buffer: copy, channels }, [copy.buffer]);
        },
        postResize(w, h) {
            post({ type: 'resize', width: w, height: h, host: engineHost });
        },
        /**
         * Raw transfer of `buffer` to the worker. Prefer {@link feedPcm}, which
         * picks the transport; this stays for callers that already own a
         * throwaway buffer and want to avoid the copy.
         */
        postPcm(buffer, channels) {
            post({ type: 'pcm', buffer, channels }, [buffer.buffer]);
        },
        /**
         * Hands a preset to the worker's module: the bytes are written into its
         * VFS and then loaded/added there, since that filesystem is the one the
         * engine reads.
         */
        postPreset(vfsPath, bytes, mode = 'load') {
            const copy = new Uint8Array(bytes);
            post({ type: 'preset', vfsPath, bytes: copy, mode, host: engineHost }, [copy.buffer]);
        },
        postFlashLimit(enabled, threshold) {
            post({
                type: 'set-flash-limit',
                enabled: !!enabled,
                ...(typeof threshold === 'number' && Number.isFinite(threshold) ? { threshold } : {}),
                host: engineHost,
            });
        },
        postTextureFrame(name, width2, height2, { bitmap, pixels }) {
            const transfer = [];
            if (bitmap) transfer.push(bitmap);
            if (pixels) transfer.push(pixels);
            post(
                {
                    type: 'texture-frame',
                    name,
                    width: width2,
                    height: height2,
                    ...(bitmap ? { bitmap } : {}),
                    ...(pixels ? { pixels } : {}),
                    host: engineHost,
                },
                transfer
            );
        },
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
                post({
                    type: 'capture-frame',
                    requestId,
                    renderFrame: !!renderFrame,
                    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                    host: engineHost,
                });
            });
        },
        ccall(name, returnType, argTypes, args) {
            if (terminated) {
                return Promise.reject(new Error(`ccall ${name}: the render worker was terminated`));
            }
            return new Promise((resolve, reject) => {
                const requestId = nextRequestId++;
                pendingCcalls.set(requestId, { resolve, reject });
                post({ type: 'ccall', name, returnType, argTypes, args, requestId, host: engineHost });
            });
        },
        ccallVoid(name, argTypes, args) {
            post({ type: 'ccall', name, returnType: null, argTypes, args, host: engineHost });
        },
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
                post({ type: 'shutdown' });
            }
            return shutdownPromise;
        },
        terminate,
        /** {@link RenderWorkerHandle.shutdown}, for code that tears every setup*() down the same way. */
        dispose() {
            void handle.shutdown();
        },
    };
    return handle;
}
