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

import type { RenderWorkerHandle } from './projectm-render-worker-types.ts';

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

    /** Release whatever this transport owns (the worker, or the module). */
    destroy(): void;
}
