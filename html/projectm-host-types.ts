// Shared ambient types for the projectM host layer's `checkJs`-migrated modules.
//
// This is a *types-only* module (no runtime code): the shared `.js` host modules
// import these shapes through JSDoc `@typedef {import('./projectm-host-types.ts')...}`
// so there is a single source of truth for the Emscripten module surface and the
// host-owned `window` globals. Keep it in sync with the wrappers in
// `generated/projectm-wasm-api.ts` and the globals set from `projectM_emscripten.cpp`.

import type { ProjectMModule } from './generated/projectm-wasm-api.ts';

/**
 * The subset of the Emscripten module instance the host modules touch, before
 * it is known to be fully booted. Every member is optional because the host
 * defensively feature-detects each symbol before use (the WASM build's
 * exported set varies by link flags, and the module may not exist yet).
 *
 * Derived from the generated `ProjectMModule` (rather than hand-duplicated)
 * so a real module instance is always assignable here, and so an
 * (explicit, readiness-checked) cast back to `ProjectMModule` stays a valid
 * narrowing instead of an unrelated-type error.
 */
export type ProjectMModuleLike = Partial<ProjectMModule>;

/** Custom feed hook signature for {@link setupExternalAudioReceiver}. */
export type ExternalPcmFeedFn = (
    buffer: Float32Array,
    channels: number,
    sampleRate: number | undefined,
    samplesPerChannel: number,
) => boolean | void;

/** A queued external-PCM chunk awaiting a ready module. */
export interface ExternalPcmChunk {
    buffer: Float32Array;
    channels: number;
    sampleRate: number | undefined;
}

declare global {
    interface Window {
        /** Emscripten module instance published by the WASM glue. */
        Module?: ProjectMModuleLike;
        /** Module factory injected by the generated glue script. */
        createModule?: (...args: unknown[]) => Promise<ProjectMModuleLike> | ProjectMModuleLike;
        /** Basename of the most recently loaded preset. */
        currentPresetName?: string;
        /** Full VFS path of the most recently loaded preset (for context-loss reload). */
        currentPresetPath?: string;
        /** Init-error overlay hooks registered by projectm-init-errors.js. */
        pmReportInitError?: (code: number, detail?: string) => void;
        pmHideInitError?: () => void;
        /** Shared AudioContext created by `js_initialize_worklet_system_once` (projectM_emscripten.cpp). */
        projectMAudioContext_Global_Cpp?: AudioContext;
        /** FPS-governor hooks registered by projectm-fps-governor.js. */
        pmSetTargetFps?: (fps: number) => number;
        pmSetQualityGovernorEnabled?: (enabled: boolean) => boolean;
        pmGetQualityTier?: () => number;
        /** Governor v2 (docs/PERFORMANCE.md): tier-change push notifications from WasmPerfGovernor.cpp. */
        pmOnGovernorTierChange?: (tier: number) => void;
        pmOnGovernorRenderScaleChange?: ((scale: number) => void) | null;
        pmOnGovernorBlurCapChange?: (cap: number) => void;
        /** Governor v2 pull getters registered by projectm-fps-governor.js. */
        pmGetGovernorRenderScale?: () => number;
        pmGetGovernorBlurCap?: () => number;
        /** Mesh-quality hook registered by projectm-mesh-quality.js. */
        pmSetMeshQuality?: (quality: string) => string;
    }

    // eslint-disable-next-line no-var
    var Module: ProjectMModuleLike | undefined;
}

export {};
