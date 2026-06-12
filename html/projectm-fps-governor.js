// projectm-fps-governor.js
//
// Target FPS + adaptive quality governor controls for the projectM WASM
// build. See docs/PERFORMANCE.md.
//
// The libprojectM/WASM default target is 60 FPS (matching Winamp Milkdrop).
// The adaptive quality governor (implemented in projectM_emscripten.cpp,
// `UpdateQualityGovernor()`) watches the wall-clock render loop time and, if
// it consistently exceeds the 1/targetFps budget, steps the per-pixel mesh
// resolution down (48x36 -> 32x24, see projectm-mesh-quality.js) instead of
// letting the frame rate drop. If frame time recovers, it steps back up.
//
// Settings are persisted in localStorage:
// - 'targetFps': desired target FPS (default 60).
// - 'qualityGovernor': '1'/'0' to enable/disable the governor (default
//   enabled).
//
// Both can also be set for one page load via `?targetFps=` / `?governor=0|1`
// query parameters.

const DEFAULT_TARGET_FPS = 60;

function resolveTargetFps(value) {
    const fps = parseInt(value, 10);
    return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_TARGET_FPS;
}

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
 * Sets the target FPS by calling `Module._set_target_fps(fps)`.
 * @param {*} Module The Emscripten module instance.
 * @param {number|string} fps The desired target FPS (default 60 if invalid).
 * @returns {number} The FPS value actually applied.
 */
export function setTargetFps(Module, fps) {
    const resolved = resolveTargetFps(fps);
    Module._set_target_fps(resolved);
    return resolved;
}

/**
 * Enables or disables the adaptive quality governor via
 * `Module._set_quality_governor(enabled)`.
 * @param {*} Module The Emscripten module instance.
 * @param {boolean} enabled Whether the governor should be active.
 * @returns {boolean} The value actually applied.
 */
export function setQualityGovernorEnabled(Module, enabled) {
    Module._set_quality_governor(enabled ? 1 : 0);
    return !!enabled;
}

/**
 * Returns the governor's current quality tier (0 = high/48x36, 1 = low/32x24).
 * @param {*} Module The Emscripten module instance.
 * @returns {number} The current quality tier.
 */
export function getQualityTier(Module) {
    return Module._get_quality_tier();
}

/**
 * Applies the target FPS and governor-enabled settings from `?targetFps=` /
 * `?governor=`, falling back to localStorage, and exposes
 * `window.pmSetTargetFps(fps)` / `window.pmSetQualityGovernorEnabled(enabled)`
 * for host UIs to change and persist them.
 *
 * @param {*} Module The Emscripten module instance (must already be initialized).
 * @returns {{ targetFps: number, governorEnabled: boolean }} The settings applied.
 */
export function setupFpsGovernor(Module) {
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
        localStorage.setItem('targetFps', fps);
        return setTargetFps(Module, fps);
    };

    window.pmSetQualityGovernorEnabled = (enabled) => {
        localStorage.setItem('qualityGovernor', enabled ? '1' : '0');
        return setQualityGovernorEnabled(Module, enabled);
    };

    window.pmGetQualityTier = () => getQualityTier(Module);

    return { targetFps, governorEnabled };
}
