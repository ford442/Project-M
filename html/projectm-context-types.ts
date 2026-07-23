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

export type ProjectMMeshQuality = 'auto' | 'high' | 'low';

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
    /** Primary render canvas. Emscripten expects `#mcanvas` in the document. */
    canvas: HTMLCanvasElement;
    /** Secondary display canvas (`#scanvas`). Required by the current WASM build. */
    secondaryCanvas?: HTMLCanvasElement | null;
    /** Element observed for resize / DPR sync. Defaults to the canvas parent. */
    container?: HTMLElement;
    /** Override resolved WASM glue URL (absolute or site-relative). */
    wasmScriptUrl?: string;
    /** Base URL for `resolveWasmScriptUrl()` when `wasmScriptUrl` is omitted. */
    wasmBaseUrl?: string;
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
    devicePixelRatio?: number;
    documentRef?: Document;
    windowRef?: Window & typeof globalThis;
    onReady?: (context: import('./projectm-context.js').ProjectMContext) => void;
    onError?: (detail: ProjectMErrorDetail) => void;
    onPresetChanged?: (detail: ProjectMPresetDetail) => void;
    onFps?: (fps: number) => void;
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
        | 'devicePixelRatio'
    >
> &
    ProjectMContextOptions;
