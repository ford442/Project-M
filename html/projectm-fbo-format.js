// projectm-fbo-format.js
//
// Surfaces the dual ping-pong FBO color format (selected once in
// DualPingPongFramebuffer::DetectFormat(), projectM_emscripten.cpp) to the
// host page. RGBA16F whenever it is renderable; RGBA32F only when the host
// asks for it (?fboPrecision=high); RGBA8 otherwise. RGBA32F/RGBA16F are
// full-quality; RGBA8 is a "degraded mode" fallback used on GPUs/browsers
// without EXT_color_buffer_float or EXT_color_buffer_half_float, which
// can show 8-bit banding in recursive warp/feedback presets (mitigated, but
// not eliminated, by the ordered-dither + clamp in CompositingBlendShader).
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

function ensureBanner() {
    let el = document.getElementById(BANNER_ID);
    if (el) {
        return el;
    }

    el = document.createElement('div');
    el.id = BANNER_ID;
    el.textContent = 'Degraded rendering mode: this GPU/browser lacks half-float FBO support (RGBA8). Recursive warp/feedback effects may show banding.';
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
 * @returns {FboFormatName} The detected format name.
 */
export function setupFboFormatIndicator(Module) {
    const formatIndex = dualFboGetFormat(Module);
    const formatName = FORMAT_NAMES[formatIndex] || 'RGBA8';

    if (formatIndex === 2) {
        ensureBanner().style.display = 'block';
    }

    return formatName;
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
            ensureBanner().style.display = 'block';
        }
        return true;
    };

    // The format is fixed at init(), so the first report settles it.
    let unsubscribe = () => {};
    if (!apply(handle.getLastStats())) {
        unsubscribe = handle.onStats((stats) => {
            if (apply(stats)) unsubscribe();
        });
    }

    return {
        format: () => formatName,
        dispose: () => unsubscribe(),
    };
}
