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
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';

const DEFAULT_TARGET_FPS = 60;

/**
 * `localStorage` throws on *access* in a sandboxed iframe (opaque origin) and in
 * some private modes, not just on getItem/setItem, so every touch goes through
 * these two. A page that cannot persist a preference still gets the preference
 * for the current load.
 *
 * @param {string} key
 * @returns {string | null}
 */
function readStoredSetting(key) {
    try {
        return globalThis.localStorage.getItem(key);
    } catch {
        return null;
    }
}

/**
 * @param {string} key
 * @param {string} value
 */
function writeStoredSetting(key, value) {
    try {
        globalThis.localStorage.setItem(key, value);
    } catch {
        // Persisting is best-effort.
    }
}

/**
 * One governor controller per Module: running setup again for the same module
 * (a retried init, a re-created panel) replaces the earlier subscriptions
 * instead of stacking a second set on the callback bus.
 *
 * @type {WeakMap<object, () => void>}
 */
const activeGovernors = new WeakMap();

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
 * @typedef {object} FpsGovernorApi
 * @property {number} targetFps The target FPS applied at setup.
 * @property {boolean} governorEnabled Whether the governor was enabled at setup.
 * @property {(fps: number | string) => number} setTargetFps Persists and applies a target FPS.
 * @property {(enabled: boolean) => boolean} setQualityGovernorEnabled Persists and applies the governor switch.
 * @property {() => number} getQualityTier
 * @property {() => number} getRenderScale The last render scale the governor pushed (or read at setup).
 * @property {() => number} getBlurCap The last blur-level cap the governor pushed (or read at setup).
 * @property {() => void} dispose Stops listening to the governor's tier notifications.
 */

/**
 * Applies the target FPS and governor-enabled settings from `?targetFps=` /
 * `?governor=`, falling back to localStorage, and returns the controls a host UI
 * needs to change and persist them.
 *
 * It also listens to the push notifications WasmPerfGovernor.cpp fires on every
 * tier change (through the WASM callback bus, so several contexts can listen at
 * once). If `onRenderScaleChange` is provided, it's called with the new scale
 * (1.0/0.75/0.5) whenever the governor steps tiers, so the host can resize the
 * canvas backing store (see syncModuleSize() in projectm-core.html / syncCanvasSize()
 * in projectm-context.js) — this is what actually applies the "internal FBO render
 * scale" tier; nothing here touches the canvas directly.
 *
 * This module writes nothing to `window`. Pages whose inline handlers still call
 * `window.pmSetTargetFps(...)` and friends opt in through
 * `exposeGovernorGlobals()` in projectm-legacy-globals.js.
 *
 * @param {*} Module The Emscripten module instance (must already be initialized).
 * @param {{ onRenderScaleChange?: (scale: number) => void, params?: URLSearchParams }} [options]
 * @returns {FpsGovernorApi}
 */
export function setupFpsGovernor(Module, options = {}) {
    const { onRenderScaleChange } = options;
    const params = options.params || new URLSearchParams(location.search);

    activeGovernors.get(Module)?.();

    const targetFps = setTargetFps(
        Module,
        params.get('targetFps') || readStoredSetting('targetFps') || DEFAULT_TARGET_FPS
    );

    const governorEnabled = setQualityGovernorEnabled(
        Module,
        resolveGovernorEnabled(params.get('governor') || readStoredSetting('qualityGovernor'))
    );

    let currentRenderScale = getGovernorRenderScale(Module);
    let currentBlurCap = getGovernorBlurCap(Module);

    const unsubscribers = [
        subscribeWasmCallback('pmOnGovernorRenderScaleChange', (/** @type {number} */ scale) => {
            currentRenderScale = scale;
            if (typeof onRenderScaleChange === 'function') {
                onRenderScaleChange(scale);
            }
        }),
        subscribeWasmCallback('pmOnGovernorBlurCapChange', (/** @type {number} */ cap) => {
            currentBlurCap = cap;
        }),
    ];

    const dispose = () => {
        for (const unsubscribe of unsubscribers) {
            unsubscribe();
        }
        if (activeGovernors.get(Module) === dispose) {
            activeGovernors.delete(Module);
        }
    };
    activeGovernors.set(Module, dispose);

    return {
        targetFps,
        governorEnabled,
        setTargetFps: (fps) => {
            writeStoredSetting('targetFps', String(fps));
            return setTargetFps(Module, fps);
        },
        setQualityGovernorEnabled: (enabled) => {
            writeStoredSetting('qualityGovernor', enabled ? '1' : '0');
            return setQualityGovernorEnabled(Module, enabled);
        },
        getQualityTier: () => getQualityTier(Module),
        getRenderScale: () => currentRenderScale,
        getBlurCap: () => currentBlurCap,
        dispose,
    };
}
