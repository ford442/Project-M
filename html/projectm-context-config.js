// projectm-context-config.js
//
// The WebGL context config a host passes to create_host_with_config(): one
// encoder for both topologies. The main thread calls the export with it; the
// OffscreenCanvas render worker receives the same object in its `init` message
// and passes the same three numbers. See docs/EMSCRIPTEN.md "WebGL context
// attributes".

import {
    DEFAULT_HOST,
    createHost,
    createHostWithConfig,
    getLastInitError,
    init as wasmInit,
    initWithCanvases,
    setContextConfig,
} from './generated/projectm-wasm-api.js';
import { FORMAT_NAMES } from './projectm-fbo-format.js';

/**
 * @typedef {import('@projectm/types/context').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('@projectm/types/context').ProjectMContextSnapshot} ProjectMContextSnapshot
 * @typedef {import('@projectm/types/context').ProjectMContextCaps} ProjectMContextCaps
 * @typedef {import('@projectm/types/context').ProjectMContextLimits} ProjectMContextLimits
 * @typedef {import('@projectm/types/context').ProjectMContextAttributes} ProjectMContextAttributes
 * @typedef {import('@projectm/types/context').ProjectMContextAttributeMismatch} ProjectMContextAttributeMismatch
 * @typedef {import('@projectm/types/render-worker').WasmContextConfig} WasmContextConfig
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

/**
 * Bits of get_context_snapshot()'s result. Mirrors WasmContextSnapshotBit in
 * src/wasm/WasmWebGLContext.hpp (tests/web/projectm-context-config.test.mjs
 * keeps the two identical).
 */
export const CONTEXT_SNAPSHOT_BITS = Object.freeze({
    /** The host has a context; without it the whole result is 0. */
    valid: 1 << 0,
    floatColorBuffer: 1 << 1,
    floatBlend: 1 << 2,
    loseContext: 1 << 3,
    /** The attribute fields are set (bundles before they existed leave this 0). */
    attributesKnown: 1 << 4,
    halfFloatColorBuffer: 1 << 5,
    floatLinear: 1 << 6,
    textureFilterAnisotropic: 1 << 7,
    parallelShaderCompile: 1 << 10,
    /** The extension bits are the context's whole enabled set (bundles before the allow-list leave this 0). */
    extensionsKnown: 1 << 11,
    /** EXT_disjoint_timer_query_webgl2 is offered (not enabled: the perf HUD enables it to time). */
    timerQuery: 1 << 14,
    /** get_context_limit() answers on this bundle (bundles before it leave this 0). */
    limitsKnown: 1 << 15,
});

/**
 * get_context_limit()'s argument for each limit. Mirrors WasmContextLimit in
 * src/wasm/WasmWebGLContext.hpp (tests/web/projectm-context-config.test.mjs
 * keeps the two identical).
 */
export const CONTEXT_LIMITS = Object.freeze({
    maxTextureSize: 0,
    maxRenderbufferSize: 1,
    maxSamples: 2,
});

/**
 * The WebGL extensions the engine enables (its allow-list, in this order), and the
 * snapshot bit that says each one is on.
 * @type {ReadonlyArray<readonly [string, keyof typeof CONTEXT_SNAPSHOT_BITS]>}
 */
const SNAPSHOT_EXTENSIONS = Object.freeze([
    ['EXT_color_buffer_float', 'floatColorBuffer'],
    ['EXT_color_buffer_half_float', 'halfFloatColorBuffer'],
    ['OES_texture_float_linear', 'floatLinear'],
    ['EXT_float_blend', 'floatBlend'],
    ['EXT_texture_filter_anisotropic', 'textureFilterAnisotropic'],
    ['KHR_parallel_shader_compile', 'parallelShaderCompile'],
    ['WEBGL_lose_context', 'loseContext'],
]);
/** Where the active dual-FBO format (FboFloatFormat) sits in the result, and how wide it is. */
export const CONTEXT_SNAPSHOT_FORMAT_SHIFT = 8;
export const CONTEXT_SNAPSHOT_FORMAT_MASK = 0x3;
/** The context's real powerPreference, in the create_host_with_config() numbering. */
export const CONTEXT_SNAPSHOT_POWER_SHIFT = 12;
export const CONTEXT_SNAPSHOT_POWER_MASK = 0x3;
/** The context's real attributes, as {@link CONTEXT_CONFIG_FLAGS} bits. */
export const CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT = 16;
export const CONTEXT_SNAPSHOT_ATTRIBUTES_MASK = 0x1ff;

/** @type {Record<string, number>} */
const POWER_PREFERENCE = { 'default': 0, 'low-power': 1, 'high-performance': 2 };
/** @type {ReadonlyArray<'default' | 'low-power' | 'high-performance'>} */
const POWER_PREFERENCE_NAMES = ['default', 'low-power', 'high-performance'];

/**
 * Attribute flags (+ power preference) → named attributes, in the option names
 * a host passes them by.
 *
 * @param {number} flags {@link CONTEXT_CONFIG_FLAGS} bits.
 * @param {number} powerPreference create_host_with_config() numbering.
 * @returns {ProjectMContextAttributes}
 */
export function decodeContextAttributes(flags, powerPreference) {
    const f = CONTEXT_CONFIG_FLAGS;
    return Object.freeze({
        antialias: (flags & f.antialias) !== 0,
        preserveDrawingBuffer: (flags & f.preserveDrawingBuffer) !== 0,
        depth: (flags & f.depth) !== 0,
        stencil: (flags & f.stencil) !== 0,
        contextAlpha: (flags & f.contextAlpha) !== 0,
        premultipliedAlpha: (flags & f.premultipliedAlpha) !== 0,
        failIfMajorPerformanceCaveat: (flags & f.failIfMajorPerformanceCaveat) !== 0,
        explicitSwapControl: (flags & f.explicitSwapControl) !== 0,
        desynchronized: (flags & f.desynchronized) !== 0,
        powerPreference: POWER_PREFERENCE_NAMES[powerPreference] ?? 'high-performance',
    });
}

/**
 * Where the context differs from the config it was created for: "requested vs
 * effective", one entry per attribute, in {@link decodeContextAttributes}'s
 * order. Empty when they agree. A browser may legitimately not offer antialias
 * or desynchronized; anything else here means the canvas could not be given a
 * context of its own (a canvas keeps its first context, and the engine can only
 * swap in a fresh element on the main thread).
 *
 * Manual present (explicitSwapControl) renders through an offscreen back
 * buffer, for which Emscripten always creates the context with
 * preserveDrawingBuffer: that one is expected, not a mismatch.
 *
 * @param {WasmContextConfig} requested
 * @param {ProjectMContextAttributes} effective
 * @returns {ReadonlyArray<ProjectMContextAttributeMismatch>}
 */
export function contextAttributeMismatches(requested, effective) {
    const f = CONTEXT_CONFIG_FLAGS;
    const granted = (requested.flags & f.explicitSwapControl) !== 0
        ? requested.flags | f.preserveDrawingBuffer
        : requested.flags;
    const wanted = decodeContextAttributes(granted, requested.powerPreference);
    /** @type {ProjectMContextAttributeMismatch[]} */
    const mismatches = [];
    for (const attribute of /** @type {Array<keyof ProjectMContextAttributes>} */ (Object.keys(wanted))) {
        if (wanted[attribute] !== effective[attribute]) {
            mismatches.push(Object.freeze({ attribute, requested: wanted[attribute], effective: effective[attribute] }));
        }
    }
    return Object.freeze(mismatches);
}

/**
 * get_context_snapshot()'s packed int → what the host negotiated with WebGL, or
 * null when it says the host has no context (before init, or after teardown).
 * The result is frozen, so a host cannot edit what the engine reported.
 *
 * `extensions` lists the WebGL extensions the engine enabled, null on a bundle
 * from before the allow-list (which enabled every extension the browser offered).
 * `attributes` is what the context really has (getContextAttributes()), null on
 * a bundle that predates reporting it. Given the config the engine was created
 * with, `mismatches` lists where the two differ; without it, it is empty.
 *
 * @param {number} packed
 * @param {WasmContextConfig} [requested]
 * @returns {ProjectMContextSnapshot | null}
 */
export function decodeContextSnapshot(packed, requested) {
    const bits = Number(packed);
    const b = CONTEXT_SNAPSHOT_BITS;
    if (!Number.isInteger(bits) || (bits & b.valid) === 0) {
        return null;
    }
    const raw = (bits >> CONTEXT_SNAPSHOT_FORMAT_SHIFT) & CONTEXT_SNAPSHOT_FORMAT_MASK;
    // An index the table does not know degrades to RGBA8, like getFboFormatName().
    const fboFormat = /** @type {0 | 1 | 2} */ (raw < FORMAT_NAMES.length ? raw : 2);
    const attributes = (bits & b.attributesKnown) !== 0
        ? decodeContextAttributes(
            (bits >> CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT) & CONTEXT_SNAPSHOT_ATTRIBUTES_MASK,
            (bits >> CONTEXT_SNAPSHOT_POWER_SHIFT) & CONTEXT_SNAPSHOT_POWER_MASK)
        : null;
    return Object.freeze({
        floatColorBuffer: (bits & b.floatColorBuffer) !== 0,
        floatBlend: (bits & b.floatBlend) !== 0,
        loseContext: (bits & b.loseContext) !== 0,
        fboFormat,
        fboFormatName: FORMAT_NAMES[fboFormat],
        extensions: (bits & b.extensionsKnown) !== 0
            ? Object.freeze(SNAPSHOT_EXTENSIONS.filter(([, bit]) => (bits & b[bit]) !== 0).map(([name]) => name))
            : null,
        attributes,
        mismatches: attributes && requested ? contextAttributeMismatches(requested, attributes) : Object.freeze([]),
    });
}
/**
 * The limits a host reads with get_context_limit(), in {@link CONTEXT_LIMITS}
 * order, or null when the bundle cannot answer (no export, or a snapshot without
 * the limitsKnown bit).
 *
 * @param {number} packed get_context_snapshot()'s result.
 * @param {(which: number) => number} getLimit get_context_limit() for this host.
 * @returns {ProjectMContextLimits | null}
 */
export function readContextLimits(packed, getLimit) {
    const bits = Number(packed);
    if (!Number.isInteger(bits) || (bits & CONTEXT_SNAPSHOT_BITS.limitsKnown) === 0) {
        return null;
    }
    const value = (/** @type {number} */ which) => {
        const n = Number(getLimit(which));
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    };
    return Object.freeze({
        maxTextureSize: value(CONTEXT_LIMITS.maxTextureSize),
        maxRenderbufferSize: value(CONTEXT_LIMITS.maxRenderbufferSize),
        maxSamples: value(CONTEXT_LIMITS.maxSamples),
    });
}

/**
 * Everything the engine negotiated with WebGL, as one capability set: the
 * extensions it enabled (and the GPU timer the browser offers), whether it can
 * render to and filter float targets, its limits, and the attributes the
 * context really has. Null when the snapshot says the host has no context.
 *
 * This is what callers read instead of probing a context of their own: the
 * canvas sizing clamps to `maxRenderbufferSize`, the perf HUD's GPU timer only
 * runs where `timerQuery` is true. Fields a bundle cannot report are null
 * (`extensions` before the allow-list, the limits before get_context_limit()).
 *
 * @param {number} packed get_context_snapshot()'s result.
 * @param {ProjectMContextLimits | null} [limits] {@link readContextLimits}'s result.
 * @returns {ProjectMContextCaps | null}
 */
export function decodeContextCaps(packed, limits = null) {
    const snapshot = decodeContextSnapshot(packed);
    if (!snapshot) {
        return null;
    }
    const bits = Number(packed);
    const b = CONTEXT_SNAPSHOT_BITS;
    const has = (/** @type {number} */ bit) => (bits & bit) !== 0;
    return Object.freeze({
        extensions: snapshot.extensions,
        floatColorBuffer: snapshot.floatColorBuffer,
        halfFloatColorBuffer: has(b.halfFloatColorBuffer),
        floatLinear: has(b.floatLinear),
        floatBlend: snapshot.floatBlend,
        textureFilterAnisotropic: has(b.textureFilterAnisotropic),
        parallelShaderCompile: has(b.parallelShaderCompile),
        loseContext: snapshot.loseContext,
        // timerQuery arrived with the limits: without limitsKnown it is unknown, not false.
        timerQuery: has(b.limitsKnown) ? has(b.timerQuery) : null,
        maxTextureSize: limits ? limits.maxTextureSize || null : null,
        maxRenderbufferSize: limits ? limits.maxRenderbufferSize || null : null,
        maxSamples: limits ? limits.maxSamples : null,
        fboFormat: snapshot.fboFormat,
        fboFormatName: snapshot.fboFormatName,
        attributes: snapshot.attributes,
    });
}

/** The FboFloatFormat numbering, which dual_fbo_get_format() also reports. */
/** @type {Record<string, number>} */
const FBO_PRECISION = { 'half': 0, 'high': 1, 'byte': 2 };

/**
 * The context profiles (`contextProfile` option, `?profile=`): named attribute
 * sets for what a context is for. A profile only fills options the host left
 * undefined, so an explicit `antialias`, `powerPreference`, `desynchronized` or
 * `fboPrecision` always wins over it. `qualityTierCeiling` is the best tier the
 * adaptive governor may step up to (set_quality_tier_ceiling(); 0 = full
 * quality). `balanced` is the defaults a context without a profile gets. See
 * docs/EMSCRIPTEN.md "Context profiles".
 */
export const CONTEXT_PROFILES = Object.freeze({
    /** The discrete GPU, MSAA on the canvas, RGBA32F transitions, no governor cap. */
    quality: Object.freeze({
        powerPreference: 'high-performance',
        antialias: true,
        desynchronized: false,
        fboPrecision: 'high',
        qualityTierCeiling: 0,
    }),
    /** Today's defaults: the discrete GPU, no MSAA, RGBA16F transitions. */
    balanced: Object.freeze({
        powerPreference: 'high-performance',
        antialias: false,
        desynchronized: false,
        fboPrecision: 'half',
        qualityTierCeiling: 0,
    }),
    /**
     * Laptops on battery and embeds on someone else's page: the integrated GPU,
     * RGBA8 transitions (half the bandwidth of RGBA16F), and the governor held
     * at tier 1 or below (64x48 mesh, blur capped, 0.75x render scale).
     */
    battery: Object.freeze({
        powerPreference: 'low-power',
        antialias: false,
        desynchronized: false,
        fboPrecision: 'byte',
        qualityTierCeiling: 1,
    }),
    /**
     * Live performance: the `desynchronized` canvas hint (the browser may skip
     * the compositor's frame of latency where it supports it), no MSAA resolve.
     */
    'low-latency': Object.freeze({
        powerPreference: 'high-performance',
        antialias: false,
        desynchronized: true,
        fboPrecision: 'half',
        qualityTierCeiling: 0,
    }),
});

/** @typedef {keyof typeof CONTEXT_PROFILES} ContextProfileName */

/**
 * A profile name from a URL or an attribute, or null for anything else (an
 * unknown name is ignored, not an error: the context starts with the defaults).
 *
 * @param {unknown} name
 * @returns {ContextProfileName | null}
 */
export function parseContextProfile(name) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(CONTEXT_PROFILES, key) ? /** @type {ContextProfileName} */ (key) : null;
}

/**
 * The options with `contextProfile`'s values filled in where the host left an
 * option undefined. Without a (known) profile, the options as given.
 *
 * @template {Partial<ProjectMContextOptions>} T
 * @param {T} options
 * @returns {T}
 */
export function withContextProfile(options) {
    const name = parseContextProfile(options.contextProfile);
    if (!name) {
        return options;
    }
    const profile = CONTEXT_PROFILES[name];
    return {
        ...options,
        powerPreference: options.powerPreference ?? profile.powerPreference,
        antialias: options.antialias ?? profile.antialias,
        desynchronized: options.desynchronized ?? profile.desynchronized,
        fboPrecision: options.fboPrecision ?? profile.fboPrecision,
    };
}

/**
 * The governor ceiling the options ask for (set_quality_tier_ceiling()): the
 * profile's, or null when there is no profile (the engine default, no cap).
 *
 * @param {Partial<ProjectMContextOptions>} options
 * @returns {number | null}
 */
export function qualityTierCeilingFor(options) {
    const name = parseContextProfile(options.contextProfile);
    return name ? CONTEXT_PROFILES[name].qualityTierCeiling : null;
}

/**
 * Context options → create_host_with_config()'s arguments. Every attribute is
 * encoded explicitly, so the C++ defaults never decide anything for a JS host.
 * A `contextProfile` fills the attributes the options leave undefined
 * ({@link withContextProfile}).
 *
 * `presentMode: 'manual'` sets the explicitSwapControl bit, like
 * `explicitSwapControl: true`.
 *
 * `options.alpha` is deliberately not read: it is the canvas-CSS compositing
 * hint. The WebGL alpha bit is `contextAlpha`, which defaults to `transparent`:
 * only transparency mode needs an alpha channel, and an opaque canvas is one
 * the page compositor draws without blending.
 *
 * @param {Partial<ProjectMContextOptions>} [options]
 * @returns {WasmContextConfig}
 */
export function resolveWasmContextConfig(options = {}) {
    options = withContextProfile(options);
    const f = CONTEXT_CONFIG_FLAGS;
    const flags = (options.antialias ? f.antialias : 0)
        | (options.preserveDrawingBuffer ? f.preserveDrawingBuffer : 0)
        | (options.depth ? f.depth : 0)
        | (options.stencil ? f.stencil : 0)
        | ((options.contextAlpha ?? !!options.transparent) ? f.contextAlpha : 0)
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
 * @param {import('./generated/projectm-wasm-api.js').ProjectMModule} module
 * @param {{ primary: string, secondary: string, config: WasmContextConfig, create?: 'host' | 'init' }} request
 * @returns {{ handle: import('./generated/projectm-wasm-api.js').HostHandle, code: number }}
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
        return { handle: DEFAULT_HOST, code: -1 };
    }
    setContextConfig(module, ...legacyContextConfigArgs(config));
    if (create === 'host') {
        const handle = createHost(module, primary, secondary);
        return { handle, code: handle ? 0 : lastInitError(module) };
    }
    const code = primary ? initWithCanvases(module, primary, secondary) : wasmInit(module);
    return { handle: DEFAULT_HOST, code };
}

/**
 * @param {import('./generated/projectm-wasm-api.js').ProjectMModule} module
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
 * @returns {import('@projectm/types/render-worker').FlashLimitSettings | null}
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
