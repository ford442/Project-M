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
export type ProjectMModuleLike = Partial<ProjectMModule> & {
    /** Present on the glue instance for modularized builds. */
    wasmMemory?: WebAssembly.Memory;
    HEAPF32?: Float32Array;
};

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
        /**
         * External audio-player controls exposed by projectm-audio-player.js
         * for inline `onclick=` handlers in the legacy panel hosts.
         */
        cycleAudioPlayer?: () => void;
        closeAudioPlayer?: () => void;
        flacPlayer?: () => void;
        modPlayer?: () => void;
        openFlacPlayer?: (trackUrl?: string) => void;
        openModPlayer?: (trackUrl?: string) => void;
        /**
         * Experimental depth/glTF bridge (`?experimental=1`,
         * projectm-experimental-bridge.js) and the legacy depth-module loader
         * guard it shares with the B3HD hosts.
         */
        pmExperimental?: Record<string, unknown>;
        __pmDepthModuleLoading?: Promise<boolean>;
        /** Legacy global preset-label updater used by the full `.1ink` hosts. */
        updatePresetDisplay?: (name: string, options?: { text?: string }) => void;
        /** Mesh-quality hook registered by projectm-mesh-quality.js. */
        pmSetMeshQuality?: (quality: string) => string;
        /** Dual-FBO color format, registered by projectm-fbo-format.js. */
        pmGetFboFormat?: () => 'RGBA32F' | 'RGBA16F' | 'RGBA8';
        /**
         * Transpiled-GLSL cache hook, registered by projectm-shader-cache.js and
         * called from `js_on_transpiled_shader_stored()` (projectM_emscripten.cpp).
         * `kind` is 0=warp, 1=composite.
         */
        pmOnTranspiledShaderStored?: (cacheKey: string, kind: 0 | 1, glsl: string) => void;
        /** Hot-reload hooks registered by projectm-preset-dev.js (`?devPreset=1`). */
        pmReloadPresetText?: (text: string, label?: string) => Promise<void>;
        pmPresetDevEnabled?: boolean;
        /**
         * Perf HUD hooks registered by projectm-perf.js. `pmOnPerfFrame` is
         * called once per frame from `js_perf_report_frame()`
         * (WasmPerfGovernor.cpp) — the stats shape is defined there.
         */
        pmSetPerfHudEnabled?: (enabled: boolean) => void;
        pmOnPerfFrame?: (stats: {
            totalMs: number;
            audioMs: number;
            perFrameEvalMs: number;
            perPixelEvalMs: number;
            blurMs: number;
            waveformsShapesMs: number;
            compositeMs: number;
            gpuMs: number;
            fps: number;
        }) => void;
    }

    /**
     * Globals the WASM glue and `WasmAudioBridge.cpp`'s EM_JS blocks publish on
     * `window`, redeclared as `var` so the host modules can also reach them
     * through `globalThis` (the `Window` augmentation above does not apply to
     * `typeof globalThis`, which is what `globalThis.foo` resolves against).
     *
     * Keep in sync with `WasmAudioBridge.cpp` — these are the JS half of the
     * worklet playback contract, not host-owned state.
     */

    // eslint-disable-next-line no-var
    var Module: ProjectMModuleLike | undefined;

    /** Shared AudioContext created by `js_initialize_worklet_system_once`. */
    // eslint-disable-next-line no-var
    var projectMAudioContext_Global_Cpp: AudioContext | undefined;
    /** Worklet node wired to the projectM PCM path (null while torn down). */
    // eslint-disable-next-line no-var
    var projectMWorkletNode_Global_Cpp: AudioWorkletNode | null | undefined;
    /** Heap pointer for the 2048-float PCM transfer buffer (`_malloc`'d once). */
    // eslint-disable-next-line no-var
    var projectMAudioBufferPtr: number | undefined;
    /** Host-side song loader installed by projectm-worklet-playback.js. */
    // eslint-disable-next-line no-var
    var projectMLoadSongIntoWorklet:
        | ((path: string, loop?: boolean, startPlaying?: boolean) => void)
        | undefined;
    /** Progress of the in-flight worklet song load. */
    // eslint-disable-next-line no-var
    var projectMSongLoadState: 'loading' | 'loaded' | 'error' | undefined;
    /** VFS path of the most recent song handed to the worklet. */
    // eslint-disable-next-line no-var
    var projectMLastSongPath: string | undefined;
    /** Guards double-installation of the worklet safety net. */
    // eslint-disable-next-line no-var
    var __projectMWorkletSafetyNetInstalled: boolean | undefined;
    /** Supersession token so a stale BroadcastChannel load can be discarded. */
    // eslint-disable-next-line no-var
    var __projectMSongLoadToken: string | undefined;

    /**
     * Weeks-on-Fire demo-mode globals (projectm-weeks-on-fire.js). The FLAC
     * helpers are called from the WASM EM_JS glue, which can only reach the
     * global scope.
     */
    // eslint-disable-next-line no-var
    var __projectMWeeksOnFire: boolean | undefined;
    // eslint-disable-next-line no-var
    var __projectMWeeksPaths: Record<string, string> | undefined;
    // eslint-disable-next-line no-var
    var resolveFlacDecoderUrl: (() => string) | undefined;
    // eslint-disable-next-line no-var
    var ensureWeeksFlacDecoderFrame: (() => HTMLIFrameElement) | undefined;
    // eslint-disable-next-line no-var
    var openWeeksFlacDecoder:
        | ((options?: { preferIframe?: boolean }) => unknown)
        | undefined;

    /**
     * Host-side song routing globals (projectm-song-loader.js). The module
     * reaches these through `globalThis`, so the `Window` members above are
     * not enough on their own.
     */
    // eslint-disable-next-line no-var
    var __projectMSongCatalog: string[] | undefined;
    // eslint-disable-next-line no-var
    var __projectMSongLoaderInstalled: boolean | undefined;
    // eslint-disable-next-line no-var
    var openModPlayer: ((trackUrl?: string) => void) | undefined;

    /** Emscripten runtime globals exported onto the global scope by the glue. */
    // eslint-disable-next-line no-var
    var wasmMemory: WebAssembly.Memory | undefined;
    // eslint-disable-next-line no-var
    var HEAPF32: Float32Array | undefined;
    // eslint-disable-next-line no-var
    var _malloc: ((size: number) => number) | undefined;
    // eslint-disable-next-line no-var
    var _projectm_pcm_add_float_wrapper:
        | ((pmHandle: number, audioPtr: number, samplesPerChannel: number, channels: number) => void)
        | undefined;
    // eslint-disable-next-line no-var
    var FS: { readFile: (path: string) => Uint8Array } | undefined;
}

export {};
