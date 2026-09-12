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

export type ProjectMAudioRouterMode = 'exclusive' | 'mix';

export interface ProjectMAudioSourceStatus {
    activeSource: ProjectMAudioSourceActive;
    mode: ProjectMAudioRouterMode;
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

export interface ProjectMErrorDetail {
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
    /** Hint for hosts compositing over non-black backgrounds (canvas CSS). */
    alpha?: boolean;
    presetUrl?: string;
    presetLocked?: boolean;
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
