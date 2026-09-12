// Message protocol shared by the OffscreenCanvas render worker
// (projectm-render-worker.js) and its main-thread bridge
// (projectm-render-worker-host.js).
//
// Types-only companion (no runtime code). The two sides run in different
// global scopes and are typechecked by different tsconfigs — DOM for the host,
// WebWorker for the worker — so this file is the only place the wire format is
// written down. A field renamed on one side and not the other is a silent
// runtime failure across postMessage; declaring it here makes it a build error.
//
// Named `*-types.ts` per html/README.md: a same-basename `.ts` would shadow the
// real `.js` module for every JS importer during typecheck.

/**
 * Descriptor for the WASM-owned PCM ring (src/wasm/WasmPcmRing.cpp), as posted
 * from the worker to the host once the module has booted.
 *
 * The ring lives in the worker module's heap, not in a SharedArrayBuffer the
 * host allocated: there is one ring per engine, owned by the engine, and both
 * topologies write into it the same way. `memory` is the module's own
 * `wasmMemory.buffer`, which is only shareable when the page is cross-origin
 * isolated — otherwise the worker posts no descriptor and the host falls back
 * to `postPcm`.
 */
export interface PcmRingDescriptor {
    /**
     * The module's `wasmMemory.buffer`. Typed as ArrayBufferLike because that is
     * what the module exposes; in practice a descriptor only ever crosses
     * postMessage when it is a SharedArrayBuffer (the worker checks before
     * posting), since a plain ArrayBuffer cannot be shared.
     */
    memory: ArrayBufferLike;
    /** Byte offset of the int32 header: [write, capacity, read, overruns]. */
    headerPtr: number;
    /** Byte offset of the interleaved float storage. */
    dataPtr: number;
    /** Stereo frames the ring holds (the data view is twice this long). */
    capacityFrames: number;
    /** Modulus the frame indices wrap at. */
    indexModulus: number;
}

/** Host → worker: boot the module and take over the transferred canvas. */
export interface RenderWorkerInitMessage {
    type: 'init';
    canvas: OffscreenCanvas;
    scriptSrc: string;
    width: number;
    height: number;
    targetFps?: number;
    governor?: boolean;
    meshQuality?: string;
}

/** Host → worker: canvas size changed. */
export interface RenderWorkerResizeMessage {
    type: 'resize';
    width: number;
    height: number;
}

/** Host → worker: PCM chunk, used only when the ring cannot be shared. */
export interface RenderWorkerPcmMessage {
    type: 'pcm';
    buffer: Float32Array;
    channels: number;
}

/**
 * Host → worker: write a preset into the worker module's virtual filesystem
 * and act on it.
 *
 * Presets cannot go over as a ccall: loading one is a VFS write followed by a
 * call, and the VFS only exists where the module does. Without this message a
 * worker-rendered page can play whatever playlist the bundle shipped with and
 * nothing else — which is most of what "the worker is a second implementation"
 * used to mean in practice.
 */
export interface RenderWorkerPresetMessage {
    type: 'preset';
    /** Path to write inside the worker module's FS, e.g. `/presets/url_x.milk`. */
    vfsPath: string;
    bytes: Uint8Array;
    /**
     * `load` crossfades to it, `load-hard` cuts to it, `add` only appends it to
     * the playlist. Mirrors load_preset_file / load_preset_file_hard /
     * add_preset_file.
     */
    mode: 'load' | 'load-hard' | 'add';
}

/**
 * Host → worker: proxy a `Module.ccall`. `requestId` is omitted for
 * fire-and-forget calls (`ccallVoid`), in which case no result is posted back.
 */
export interface RenderWorkerCcallMessage {
    type: 'ccall';
    name: string;
    returnType: string | null;
    argTypes: string[];
    args: unknown[];
    requestId?: number;
}

export type RenderWorkerHostMessage =
    | RenderWorkerInitMessage
    | RenderWorkerResizeMessage
    | RenderWorkerPcmMessage
    | RenderWorkerPresetMessage
    | RenderWorkerCcallMessage;

/** Worker → host: module booted and the render loop is running. */
export interface RenderWorkerReadyMessage {
    type: 'ready';
}

/** Worker → host: this browser/worker cannot run the offscreen path. */
export interface RenderWorkerUnsupportedMessage {
    type: 'unsupported';
    reason: string;
}

/** Worker → host: a recoverable failure the host should surface. */
export interface RenderWorkerErrorMessage {
    type: 'error';
    message: string;
}

/** Worker → host: periodic render statistics. */
export interface RenderWorkerStatsMessage {
    type: 'stats';
    fps: number;
    fboFormat: number;
    qualityTier: number;
    /**
     * Governor v2 internal render scale (1.0/0.75/0.5) currently applied to the
     * offscreen backing store. The host cannot read it off the canvas — it gave
     * the canvas away — so the worker reports it, and a host that wants to show
     * the effective resolution has the same information it has on the main
     * thread.
     */
    renderScale: number;
}

/**
 * Worker → host: the module's PCM ring is shareable, here is where it lives.
 * Sent once, after init. Absent means the host must use `postPcm`.
 */
export interface RenderWorkerPcmRingMessage {
    type: 'pcm-ring';
    descriptor: PcmRingDescriptor;
}

/** Worker → host: the result of a `ccall` that carried a `requestId`. */
export interface RenderWorkerCcallResultMessage {
    type: 'ccall-result';
    requestId: number;
    result: unknown;
}

export type RenderWorkerMessage =
    | RenderWorkerReadyMessage
    | RenderWorkerUnsupportedMessage
    | RenderWorkerErrorMessage
    | RenderWorkerStatsMessage
    | RenderWorkerPcmRingMessage
    | RenderWorkerCcallResultMessage;

/** The handle `setupRenderWorker()` hands back to the host. */
export interface RenderWorkerHandle {
    worker: Worker;
    /** Null until the worker posts a shareable ring, and when it never does. */
    getPcmRing(): PcmRingWriter | null;
    /** Writes to the ring when there is one, else posts the chunk. */
    feedPcm(buffer: Float32Array, channels: number): void;
    postResize(width: number, height: number): void;
    postPcm(buffer: Float32Array, channels: number): void;
    /** Writes `bytes` into the worker module's VFS at `vfsPath`, then acts on it. */
    postPreset(vfsPath: string, bytes: Uint8Array, mode?: 'load' | 'load-hard' | 'add'): void;
    ccall(
        name: string,
        returnType: string | null,
        argTypes: string[],
        args: unknown[],
    ): Promise<unknown>;
    ccallVoid(name: string, argTypes: string[], args: unknown[]): void;
}

/** Writer half of the WASM-owned PCM ring (html/projectm-pcm-ring.js). */
export interface PcmRingWriter {
    /** Duplicates mono input to both channels before writing. */
    write(buffer: Float32Array, channels?: number): number;
    writeIndex(): number;
    capacityFrames: number;
    descriptor: PcmRingDescriptor;
}
