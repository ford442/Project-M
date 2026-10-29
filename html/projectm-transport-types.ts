// The render transport: one interface over the two render topologies.
//
// projectM renders either on the main thread (the WASM module is right here,
// calls are direct) or in an OffscreenCanvas render worker (the module lives
// there, calls cross postMessage). Those are genuinely different transports,
// not different APIs, and every caller that knows which one it is talking to
// is a caller that has to be written twice — which is how the worker path
// stayed a second implementation that features kept missing.
//
// A RenderTransport hides the difference. Everything above it (ProjectMContext
// and its callers) issues the same calls either way; only the two factories in
// html/projectm-render-transport.js know how a call is actually delivered.
//
// Types-only companion, named `*-types.ts` per html/README.md: a
// same-basename `.ts` would shadow the real `.js` module for every JS importer
// during typecheck.

import type { ProjectMCapturedFrame, ProjectMCaptureFrameOptions } from './projectm-context-types.ts';
import type { PerfFrameStats, RenderWorkerHandle, RhythmEvent } from './projectm-render-worker-types.ts';

/** Which topology a transport is driving. */
export type RenderTopology = 'main' | 'worker';

/**
 * The one interface ProjectMContext talks to.
 *
 * Note that every call is async, including the ones that are synchronous on
 * the main thread. That is deliberate: a signature that is only awaitable in
 * one topology is a signature callers still have to branch on. `callVoid`
 * exists for the fire-and-forget majority, which needs no round trip in
 * either topology.
 */
export interface RenderTransport {
    readonly topology: RenderTopology;

    /**
     * The Emscripten module, when the caller is on the main thread and
     * genuinely needs it (heap access, FS writes). Null in the worker
     * topology — code that dereferences this unconditionally is code that
     * has not been ported yet.
     */
    readonly module: unknown | null;

    /**
     * The engine this transport drives: create_host*()'s handle, 0 for the
     * default host of a single-engine Module. Every call a transport makes —
     * `call`, `callVoid`, `writePreset`, `resize`, `feedPcm`, `recoverContext` —
     * selects this engine first (on the main thread through the generated
     * `bindModuleToHost()`, in the worker through the `host` field on each
     * control message), so a caller that awaited in between still reaches its
     * own engine. The event subscriptions below hear only this engine.
     */
    readonly host: number;

    /** The worker handle, or null on the main thread. */
    readonly workerHandle: RenderWorkerHandle | null;

    /**
     * Whether the loaded bundle actually exports this call. Always true in the
     * worker topology, where the module cannot be interrogated synchronously —
     * so treat a false as authoritative and a true as optimistic.
     */
    supports(name: string): boolean;

    /**
     * Issue an API call by its camelCase name from WASM_API_SIGNATURES and
     * resolve with its return value.
     */
    call(name: string, ...args: unknown[]): Promise<unknown>;

    /** Issue an API call and do not wait for it. */
    callVoid(name: string, ...args: unknown[]): void;

    /** Hand PCM to the engine over whichever ingest this topology uses. */
    feedPcm(buffer: Float32Array, channels?: number): void;

    /**
     * Write a preset into the engine's virtual filesystem and act on it:
     * `load` crossfades to it, `load-hard` cuts, `add` only appends it to the
     * playlist. The VFS lives wherever the module does, which is why this is a
     * transport operation and not a plain call.
     */
    writePreset(vfsPath: string, bytes: Uint8Array, mode?: 'load' | 'load-hard' | 'add'): void;

    /** Tell the engine its drawing surface changed size. */
    resize(width: number, height: number): void;

    /**
     * Turn the engine's temporal flash limiter on or off, and set its threshold
     * when one is given (docs/FLASH_LIMITER.md). Ignored by a bundle that
     * predates the limiter.
     */
    setFlashLimit(enabled: boolean, threshold?: number): void;

    /**
     * Read back the next frame this engine presents (or, with `renderFrame`,
     * render one and read it). Rejects on a bundle without frame capture, when
     * the frame cannot be read, or after `timeoutMs`. The pixels are a copy the
     * caller owns.
     */
    captureFrame(options?: ProjectMCaptureFrameOptions): Promise<ProjectMCapturedFrame>;

    /**
     * Subscribes to WebGL context loss/restore notifications that the transport
     * itself can see. In the worker topology the context lives in the worker, so
     * the transport relays what the worker reports. On the main thread the
     * canvas is right here and reports the DOM events itself, so this never
     * fires — listen on the canvas (see html/projectm-context-loss.js).
     * Returns the unsubscribe function.
     */
    onContextEvent(listener: (event: 'lost' | 'restored') => void): () => void;

    /**
     * Subscribes to the engine's perf-HUD frames (`pmOnPerfFrame`), one call per
     * rendered frame while `set_perf_hud(1)` is on. On the main thread that is
     * the WASM callback bus; in the worker topology the worker relays the frames
     * it hears in its own scope. Returns the unsubscribe function.
     */
    onPerfFrame(listener: (stats: PerfFrameStats) => void): () => void;

    /**
     * Subscribes to the engine's perf-HUD on/off notifications
     * (`pmSetPerfHudEnabled`). Returns the unsubscribe function.
     */
    onPerfHudEnabled(listener: (enabled: boolean) => void): () => void;

    /**
     * Subscribes to the engine's beat/bar/section events (`pmOnRhythmEvent`),
     * reported while `set_rhythm_events(1)` is on. On the main thread that is
     * the WASM callback bus; in the worker topology the worker relays them.
     * Only this transport's engine (`host`); a sibling engine in the same
     * Module is filtered out. Returns the unsubscribe function.
     */
    onRhythmEvent(listener: (event: RhythmEvent) => void): () => void;

    /**
     * Rebuild the engine on a restored WebGL context and start rendering again.
     * Resolves with `init()`'s status: `0` recovered, `5` the browser has not
     * restored the context yet (not an error), anything else an init failure.
     * `width`/`height` size the render target on the main thread; the worker
     * already knows its surface and ignores them.
     */
    recoverContext(width?: number, height?: number): Promise<number>;

    /** Release whatever this transport owns (the worker, or the module). */
    destroy(): void;
}
