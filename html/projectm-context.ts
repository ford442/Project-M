import type { ProjectMModule } from './generated/projectm-wasm-api.ts';

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
    onReady?: (context: ProjectMContext) => void;
    onError?: (detail: ProjectMErrorDetail) => void;
    onPresetChanged?: (detail: ProjectMPresetDetail) => void;
    onFps?: (fps: number) => void;
}

export declare class ProjectMContext {
    readonly options: Required<
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
            | 'documentRef'
            | 'windowRef'
        >
    > &
        ProjectMContextOptions;

    readonly canvas: HTMLCanvasElement;
    readonly secondaryCanvas: HTMLCanvasElement | null;
    readonly container: HTMLElement;
    module: ProjectMModule | null;
    ready: boolean;
    destroyed: boolean;

    constructor(options: ProjectMContextOptions);
    start(): Promise<ProjectMContext>;
    loadPresetUrl(url: string): Promise<{ url: string; vfsPath: string; filename: string }>;
    loadPresetFile(file: File): Promise<{ filename: string; vfsPath: string }>;
    nextPreset(): void;
    setLocked(locked: boolean): void;
    setTransparent(enabled: boolean): void;
    setMeshQuality(quality: ProjectMMeshQuality): string;
    setTargetFps(fps: number): number;
    resize(): boolean;
    destroy(): void;
}

export declare function createProjectMContext(options: ProjectMContextOptions): Promise<ProjectMContext>;

export declare function updatePresetDisplay(
    name: string,
    options?: {
        documentRef?: Document;
        windowRef?: Window;
        selector?: string;
        prefix?: string;
        text?: string;
    }
): void;
