// projectm-context-config.js
//
// The WebGL context config a host passes to create_host_with_config(): one
// encoder for both topologies. The main thread calls the export with it; the
// OffscreenCanvas render worker receives the same object in its `init` message
// and passes the same three numbers. See docs/EMSCRIPTEN.md "WebGL context
// attributes".

import {
    createHost,
    createHostWithConfig,
    getLastInitError,
    init as wasmInit,
    initWithCanvases,
    setContextConfig,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./projectm-render-worker-types.ts').WasmContextConfig} WasmContextConfig
 */

/**
 * Bits of create_host_with_config()'s `flags`. Mirrors WasmContextConfigFlag in
 * src/wasm/WasmWebGLContext.hpp (tests/web/projectm-context-config.test.mjs
 * keeps the two identical).
 */
export const CONTEXT_CONFIG_FLAGS = Object.freeze({
    antialias: 1 << 0,
    preserveDrawingBuffer: 1 << 1,
    depth: 1 << 2,
    stencil: 1 << 3,
    /** The WebGL `alpha` attribute — not the `alpha` option, which is a CSS hint. */
    contextAlpha: 1 << 4,
    premultipliedAlpha: 1 << 5,
    failIfMajorPerformanceCaveat: 1 << 6,
    explicitSwapControl: 1 << 7,
    desynchronized: 1 << 8,
});

/** @type {Record<string, number>} */
const POWER_PREFERENCE = { 'default': 0, 'low-power': 1, 'high-performance': 2 };
/** The FboFloatFormat numbering, which dual_fbo_get_format() also reports. */
/** @type {Record<string, number>} */
const FBO_PRECISION = { 'half': 0, 'high': 1, 'byte': 2 };

/**
 * Context options → create_host_with_config()'s arguments. Every attribute is
 * encoded explicitly, so the C++ defaults never decide anything for a JS host.
 *
 * `presentMode: 'manual'` sets the explicitSwapControl bit, like
 * `explicitSwapControl: true`.
 *
 * `options.alpha` is deliberately not read: it is the canvas-CSS compositing
 * hint. The WebGL alpha bit is `contextAlpha` (default on — transparency
 * overlays need it).
 *
 * @param {Partial<ProjectMContextOptions>} [options]
 * @returns {WasmContextConfig}
 */
export function resolveWasmContextConfig(options = {}) {
    const f = CONTEXT_CONFIG_FLAGS;
    const flags = (options.antialias ? f.antialias : 0)
        | (options.preserveDrawingBuffer ? f.preserveDrawingBuffer : 0)
        | (options.depth ? f.depth : 0)
        | (options.stencil ? f.stencil : 0)
        | ((options.contextAlpha ?? true) ? f.contextAlpha : 0)
        | ((options.premultipliedAlpha ?? true) ? f.premultipliedAlpha : 0)
        | (options.failIfMajorPerformanceCaveat ? f.failIfMajorPerformanceCaveat : 0)
        // presentMode: 'manual' is the same request as explicitSwapControl.
        | ((options.explicitSwapControl || options.presentMode === 'manual') ? f.explicitSwapControl : 0)
        | (options.desynchronized ? f.desynchronized : 0);
    return {
        flags,
        powerPreference: POWER_PREFERENCE[options.powerPreference ?? 'high-performance'] ?? 2,
        fboPrecision: FBO_PRECISION[options.fboPrecision ?? 'half'] ?? 0,
    };
}

/**
 * set_context_config()'s seven arguments, for bundles that predate
 * create_host_with_config(). The attributes added since cannot be expressed
 * there; {@link createConfiguredHost} refuses a config that needs them instead
 * of silently dropping them.
 *
 * @param {WasmContextConfig} config
 * @returns {[number, number, number, number, number, number, number]}
 */
export function legacyContextConfigArgs(config) {
    const f = CONTEXT_CONFIG_FLAGS;
    const bit = (/** @type {number} */ mask) => ((config.flags & mask) !== 0 ? 1 : 0);
    return [
        bit(f.antialias),
        bit(f.preserveDrawingBuffer),
        bit(f.depth),
        bit(f.stencil),
        bit(f.contextAlpha),
        config.powerPreference,
        config.fboPrecision,
    ];
}

/** Flags set_context_config() can express; anything else needs the new export. */
const LEGACY_EXPRESSIBLE = CONTEXT_CONFIG_FLAGS.antialias
    | CONTEXT_CONFIG_FLAGS.preserveDrawingBuffer
    | CONTEXT_CONFIG_FLAGS.depth
    | CONTEXT_CONFIG_FLAGS.stencil
    | CONTEXT_CONFIG_FLAGS.contextAlpha;

/**
 * Create and init an engine whose context uses `config`, in one call: there is
 * no "configure, then create" window for another context to land in.
 *
 * `create: 'host'` makes an additional host in a shared Module (the handle
 * matters: every later op activates it). `create: 'init'` is the owned-Module
 * path; on a bundle without create_host_with_config() it uses
 * init_with_canvases(), like before.
 *
 * `code` is the init error code (docs/EMSCRIPTEN.md "Init Error Codes"), 0 on
 * success, or -1 when the bundle cannot say.
 *
 * @param {import('./generated/projectm-wasm-api.ts').ProjectMModule} module
 * @param {{ primary: string, secondary: string, config: WasmContextConfig, create?: 'host' | 'init' }} request
 * @returns {{ handle: number, code: number }}
 */
export function createConfiguredHost(module, { primary, secondary, config, create = 'host' }) {
    const m = /** @type {any} */ (module);
    if (typeof m._create_host_with_config === 'function') {
        const handle = createHostWithConfig(
            module, primary, secondary, config.flags, config.powerPreference, config.fboPrecision);
        return { handle, code: handle ? 0 : lastInitError(module) };
    }

    // Bundle predates the export: the old two-step, which is only safe because
    // nothing awaits between the two calls.
    // set_context_config() always meant premultipliedAlpha on and everything
    // added since off; any other request would be silently dropped.
    const premultiplied = CONTEXT_CONFIG_FLAGS.premultipliedAlpha;
    if ((config.flags & ~(LEGACY_EXPRESSIBLE | premultiplied)) !== 0 || (config.flags & premultiplied) === 0) {
        console.warn('[projectM] this WASM bundle predates create_host_with_config(); '
            + 'premultipliedAlpha / failIfMajorPerformanceCaveat / explicitSwapControl / desynchronized '
            + 'cannot be applied, so the engine was not created');
        return { handle: 0, code: -1 };
    }
    setContextConfig(module, ...legacyContextConfigArgs(config));
    if (create === 'host') {
        const handle = createHost(module, primary, secondary);
        return { handle, code: handle ? 0 : lastInitError(module) };
    }
    const code = primary ? initWithCanvases(module, primary, secondary) : wasmInit(module);
    return { handle: 0, code };
}

/**
 * @param {import('./generated/projectm-wasm-api.ts').ProjectMModule} module
 * @returns {number}
 */
function lastInitError(module) {
    return typeof /** @type {any} */ (module)._get_last_init_error === 'function'
        ? getLastInitError(module)
        : -1;
}

/**
 * The `flashLimit` context option as the engine takes it: `null` when the
 * option leaves the limiter alone (absent or `false`, the engine default),
 * else whether to enable it and the threshold to set, if one was given.
 *
 * @param {Partial<ProjectMContextOptions>} [options]
 * @returns {import('./projectm-render-worker-types.ts').FlashLimitSettings | null}
 */
export function resolveFlashLimit(options = {}) {
    const option = options.flashLimit;
    if (!option) {
        return null;
    }
    const threshold = typeof option === 'object' ? option.threshold : undefined;
    return typeof threshold === 'number' && Number.isFinite(threshold)
        ? { enabled: true, threshold }
        : { enabled: true };
}
