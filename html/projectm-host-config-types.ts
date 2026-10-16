// projectm-host-config-types.ts
//
// Types for projectm-host-config.js: the one place the host pages' URL flags
// (`?wasm=`, `?aa=`, `?presetApi=`, ...) and their attribute / localStorage
// fallbacks are declared and parsed.

/** Where getHostConfig() / readHostFlag() look, in precedence order. */
export interface HostConfigSources {
    /**
     * The query string (`'?a=1'` or `'a=1'`) or already-parsed params. Default:
     * `globalThis.location.search`.
     */
    search?: string | URLSearchParams | null;
    /**
     * An element whose attributes form the second tier: a
     * `<project-m-visualizer>`, or `document.documentElement` for a page that
     * pins a setting in markup. Default: none.
     */
    element?: { getAttribute(name: string): string | null } | null;
    /**
     * Page globals, the third tier (`window.PROJECTM_PRESET_API_BASE`,
     * `window.__projectMCaptureMode`). Default: `globalThis`.
     */
    globals?: Record<string, unknown> | null;
    /** The fourth tier. Default: `globalThis.localStorage` (access guarded). */
    storage?: { getItem(key: string): string | null } | null;
}

/**
 * One flag. Every tier it names is read in order (query, attribute, global,
 * storage) and the first value `parse` accepts wins; a value it rejects
 * (`undefined`) falls through to the next tier, so a garbled `?targetFps=abc`
 * cannot hide a valid stored preference. `default` applies when no tier has one.
 */
export interface HostFlagSpec<T> {
    query?: string;
    attribute?: string;
    global?: string;
    storage?: string;
    parse(raw: string): T | undefined;
    default: T;
    /** Accepted values, for the docs table. */
    values: string;
    /** What it does, for the docs table (one sentence). */
    doc: string;
    /** The modules that act on it. */
    readBy: string[];
}

export type SwitchOn = 'timer' | 'bars' | 'section';
export type MeshQualitySetting = 'auto' | 'low' | 'high';
export type FboPrecisionSetting = 'half' | 'high' | 'byte';

/** Every flag a first-party host honours, parsed. */
export interface HostConfig {
    // Bundle and topology
    wasm: string | null;
    renderWorker: boolean;
    // WebGL context (projectm-core-host.js -> ProjectMContext options)
    aa: boolean;
    capture: boolean;
    depth: boolean;
    fboPrecision: FboPrecisionSetting;
    transparent: boolean;
    // Render-path ablations (set_render_path_overrides)
    blurPath: 'copy' | 'default';
    copyPath: 'shader' | 'default';
    perPixelEval: 'cpu' | 'default';
    // Frame pacing and quality
    targetFps: number;
    governor: boolean;
    meshQuality: MeshQualitySetting;
    // Presets
    presetApi: string;
    presetDuration: number;
    localPresets: boolean;
    devPreset: boolean;
    devPresetUrl: string;
    devPoll: boolean;
    devPollMs: number;
    // Musical scheduling (projectM-4/rhythm.h)
    switchOn: SwitchOn;
    switchBars: number;
    transitionBeats: number;
    bpm: number;
    rhythmDebug: boolean;
    // Diagnostics and benchmarks
    perfhud: boolean;
    pcmhud: boolean;
    benchmark: boolean;
    frames: number;
    preset: string | null;
    crossfade: boolean;
    crossfadeSec: number;
    crossfadePresets: string[];
    presetSwitchBench: boolean;
    audioTest: boolean;
    simulateInitFail: boolean;
    debugSender: boolean;
    // Experimental and themed hosts
    experimental: boolean;
    depthModule: string | null;
    mode: string | null;
}

export type HostFlagName = keyof HostConfig;

export type HostFlagRegistry = { readonly [K in HostFlagName]: HostFlagSpec<HostConfig[K]> };
