// projectm-fbo-format.js
//
// Surfaces the dual ping-pong FBO color format (selected once in
// DualPingPongFramebuffer::DetectFormat(), src/wasm/WasmGraphics.hpp) to the
// host page. RGBA16F whenever it is renderable; RGBA32F only when the host
// asks for it (?fboPrecision=high); RGBA8 otherwise, on GPUs/browsers without
// EXT_color_buffer_float or EXT_color_buffer_half_float, or when a float
// framebuffer turns out incomplete.
//
// The dual FBOs hold each preset's finished frame for the transition
// crossfade, and libprojectM renders that frame through 8-bit targets: the
// feedback banding of recursive presets happens before this stage whatever
// the format here. RGBA8 only means the crossfade itself rounds to 8 bits
// (ordered-dithered in CompositingBlendShader), hence the banner.
//
// `dualFboGetFormat()` returns 0=RGBA16F, 1=RGBA32F, 2=RGBA8 — the same
// numbering `set_context_config()` takes for its fboPrecision preference
// ('half' / 'high' / 'byte') — and is only valid after `startRender()`
// (DetectFormat() runs during `init()`).

import { dualFboGetFormat } from './generated/projectm-wasm-api.js';

const BANNER_ID = 'pm-degraded-mode-banner';

/**
 * Indexed by the `dual_fbo_get_format()` return value (FboFloatFormat in
 * src/wasm/WasmGraphics.hpp) — keep in order.
 * @typedef {'RGBA32F' | 'RGBA16F' | 'RGBA8'} FboFormatName
 * @type {readonly [FboFormatName, FboFormatName, FboFormatName]}
 */
export const FORMAT_NAMES = ['RGBA16F', 'RGBA32F', 'RGBA8'];

/**
 * Shows the degraded-mode banner, creating it if the page has none.
 *
 * @returns {() => void} Undoes this call: removes the banner when this call
 *   created it, and does nothing when it was already there (its creator owns it).
 */
function showBanner() {
    const existing = document.getElementById(BANNER_ID);
    if (existing) {
        existing.style.display = 'block';
        return () => {};
    }
    const el = createBanner();
    el.style.display = 'block';
    return () => el.remove?.();
}

function createBanner() {
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.textContent = 'Degraded rendering mode: this GPU/browser cannot render to half-float textures (RGBA8), so preset transitions blend at 8 bits.';
    el.style.position = 'fixed';
    el.style.top = '8px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '99998';
    el.style.padding = '6px 14px';
    el.style.background = '#7c2d12';
    el.style.color = '#fed7aa';
    el.style.fontFamily = '"Lucida Console", "Courier New", monospace';
    el.style.fontSize = '12px';
    el.style.borderRadius = '6px';
    el.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
    document.body.appendChild(el);

    return el;
}

/**
 * The dual-FBO color format the engine picked, by name. Unrecognised indices
 * degrade to 'RGBA8' rather than undefined. Only valid after `startRender()`.
 *
 * @param {import('./generated/projectm-wasm-api.ts').ProjectMModule} Module
 * @returns {FboFormatName}
 */
export function getFboFormatName(Module) {
    return FORMAT_NAMES[dualFboGetFormat(Module)] || 'RGBA8';
}

/**
 * Reads the dual-FBO color format and, if it's the degraded RGBA8 fallback,
 * shows a banner indicating reduced visual quality. Nothing is written to
 * `window`; pages that still call `window.pmGetFboFormat()` opt in through
 * `exposeFboFormatGlobals()` in projectm-legacy-globals.js.
 *
 * Must be called after `startRender()`.
 *
 * @param {import('./generated/projectm-wasm-api.ts').ProjectMModule} Module
 *   The Emscripten module instance.
 * @returns {{ format: () => FboFormatName, dispose: () => void }} The detected
 *   format, and the undo for the banner (removed if this call added it).
 */
export function setupFboFormatIndicator(Module) {
    const formatIndex = dualFboGetFormat(Module);
    const formatName = FORMAT_NAMES[formatIndex] || 'RGBA8';

    let hideBanner = () => {};
    if (formatIndex === 2) {
        hideBanner = showBanner();
    }

    return {
        format: () => formatName,
        dispose: () => {
            hideBanner();
            hideBanner = () => {};
        },
    };
}

/**
 * The same indicator for the render-worker topology, where the format lives in
 * the worker's module and reaches the page in the worker's periodic `stats`
 * messages (`fboFormat`, the same `dual_fbo_get_format()` index). The banner is
 * shown from the first stats that carry a format; until then, and on a bundle
 * that reports -1, the format is unknown.
 *
 * @param {Pick<import('./projectm-render-worker-types.ts').RenderWorkerHandle, 'getLastStats' | 'onStats'>} handle
 * @returns {{ format: () => FboFormatName | null, dispose: () => void }}
 */
export function setupWorkerFboFormatIndicator(handle) {
    /** @type {FboFormatName | null} */
    let formatName = null;

    /** @param {import('./projectm-render-worker-types.ts').RenderWorkerStatsMessage | null} stats */
    const apply = (stats) => {
        const formatIndex = stats ? stats.fboFormat : -1;
        if (formatName !== null || typeof formatIndex !== 'number' || formatIndex < 0) {
            return false;
        }
        formatName = FORMAT_NAMES[formatIndex] || 'RGBA8';
        if (formatIndex === 2) {
            hideBanner = showBanner();
        }
        return true;
    };
    let hideBanner = () => {};

    // The format is fixed at init(), so the first report settles it.
    let unsubscribe = () => {};
    if (!apply(handle.getLastStats())) {
        unsubscribe = handle.onStats((stats) => {
            if (apply(stats)) unsubscribe();
        });
    }

    return {
        format: () => formatName,
        dispose: () => {
            unsubscribe();
            hideBanner();
            hideBanner = () => {};
        },
    };
}
