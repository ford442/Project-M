// Main-thread bridge for the OffscreenCanvas render worker
// (projectm-render-worker.ts).
//
// Enabled by default: rendering off the main thread is what keeps the embed's
// frame rate independent of whatever the host page is doing on its own thread.
// `?renderWorker=0` (or localStorage.renderWorker = '0') opts out, and stays a
// supported path — CI covers it. When the browser cannot do it (no
// OffscreenCanvas/transferControlToOffscreen, or no Worker), setupRenderWorker()
// returns null and the caller falls back to the main-thread render path
// unchanged.
//
// Every message to the worker goes through post(), typed with
// RenderWorkerHostMessage, and every message from it is dispatched on the
// RenderWorkerMessage union: the wire format is @projectm/types/render-worker,
// and a message either side does not declare is a type error here.

import { resolveWasmContextConfig } from './projectm-context-config.js';
import { createPcmRingWriter } from './projectm-pcm-ring.js';
import {
    isRenderWorkerSupported,
    markCanvasTransferred,
    renderWorkerUnsupportedReason,
} from './projectm-render-worker-support.js';
import { DEFAULT_HOST } from './generated/projectm-wasm-api.js';
import type { HostHandle } from './generated/projectm-wasm-api.js';
import type {
    CcallArgType,
    CcallReturnType,
    FlashLimitSettings,
    PcmRingWriter,
    PerfFrameStats,
    RenderPathOverrides,
    RenderWorkerContextEvent,
    RenderWorkerFrameCapturedMessage,
    RenderWorkerHandle,
    RenderWorkerHostMessage,
    RenderWorkerMessage,
    RenderWorkerStatsMessage,
    RhythmEvent,
    WasmContextConfig,
} from '@projectm/types/render-worker';

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
 * How long {@link RenderWorkerHandle.shutdown} waits for 'shutdown-complete'
 * before it terminates the worker anyway. The engine's destruct is quick; this
 * only bounds a worker that is wedged.
 */
export const RENDER_WORKER_SHUTDOWN_TIMEOUT_MS = 1000;

export interface SetupRenderWorkerOptions {
    canvas: HTMLCanvasElement;
    /** The Emscripten glue the worker importScripts(). */
    scriptSrc: string;
    width: number;
    height: number;
    targetFps?: number | undefined;
    governor?: boolean | undefined;
    meshQuality?: string | undefined;
    /** create_host_with_config() arguments, applied in the worker before init(). */
    contextConfig?: WasmContextConfig | undefined;
    /** The page's render-path switches, applied in the worker before init(). */
    renderPathOverrides?: RenderPathOverrides | undefined;
    /** The flash limiter, applied in the worker before the engine's first frame. */
    flashLimit?: FlashLimitSettings | null | undefined;
    onReady?: (() => void) | undefined;
    onUnsupported?: ((reason: string) => void) | undefined;
    /**
     * The worker's boot failed after its module started loading (see
     * 'init-error'). Without this handler the failure goes to `onError`.
     */
    onInitError?: ((detail: { code: number; message: string }) => void) | undefined;
    onError?: ((message: string) => void) | undefined;
    onStats?: ((stats: RenderWorkerStatsMessage) => void) | undefined;
}

/** A ccall still waiting for its 'ccall-result' / 'ccall-rejected'. */
interface PendingCcall {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

/**
 * Transfers `canvas` to a new render worker and starts the WASM module there.
 *
 * @returns null when unsupported — the caller must fall back to the main-thread
 *   render path. Otherwise a handle for the host to drive the worker (resize,
 *   PCM, generic ccall) and react to stats/errors.
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
    onStats,
}: SetupRenderWorkerOptions): RenderWorkerHandle | null {
    if (!isRenderWorkerSupported(canvas)) {
        if (onUnsupported) onUnsupported(renderWorkerUnsupportedReason(canvas) ?? 'render worker unsupported');
        return null;
    }

    let offscreen: OffscreenCanvas;
    try {
        offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
        if (onUnsupported) onUnsupported(`transferControlToOffscreen failed: ${String(error)}`);
        return null;
    }

    markCanvasTransferred(canvas);

    const worker = new Worker(new URL('./projectm-render-worker.js', import.meta.url));

    /** The one way a message reaches the worker: checked against the protocol. */
    const post = (message: RenderWorkerHostMessage, transfer: Transferable[] = []): void => {
        worker.postMessage(message, transfer);
    };

    // The ring is owned by the worker's WASM module, so it only exists once the
    // module has booted there and only when its memory is shareable (COOP/COEP).
    // Until then — and forever, without cross-origin isolation — PCM goes over
    // postMessage and the worker writes it into the same ring on arrival.
    let pcmRing: PcmRingWriter | null = null;

    let nextRequestId = 1;
    const pendingCcalls = new Map<number, PendingCcall>();
    const pendingCaptures = new Map<number, (message: RenderWorkerFrameCapturedMessage) => void>();

    // The worker's engine, as 'ready' reported it (DEFAULT_HOST until then, and
    // from a worker that predates the field). Stamped on every control message,
    // so which engine a call reaches never depends on which one was active last
    // — the worker has one engine today, and this is what lets it have two.
    let engineHost: HostHandle = DEFAULT_HOST;
    // get_context_snapshot() for the worker's context, from 'ready' and from
    // each successful recovery. Null until reported, and for a bundle without it.
    let contextSnapshotBits: number | null = null;
    // get_context_limit() for the same context, reported alongside it.
    let contextLimitValues: readonly number[] | null = null;
    const limitsOf = (limits: unknown): readonly number[] | null =>
        Array.isArray(limits) && limits.every((n) => typeof n === 'number') ? Object.freeze([...limits]) : null;

    const contextListeners = new Set<(event: RenderWorkerContextEvent) => void>();
    let pendingRecovery: Promise<number> | null = null;
    let settleRecovery: ((status: number) => void) | null = null;

    const emitContextEvent = (event: RenderWorkerContextEvent): void => {
        for (const listener of [...contextListeners]) {
            listener(event);
        }
    };

    // Perf HUD relay. The engine reports to the worker's own globalThis, and the
    // worker forwards it; whoever draws the HUD subscribes here after boot.
    const perfFrameListeners = new Set<(stats: PerfFrameStats) => void>();
    const perfHudListeners = new Set<(enabled: boolean) => void>();
    const rhythmListeners = new Set<(event: RhythmEvent) => void>();
    const statsListeners = new Set<(stats: RenderWorkerStatsMessage) => void>();
    let lastStats: RenderWorkerStatsMessage | null = null;

    /**
     * Subscribers are page code (the HUD, a benchmark); one that throws must
     * not take the worker's message handler down with it.
     */
    const notify = <T>(listeners: Set<(value: T) => void>, value: T): void => {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                console.error('[projectM] render worker listener threw:', error);
            }
        }
    };

    const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): (() => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    let terminated = false;
    let shutdownPromise: Promise<void> | null = null;
    let finishShutdown: (() => void) | null = null;

    /**
     * Rejects every ccall and capture still waiting: once the worker is gone
     * nothing will answer them, and a promise that never settles is how a
     * caller hangs.
     */
    const rejectPending = (reason: string): void => {
        for (const { reject } of pendingCcalls.values()) reject(new Error(reason));
        pendingCcalls.clear();
        for (const settle of pendingCaptures.values()) {
            settle({ type: 'frame-captured', requestId: 0, error: reason });
        }
        pendingCaptures.clear();
        if (settleRecovery) settleRecovery(-1);
    };

    const terminate = (): void => {
        if (terminated) return;
        terminated = true;
        worker.terminate();
        rejectPending('the render worker was terminated');
        finishShutdown?.();
    };

    worker.onmessage = (event: MessageEvent<RenderWorkerMessage>) => {
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
                    // A rebuilt engine runs on a new context; describe that one.
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

    worker.onerror = (event: ErrorEvent) => {
        if (onError) onError(event.message || String(event));
    };

    post(
        {
            type: 'init',
            canvas: offscreen,
            scriptSrc,
            width,
            height,
            ...(targetFps !== undefined ? { targetFps } : {}),
            ...(governor !== undefined ? { governor } : {}),
            ...(meshQuality !== undefined ? { meshQuality } : {}),
            // Always sent: the worker creates its engine with it (the defaults
            // when the caller has no options of its own).
            contextConfig: contextConfig ?? resolveWasmContextConfig(),
            ...(renderPathOverrides !== undefined ? { renderPathOverrides } : {}),
            ...(flashLimit ? { flashLimit } : {}),
        },
        [offscreen]
    );

    const handle: RenderWorkerHandle = {
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
                pendingRecovery = new Promise<number>((resolve) => {
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
            // postMessage transfers the backing buffer, so hand over a copy:
            // callers reuse their chunks.
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
            // Transferred, so hand over a copy: callers may still own theirs.
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

        postTextureFrame(name, width, height, { bitmap, pixels }) {
            const transfer: Transferable[] = [];
            if (bitmap) transfer.push(bitmap);
            if (pixels) transfer.push(pixels);
            post(
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

        ccall(name: string, returnType: CcallReturnType, argTypes: readonly CcallArgType[], args: readonly unknown[]) {
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
                shutdownPromise = new Promise<void>((resolve) => {
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
