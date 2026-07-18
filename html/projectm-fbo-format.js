// projectm-fbo-format.js
//
// Surfaces the dual ping-pong FBO color format (selected once in
// DualPingPongFramebuffer::DetectFormat(), projectM_emscripten.cpp) to the
// host page. RGBA32F/RGBA16F are full-quality; RGBA8 is a "degraded mode"
// fallback used on GPUs/browsers without EXT_color_buffer_half_float, which
// can show 8-bit banding in recursive warp/feedback presets (mitigated, but
// not eliminated, by the ordered-dither + clamp in CompositingBlendShader).
//
// `dualFboGetFormat()` returns 0=RGBA32F, 1=RGBA16F, 2=RGBA8 and is only
// valid after `startRender()` (DetectFormat() runs during `init()`).

import { dualFboGetFormat } from './generated/projectm-wasm-api.js';

const BANNER_ID = 'pm-degraded-mode-banner';

const FORMAT_NAMES = ['RGBA32F', 'RGBA16F', 'RGBA8'];

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
 * Reads the dual-FBO color format and, if it's the degraded RGBA8 fallback,
 * shows a banner indicating reduced visual quality. Also exposes
 * `window.pmGetFboFormat()` returning one of 'RGBA32F' | 'RGBA16F' | 'RGBA8'.
 *
 * Must be called after `startRender()`.
 *
 * @param {*} Module The Emscripten module instance.
 * @returns {string} The detected format name.
 */
export function setupFboFormatIndicator(Module) {
    const formatIndex = dualFboGetFormat(Module);
    const formatName = FORMAT_NAMES[formatIndex] || 'RGBA8';

    window.pmGetFboFormat = () => formatName;

    if (formatIndex === 2) {
        ensureBanner().style.display = 'block';
    }

    return formatName;
}
