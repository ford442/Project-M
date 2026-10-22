// Shared types for projectm-context.js. This file is types-only — the real
// ProjectMContext class and createProjectMContext() live in projectm-context.js
// (a `checkJs`-covered module; see tsconfig.json), which imports these shapes via
// `@typedef {import('./projectm-context-types.ts').ProjectMContextOptions}`. Do not
// add a `declare class ProjectMContext` stub here: that duplicates the real
// implementation and drifts silently (see html/README.md TypeScript migration
// notes / Epic #163).
//
// Deliberately named *-types.ts rather than projectm-context.ts: TypeScript's
// "bundler" module resolution resolves a `./projectm-context.js` specifier to a
// same-basename `projectm-context.ts` if one exists, which would silently shadow
// the real projectm-context.js for every JS importer during typecheck (the exact
// drift this migration is closing). A distinct basename removes the ambiguity.

export type ProjectMAudioSource = 'element' | 'external' | 'none';

export type ProjectMAudioSourceActive = 'none' | 'element' | 'external' | 'worklet';

export interface ProjectMAudioSourceStatus {
    activeSource: ProjectMAudioSourceActive;
    streamEnabled: boolean;
    externalEnabled: boolean;
    workletAllowed: boolean;
}

export type ProjectMMeshQuality = 'auto' | 'high' | 'low';

/**
 * Where rendering happens.
 *
 * `'auto'` (the default) asks isRenderWorkerEnabled() — which says yes unless
 * the page opted out with `?renderWorker=0` — and falls back to `'main'` on its
 * own when the browser cannot provide an OffscreenCanvas render worker.
 * `'worker'` demands the worker and fails start() if it cannot have it, which
 * is what a parity test wants. `'main'` pins rendering to this thread.
 */
export type ProjectMRenderTopology = 'auto' | 'worker' | 'main';

/**
 * When the playlist moves on (`projectm-4/rhythm.h`): after the preset duration,
 * every `presetSwitchBars` bars, or on the first downbeat after a detected
 * section change. The musical policies fall back to the timer while the tempo
 * is not known.
 */
export type ProjectMPresetSwitchPolicy = 'timer' | 'bars' | 'section';

/** Musical-time events delivered by `ProjectMContext.on()`. */
export type ProjectMRhythmEventType = 'beat' | 'bar' | 'section';

/** Tempo and phase of the most recent frame, from `ProjectMContext.getRhythmInfo()`. */
export interface ProjectMRhythmInfo {
    /** Beats per minute, 0 while the tracker is not confident. */
    bpm: number;
    /** 0..1, 0 = the beat. */
    beatPhase: number;
    /** 0..1 over a four-beat bar, 0 = downbeat. */
    barPhase: number;
    /** 0..1. */
    confidence: number;
    /** Beats counted since the engine started. */
    beatIndex: number;
    /** Section index. */
    section: number;
}

/**
 * How a frame reaches the canvas. `'browser'` (the default): the browser
 * presents the drawing buffer whenever it composites the page. `'manual'`: the
 * canvas changes only when the engine commits a frame — once per rendered
 * frame, after the compositor — so an offline export ticking a deterministic
 * clock gets exactly one presented frame per tick. Same as
 * `explicitSwapControl: true`, and needs the same bundle (linked with
 * `PROJECTM_WASM_EXPLICIT_SWAP=1`); any other bundle fails start() with init code 9.
 */
export type ProjectMPresentMode = 'browser' | 'manual';

/** Settings of the temporal flash limiter; see `ProjectMContextOptions.flashLimit`. */
export interface ProjectMFlashLimitOptions {
    /**
     * Span of mean relative luminance (0..1) the presented frames may cover within
     * the limiter's ~1/3 s memory, which also caps every frame-to-frame step.
     * Default 0.06. See docs/FLASH_LIMITER.md.
     */
    threshold?: number;
}

/** The flash limiter's state, from `ProjectMContext.getFlashLimitStats()`. */
export interface ProjectMFlashLimitStats {
    enabled: boolean;
    threshold: number;
    /** Frames blended toward the previous one since the limiter was enabled. */
    clampedFrames: number;
}

/** Options of `ProjectMContext.captureFrame()`. */
export interface ProjectMCaptureFrameOptions {
    /**
     * Render the frame to capture now (one `render_frame()`, i.e. one tick of a
     * deterministic clock) instead of waiting for the render loop to draw it. For
     * offline export with the render loop paused; on a running loop it renders an
     * extra frame. Default false.
     */
    renderFrame?: boolean;
    /** Give up (reject) when no frame arrived within this many ms. Default 5000. */
    timeoutMs?: number;
}

/**
 * One presented frame, read back by `ProjectMContext.captureFrame()`: the
 * drawing buffer's RGBA8 pixels, top row first, `width * height * 4` bytes —
 * `new ImageData(frame.data, frame.width, frame.height)` takes it as is.
 */
export interface ProjectMCapturedFrame {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    /** The engine's rendered-frame count right after this frame. */
    frameIndex: number;
}

export interface ProjectMErrorDetail {
    /**
     * The engine's init code (docs/EMSCRIPTEN.md), `-1` for any other failure,
     * or `-2` (`PRESET_SWITCH_FAILED`) for a preset that failed to load while
     * the engine keeps running.
     */
    code: number;
    message: string;
    error?: unknown;
}

export interface ProjectMPresetDetail {
    name: string;
    path?: string;
    text?: string;
}

export interface ProjectMContextOptions {
    /**
     * Primary render canvas. Prefer passing the element; ProjectMContext assigns a
     * unique id when missing and passes `#id` to WASM (`init_with_canvases`).
     * Legacy hosts may still use a page-global `#mcanvas`.
     */
    canvas: HTMLCanvasElement;
    /**
     * Secondary display canvas (black underlay / flipped composite). Optional for
     * hosts that only need the WebGL surface; when omitted, resize skips it.
     * Legacy default id is `#scanvas`.
     */
    secondaryCanvas?: HTMLCanvasElement | null;
    /**
     * Explicit CSS selectors for the WASM host. When omitted, derived from
     * `canvas.id` / `secondaryCanvas.id` (auto-assigned if needed).
     */
    primaryCanvasSelector?: string;
    secondaryCanvasSelector?: string;
    /** Element observed for resize / DPR sync. Defaults to the canvas parent. */
    container?: HTMLElement;
    /**
     * A projectM Module already booted by `bootProjectMSharedModule()`. When
     * set, this context does NOT boot its own Module; it creates a dedicated
     * engine instance inside the shared one via `create_host()` (#168 Phase B),
     * so several visualizers share one INITIAL_MEMORY reservation without
     * iframes. The shared Module is torn down by whoever booted it, not by this
     * context's `destroy()`. See docs/EMSCRIPTEN.md ("Multi-instance host state").
     */
    sharedModule?: import('./generated/projectm-wasm-api.ts').ProjectMModule | null;
    /** Override resolved WASM glue URL (absolute or site-relative). */
    wasmScriptUrl?: string;
    /** Base URL for `resolveWasmScriptUrl()` when `wasmScriptUrl` is omitted. */
    wasmBaseUrl?: string;
    /**
     * Selectable host bundle version (`?wasm=` / picker). Forwarded to
     * `createProjectMModule({ wasmVersion })` so locateFile remaps smoke
     * artifact names to the chosen deploy tag. Ignored when `wasmScriptUrl`
     * alone is enough and the default bundle is intended.
     */
    wasmVersion?: string;
    /** Fail fast when COOP/COEP headers are missing. Default true. */
    requireCrossOriginIsolation?: boolean;
    meshQuality?: ProjectMMeshQuality;
    targetFps?: number;
    qualityGovernor?: boolean;
    /** Enable near-black pixel transparency in the final blit. */
    transparent?: boolean;
    transparencyThreshold?: number;
    aspectCorrection?: boolean;
    /**
     * Hint for hosts compositing over non-black backgrounds (canvas CSS). Not
     * the WebGL alpha attribute — that is {@link contextAlpha}.
     */
    alpha?: boolean;
    /**
     * WebGL context attributes + dual-FBO precision, passed to the WASM host as
     * arguments of `create_host_with_config()` (#128 / #84 / #179 A5), on the
     * main thread and in the render worker alike. These replace the old `?aa=`
     * / `?capture=` / `?fboPrecision=` scraping the C++ side used to do; hosts
     * parse the query string and pass these instead (see `projectm-core.html`).
     * Each engine in a shared Module keeps its own attributes (#246).
     */
    /** WebGL `alpha` attribute: an alpha channel in the drawing buffer (default true — transparency overlays). */
    contextAlpha?: boolean;
    /**
     * WebGL `premultipliedAlpha` (default true). Hosts that key on canvas
     * transparency with straight alpha turn it off.
     */
    premultipliedAlpha?: boolean;
    /**
     * Refuse a software WebGL renderer (SwiftShader, llvmpipe): start() fails
     * with init code 8 instead of running at a few frames per second. Default
     * false, so headless CI still starts; production hosts can opt in.
     */
    failIfMajorPerformanceCaveat?: boolean;
    /**
     * Manual present: the canvas shows a frame only when the engine commits it
     * (once per `render_frame()`, after the compositor). Needs a bundle linked
     * with `PROJECTM_WASM_EXPLICIT_SWAP=1`; any other bundle fails start() with
     * init code 9. Default false. The hook for offline video capture (#256 / #262).
     */
    explicitSwapControl?: boolean;
    /**
     * `'manual'` presents only frames the engine commits; see
     * {@link ProjectMPresentMode}. Default `'browser'`.
     */
    presentMode?: ProjectMPresentMode;
    /**
     * Temporal flash limiter (default off): blends a frame toward the previous one
     * when its mean luminance would change faster than the threshold allows, for
     * viewers sensitive to flashing. `true` uses the default threshold. Applied to
     * this context's engine before its first frame. Off, frames reach the canvas
     * exactly as without it. See docs/FLASH_LIMITER.md for what it does not cover.
     */
    flashLimit?: boolean | ProjectMFlashLimitOptions;
    /**
     * WebGL `desynchronized` hint: low-latency present that may bypass the
     * compositor (and tear). Live hosts only; default false.
     */
    desynchronized?: boolean;
    /** Multisampled canvas (default false — #178; only sprite geometry benefits). */
    antialias?: boolean;
    /** Keep a stable back-buffer for screenshot/readback hosts (default false). */
    preserveDrawingBuffer?: boolean;
    /** GPU power hint (default 'high-performance'; mobile may want 'low-power'). */
    powerPreference?: 'default' | 'low-power' | 'high-performance';
    /**
     * Canvas depth attachment (default false — #246). Milkdrop's depth use lives
     * on preset FBOs; opt in only for user sprites that need canvas depth.
     */
    depth?: boolean;
    /** Canvas stencil attachment (default false — #246). */
    stencil?: boolean;
    /** Dual-FBO color precision (default 'half' = RGBA16F; 'high' = RGBA32F; 'byte' = RGBA8). */
    fboPrecision?: 'half' | 'high' | 'byte';
    /**
     * Render-path ablation switches (`?blurPath=copy`, `?copyPath=shader`,
     * `?perPixelEval=cpu`), handed to the WASM host with
     * `set_render_path_overrides()` before init — on either topology, since the
     * render worker cannot read the page URL itself. Defaults to the page's own
     * query string (`windowRef.location.search`).
     */
    renderPathOverrides?: import('./projectm-render-worker-types.ts').RenderPathOverrides;
    presetUrl?: string;
    presetLocked?: boolean;
    /** When the playlist switches presets. Default `'timer'`. */
    presetSwitchPolicy?: ProjectMPresetSwitchPolicy;
    /** Bars per preset (`'bars'`) or the shortest preset in bars (`'section'`). Default 16. */
    presetSwitchBars?: number;
    /**
     * Crossfade length in beats, resolved against the tempo when each crossfade
     * starts. While the tempo is unknown the duration in seconds applies.
     * Default 0: seconds only.
     */
    transitionBeats?: number;
    /** A known tempo (BPM) instead of the estimate, e.g. from track metadata. */
    rhythmHint?: number;
    audioSource?: ProjectMAudioSource;
    /** HTMLMediaElement or CSS selector when `audioSource` is `element`. */
    audioElement?: HTMLMediaElement | string;
    /** Origin allowlist for external PCM postMessage (opt-in; empty disables by default). */
    externalPcmOrigins?: string[];
    /** Fired when the exclusive audio-source policy changes (see AudioSourceRouter). */
    onAudioSourceChange?: (status: ProjectMAudioSourceStatus) => void;
    /** Reuse an existing {@link AudioSourceRouter} (e.g. legacy `projectm-core.html`). */
    audioRouter?: import('./projectm-audio-source-router.js').AudioSourceRouter;
    devicePixelRatio?: number;
    documentRef?: Document;
    windowRef?: Window & typeof globalThis;
    onReady?: (context: import('./projectm-context.js').ProjectMContext) => void;
    onError?: (detail: ProjectMErrorDetail) => void;
    onPresetChanged?: (detail: ProjectMPresetDetail) => void;
    onFps?: (fps: number) => void;
    /** Where to render; see {@link ProjectMRenderTopology}. Defaults to `'auto'`. */
    renderTopology?: ProjectMRenderTopology;
    /**
     * Called when the render worker was wanted but could not be used, with the
     * reason, just before start() continues on the main thread. Purely
     * informational — the fallback is automatic.
     */
    onRenderWorkerFallback?: (reason: string) => void;
}

/**
 * `ProjectMContextOptions` after defaults are applied in the constructor — the
 * shape of `ProjectMContext#options`. Keep the `Pick` list in sync with the
 * defaults object in projectm-context.js.
 */
export type ProjectMResolvedContextOptions = Required<
    Pick<
        ProjectMContextOptions,
        | 'requireCrossOriginIsolation'
        | 'meshQuality'
        | 'targetFps'
        | 'qualityGovernor'
        | 'transparent'
        | 'transparencyThreshold'
        | 'aspectCorrection'
        | 'alpha'
        | 'audioSource'
        | 'presetLocked'
        | 'renderTopology'
        | 'devicePixelRatio'
    >
> &
    ProjectMContextOptions;
