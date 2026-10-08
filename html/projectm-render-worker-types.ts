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

/**
 * `set_context_config()`'s arguments. Attributes are baked into the WebGL
 * context when `init()` creates it, so the worker applies these first.
 */
export interface RenderWorkerContextConfig {
    antialias: number;
    preserveDrawingBuffer: number;
    depth: number;
    stencil: number;
    alpha: number;
    /** 0 default, 1 low-power, 2 high-performance. */
    powerPreference: number;
    /** Preferred dual-FBO format: 0 RGBA16F, 1 RGBA32F, 2 RGBA8 (as `dual_fbo_get_format()` reports). */
    fboPrecision: number;
}

/**
 * The page's render-path ablation switches (`?blurPath=copy`,
 * `?copyPath=shader`, `?perPixelEval=cpu`). A worker cannot read them itself:
 * its `location` is the worker script's URL, which has no query.
 */
export interface RenderPathOverrides {
    blurCopyPath: boolean;
    copyShaderPath: boolean;
    perPixelForceCpu: boolean;
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
    /** Applied with `set_context_config()` before `init()`. */
    contextConfig?: RenderWorkerContextConfig;
    /** Applied with `set_render_path_overrides()` before `init()`. */
    renderPathOverrides?: RenderPathOverrides;
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

/**
 * Host → worker: rebuild the engine on the (restored) WebGL context.
 *
 * The worker runs the same re-init the main thread does — `init()` and
 * `start_render()` against the module it already holds — and answers with a
 * {@link RenderWorkerContextRecoveredMessage}. `init()` is the documented
 * re-init export: it tears down whatever engine is left and rebuilds one, and
 * it refuses with code 5 while the context is still lost. The transferred
 * canvas, its `#mcanvas` registration, `set_context_config()` and the PCM ring
 * all survive a context loss, so nothing else has to be replayed.
 */
export interface RenderWorkerRecoverContextMessage {
    type: 'recover-context';
}

export type RenderWorkerHostMessage =
    | RenderWorkerInitMessage
    | RenderWorkerResizeMessage
    | RenderWorkerPcmMessage
    | RenderWorkerPresetMessage
    | RenderWorkerCcallMessage
    | RenderWorkerRecoverContextMessage;

/**
 * One frame of perf-HUD stats, as `js_perf_report_frame()`
 * (src/wasm/WasmPerfGovernor.cpp) builds it and hands to `pmOnPerfFrame`. Keep
 * the keys in sync with that EM_JS block.
 *
 * The CPU fields (`audioMs` … `compositeMs`, `totalMs`) are `steady_clock`
 * submit times. The `gpu*Ms` fields are EXT_disjoint_timer_query_webgl2
 * TIME_ELAPSED results: `gpuMs` is the whole frame and the per-stage fields
 * tile it (they sum to `gpuMs`). Every GPU field is negative when the
 * extension is unavailable or no result has arrived yet.
 */
export interface PerfFrameStats {
    totalMs: number;
    audioMs: number;
    /**
     * Rhythm analysis: onsets, tempo, beat phase and sections (the pm_* preset
     * variables). Not part of `audioMs`. Absent from older bundles.
     */
    rhythmMs?: number;
    perFrameEvalMs: number;
    perPixelEvalMs: number;
    blurMs: number;
    waveformsShapesMs: number;
    /** CPU submit time of the composite pass and the Y-flips around it. */
    compositeMs: number;
    gpuMs: number;
    /** GPU stage: clears, user sprites and anything not attributed below. Absent from older bundles. */
    gpuOtherMs?: number;
    /** GPU stage: motion vectors + the warp mesh draw. */
    gpuWarpMs?: number;
    /** GPU stage: the blur chain. */
    gpuBlurMs?: number;
    /** GPU stage: custom shapes/waves, built-in waveform, darken center, border. */
    gpuShapesMs?: number;
    /** GPU stage: the Y-flip copy passes (#176) — the number that decides whether to remove them. */
    gpuCopyMs?: number;
    /** GPU stage: the final composite shader. */
    gpuCompositeMs?: number;
    /** GPU stage: output to the canvas — blit, transparency copy, or the dual-FBO compositor. */
    gpuPresentMs?: number;
    /**
     * True only on the frame that resolved a new GPU result. GPU results arrive
     * a frame or two late and repeat until the next one lands, so a sampler
     * that wants distinct GPU samples skips frames where this is false. Absent
     * from bundles that predate per-stage queries (treat as fresh).
     */
    gpuFresh?: boolean;
    fps: number;
    /** Absent from bundles that predate KHR_parallel_shader_compile support. */
    shaderLinkPending?: boolean;
    /**
     * How the per-pixel equations were evaluated for this frame. `'gpu'` means
     * they were compiled into the warp vertex shader and `perPixelEvalMs`
     * covers only the draw submission; `'cpu'` means the evaluator ran once
     * per warp mesh vertex. See docs/GPU_PERPIXEL_EVAL.md.
     */
    perPixelEvalPath?: 'gpu' | 'cpu';
}

/**
 * One frame's musical-time events, as `js_report_rhythm_event()`
 * (src/wasm/WasmRhythm.cpp) builds it and hands to `pmOnRhythmEvent`. Keep the
 * keys in sync with that EM_JS block. Only frames with at least one event are
 * reported (a beat about twice a second at 120 BPM), and only while
 * `set_rhythm_events(1)` is on.
 */
export interface RhythmEvent {
    /** The engine host it came from (create_host()'s handle; nonzero for the default host too). */
    host: number;
    /** A beat landed on this frame. */
    beat: boolean;
    /** The beat was a downbeat: a new bar starts. */
    bar: boolean;
    /** A new section of the song was detected. */
    section: boolean;
    /** Tempo in BPM (0 while not confident). */
    bpm: number;
    /** Beats counted since the engine started. */
    beatIndex: number;
    /** 0..1 over the bar. */
    barPhase: number;
    /** Section index after this event. */
    sectionIndex: number;
    /** Tracker confidence, 0..1. */
    confidence: number;
}

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
    /**
     * `get_render_path_overrides()`: the ablation switches in effect in the
     * worker's module (1 blurPath=copy, 2 copyPath=shader, 4 perPixelEval=cpu),
     * or -1 on a bundle without the export.
     */
    renderPathOverrides: number;
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

/**
 * Worker → host: the worker's WebGL context was lost. The `webglcontextlost`
 * event fires on the transferred OffscreenCanvas, i.e. in the worker, so this
 * is the only way the page learns of it. By the time this is posted the worker
 * has called `preventDefault()` (which is what lets the browser restore the
 * context) and `pm_handle_context_loss()`, so the engine is already torn down.
 */
export interface RenderWorkerContextLostMessage {
    type: 'context-lost';
}

/**
 * Worker → host: the browser restored the context. Only a notification — no
 * engine exists yet. The host answers with a
 * {@link RenderWorkerRecoverContextMessage}, so recovery is driven from one
 * place in both topologies.
 */
export interface RenderWorkerContextRestoredMessage {
    type: 'context-restored';
}

/**
 * Worker → host: the outcome of a `recover-context` request. `status` is what
 * `init()` returned: `0` means the engine is running again, `5` means the
 * browser has not restored the context yet (not an error — try again after
 * `context-restored`), anything else is an init failure.
 */
export interface RenderWorkerContextRecoveredMessage {
    type: 'context-recovered';
    status: number;
}

/**
 * Worker → host: perf-HUD frames the engine reported in the worker.
 *
 * `js_perf_report_frame()` calls `globalThis.pmOnPerfFrame` — which in the
 * worker is the worker's scope, where the page's HUD cannot hear it. The
 * worker batches the frames (one message per ~100 ms, not one per frame) and
 * the host replays them in order, so a benchmark sees every frame.
 */
export interface RenderWorkerPerfFramesMessage {
    type: 'perf-frames';
    frames: PerfFrameStats[];
}

/**
 * Worker → host: `set_perf_hud()` switched the engine's perf instrumentation
 * on or off (the worker-scope `pmSetPerfHudEnabled` call), so the page shows or
 * hides its HUD.
 */
export interface RenderWorkerPerfHudMessage {
    type: 'perf-hud';
    enabled: boolean;
}

/**
 * Worker → host: a beat, bar or section event the engine reported in the worker
 * (`pmOnRhythmEvent` in the worker's scope). Not batched: there are only a few a
 * second, and a batch would deliver the beat late.
 */
export interface RenderWorkerRhythmEventMessage {
    type: 'rhythm-event';
    event: RhythmEvent;
}

export type RenderWorkerMessage =
    | RenderWorkerContextLostMessage
    | RenderWorkerContextRestoredMessage
    | RenderWorkerContextRecoveredMessage
    | RenderWorkerReadyMessage
    | RenderWorkerUnsupportedMessage
    | RenderWorkerErrorMessage
    | RenderWorkerStatsMessage
    | RenderWorkerPcmRingMessage
    | RenderWorkerCcallResultMessage
    | RenderWorkerPerfFramesMessage
    | RenderWorkerPerfHudMessage
    | RenderWorkerRhythmEventMessage;

/** A context-loss notification relayed from the worker. */
export type RenderWorkerContextEvent = 'lost' | 'restored';

/** The handle `setupRenderWorker()` hands back to the host. */
export interface RenderWorkerHandle {
    worker: Worker;
    /**
     * Subscribes to the worker's context-loss notifications. Returns the
     * unsubscribe function.
     */
    onContextEvent(listener: (event: RenderWorkerContextEvent) => void): () => void;
    /**
     * Asks the worker to rebuild its engine and resolves with `init()`'s status
     * (see {@link RenderWorkerContextRecoveredMessage}). Overlapping calls share
     * one round trip.
     */
    recoverContext(): Promise<number>;
    /**
     * Subscribes to the perf-HUD frames the worker relays (one call per frame,
     * in order). Returns the unsubscribe function.
     */
    onPerfFrame(listener: (stats: PerfFrameStats) => void): () => void;
    /**
     * Subscribes to the engine's perf-HUD on/off notifications. Returns the
     * unsubscribe function.
     */
    onPerfHudEnabled(listener: (enabled: boolean) => void): () => void;
    /**
     * Subscribes to the beat/bar/section events the worker relays. Returns the
     * unsubscribe function.
     */
    onRhythmEvent(listener: (event: RhythmEvent) => void): () => void;
    /**
     * The most recent `stats` message, or null before the first one. Lets a
     * late subscriber (the FBO-format banner) read state the worker already
     * reported.
     */
    getLastStats(): RenderWorkerStatsMessage | null;
    /** Subscribes to the worker's periodic stats. Returns the unsubscribe function. */
    onStats(listener: (stats: RenderWorkerStatsMessage) => void): () => void;
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
