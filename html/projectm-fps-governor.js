// projectm-fps-governor.js
//
// Target FPS + adaptive quality governor controls for the projectM WASM
// build. See docs/PERFORMANCE.md.
//
// The libprojectM/WASM default target is 60 FPS (matching Winamp Milkdrop).
// The adaptive quality governor (implemented in WasmPerfGovernor.cpp,
// `UpdateQualityGovernor()`) watches the wall-clock render loop time and, if
// it consistently exceeds the 1/targetFps budget, steps three tiers together
// (v2, see docs/PERFORMANCE.md "Governor v2"):
// - Per-pixel mesh resolution (80x60 -> 64x48 -> 48x36, projectm-mesh-quality.js)
// - Blur level cap (uncapped -> Blur2 -> Blur1, see BlurTexture.cpp)
// - Internal render scale (1.0 -> 0.75 -> 0.5, applied by this module's
//   `onRenderScaleChange` hook by shrinking the canvas backing store while
//   leaving its CSS display size unchanged)
// If frame time recovers, it steps back up.
//
// Settings are persisted in localStorage:
// - 'targetFps': desired target FPS (default 60).
// - 'qualityGovernor': '1'/'0' to enable/disable the governor (default
//   enabled).
//
// Both can also be set for one page load via `?targetFps=` / `?governor=0|1`
// query parameters.

import {
    getGovernorBlurCap as wasmGetGovernorBlurCap,
    getGovernorRenderScale as wasmGetGovernorRenderScale,
    getQualityTier as wasmGetQualityTier,
    setQualityGovernor as wasmSetQualityGovernor,
    setTargetFps as wasmSetTargetFps,
} from './generated/projectm-wasm-api.js';

const DEFAULT_TARGET_FPS = 60;

/**
 * @param {string | number | null | undefined} value
 * @returns {number}
 */
function resolveTargetFps(value) {
    const fps = parseInt(String(value), 10);
    return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_TARGET_FPS;
}

/**
 * @param {string | null | undefined} value
 * @returns {boolean}
 */
function resolveGovernorEnabled(value) {
    if (value === '0' || value === 'false') {
        return false;
    }
    if (value === '1' || value === 'true') {
        return true;
    }
    return true;
}

/**
 * Sets the target FPS via the typed WASM API.
 * @param {*} Module The Emscripten module instance.
 * @param {number|string} fps The desired target FPS (default 60 if invalid).
 * @returns {number} The FPS value actually applied.
 */
export function setTargetFps(Module, fps) {
    const resolved = resolveTargetFps(fps);
    wasmSetTargetFps(Module, resolved);
    return resolved;
}

/**
 * Enables or disables the adaptive quality governor.
 * @param {*} Module The Emscripten module instance.
 * @param {boolean} enabled Whether the governor should be active.
 * @returns {boolean} The value actually applied.
 */
export function setQualityGovernorEnabled(Module, enabled) {
    wasmSetQualityGovernor(Module, enabled);
    return !!enabled;
}

/**
 * Returns the governor's current quality tier (0 = high/80x60, 1 = regular/64x48,
 * 2 = low/48x36).
 * @param {*} Module The Emscripten module instance.
 * @returns {number} The current quality tier.
 */
export function getQualityTier(Module) {
    return wasmGetQualityTier(Module);
}

/**
 * Returns the current tier's internal render scale (1.0/0.75/0.5).
 * @param {*} Module The Emscripten module instance.
 * @returns {number} The current render scale.
 */
export function getGovernorRenderScale(Module) {
    return wasmGetGovernorRenderScale(Module);
}

/**
 * Returns the current tier's blur-level cap (-1 = uncapped, else 0-3).
 * @param {*} Module The Emscripten module instance.
 * @returns {number} The current blur-level cap.
 */
export function getGovernorBlurCap(Module) {
    return wasmGetGovernorBlurCap(Module);
}

/**
 * Applies the target FPS and governor-enabled settings from `?targetFps=` /
 * `?governor=`, falling back to localStorage, and exposes
 * `window.pmSetTargetFps(fps)` / `window.pmSetQualityGovernorEnabled(enabled)`
 * for host UIs to change and persist them.
 *
 * Also wires `window.pmOnGovernorRenderScaleChange` / `window.pmOnGovernorBlurCapChange`
 * — the push notifications WasmPerfGovernor.cpp fires on every tier change — and
 * exposes `window.pmGetGovernorRenderScale()` / `window.pmGetGovernorBlurCap()` for
 * polling. If `onRenderScaleChange` is provided, it's called with the new scale
 * (1.0/0.75/0.5) whenever the governor steps tiers, so the host can resize the
 * canvas backing store (see syncModuleSize() in projectm-core.html / syncCanvasSize()
 * in projectm-context.js) — this is what actually applies the "internal FBO render
 * scale" tier; nothing here touches the canvas directly.
 *
 * @param {*} Module The Emscripten module instance (must already be initialized).
 * @param {{ onRenderScaleChange?: (scale: number) => void }} [options]
 * @returns {{ targetFps: number, governorEnabled: boolean }} The settings applied.
 */
export function setupFpsGovernor(Module, options = {}) {
    const { onRenderScaleChange } = options;
    const params = new URLSearchParams(location.search);

    const targetFps = setTargetFps(
        Module,
        params.get('targetFps') || localStorage.getItem('targetFps') || DEFAULT_TARGET_FPS
    );

    const governorEnabled = setQualityGovernorEnabled(
        Module,
        resolveGovernorEnabled(params.get('governor') || localStorage.getItem('qualityGovernor'))
    );

    window.pmSetTargetFps = (fps) => {
        localStorage.setItem('targetFps', String(fps));
        return setTargetFps(Module, fps);
    };

    window.pmSetQualityGovernorEnabled = (enabled) => {
        localStorage.setItem('qualityGovernor', enabled ? '1' : '0');
        return setQualityGovernorEnabled(Module, enabled);
    };

    window.pmGetQualityTier = () => getQualityTier(Module);

    let currentRenderScale = getGovernorRenderScale(Module);
    let currentBlurCap = getGovernorBlurCap(Module);

    window.pmOnGovernorRenderScaleChange = (scale) => {
        currentRenderScale = scale;
        if (typeof onRenderScaleChange === 'function') {
            onRenderScaleChange(scale);
        }
    };
    window.pmOnGovernorBlurCapChange = (cap) => {
        currentBlurCap = cap;
    };
    window.pmGetGovernorRenderScale = () => currentRenderScale;
    window.pmGetGovernorBlurCap = () => currentBlurCap;

    return { targetFps, governorEnabled };
}
