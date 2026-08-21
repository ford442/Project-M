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

/** PCM ring buffer shared with the worker via SharedArrayBuffer. */
export interface PcmRingInit {
    sab: SharedArrayBuffer;
    /** Stereo frames the ring can hold (the data view is twice this long). */
    capacityPairs: number;
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
    /** null when cross-origin isolation is unavailable; PCM then arrives by postMessage. */
    pcm: PcmRingInit | null;
}

/** Host → worker: canvas size changed. */
export interface RenderWorkerResizeMessage {
    type: 'resize';
    width: number;
    height: number;
}

/** Host → worker: PCM chunk, used only when the SAB ring is unavailable. */
export interface RenderWorkerPcmMessage {
    type: 'pcm';
    buffer: Float32Array;
    channels: number;
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
    | RenderWorkerCcallResultMessage;

/** The handle `setupRenderWorker()` hands back to the host. */
export interface RenderWorkerHandle {
    worker: Worker;
    pcmRing: PcmRing | null;
    postResize(width: number, height: number): void;
    postPcm(buffer: Float32Array, channels: number): void;
    ccall(
        name: string,
        returnType: string | null,
        argTypes: string[],
        args: unknown[],
    ): Promise<unknown>;
    ccallVoid(name: string, argTypes: string[], args: unknown[]): void;
}

/** Main-thread writer half of the SharedArrayBuffer PCM ring. */
export interface PcmRing {
    sab: SharedArrayBuffer;
    capacityPairs: number;
    /** Interleaves mono input to stereo before writing. */
    write(buffer: Float32Array, channels: number): void;
}
