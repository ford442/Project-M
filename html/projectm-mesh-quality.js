// projectm-mesh-quality.js
//
// Per-pixel mesh resolution ("quality") setting for the projectM WASM build.
// See docs/PERFORMANCE.md.
//
// The libprojectM default is 80x60 (high tier). The per-vertex evaluation
// loop is parallelized across CPU cores via OpenMP (PRJM_ENABLE_OPENMP). On
// devices with few logical cores, fall back to the 64x48 regular tier to
// avoid dropping frames on heavy per-pixel-code presets.
//
// The chosen quality is persisted in localStorage under 'meshQuality':
// 'high' (80x60), 'low' (64x48 regular tier), or unset/'auto' (derived from
// navigator.hardwareConcurrency). It can also be set for one page load via
// the `?meshQuality=high|low|auto` query parameter.

import { setMesh as wasmSetMesh } from './generated/projectm-wasm-api.js';

const MESH_SIZES = {
    low: [64, 48],
    high: [80, 60],
};

// Below this number of logical CPU cores, 'auto' resolves to 'low' (64x48).
// Devices with fewer cores start on the regular tier and only step up to
// 80x60 when the adaptive governor sees sustained headroom.
const AUTO_LOW_THRESHOLD_CORES = 8;

/**
 * @param {string} quality
 * @returns {'low' | 'high'}
 */
function resolveQuality(quality) {
    if (quality === 'low' || quality === 'high') {
        return quality;
    }
    const cores = navigator.hardwareConcurrency || 1;
    return cores < AUTO_LOW_THRESHOLD_CORES ? 'low' : 'high';
}

/**
 * Applies a mesh quality setting via the typed WASM API.
 * @param {*} Module The Emscripten module instance.
 * @param {string} quality 'high', 'low', or 'auto'.
 * @returns {string} The resolved quality ('high' or 'low').
 */
export function setMeshQuality(Module, quality) {
    const resolved = resolveQuality(quality);
    const [width, height] = MESH_SIZES[resolved];
    wasmSetMesh(Module, width, height);
    return resolved;
}

/**
 * `localStorage` throws on *access* in a sandboxed iframe (opaque origin) and in
 * some private modes, so both directions are guarded; a page that cannot persist
 * the choice still gets it for the current load.
 *
 * @param {string} key
 * @returns {string | null}
 */
function readStoredQuality(key) {
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
function writeStoredQuality(key, value) {
    try {
        globalThis.localStorage.setItem(key, value);
    } catch {
        // Persisting is best-effort.
    }
}

/**
 * Applies the mesh quality from `?meshQuality=`, localStorage, or
 * navigator.hardwareConcurrency (in that order of precedence) and returns the
 * control a host UI uses to change and persist it. Nothing is written to
 * `window`; pages that still call `window.pmSetMeshQuality(...)` opt in through
 * `exposeMeshQualityGlobals()` in projectm-legacy-globals.js.
 *
 * @param {*} Module The Emscripten module instance (must already be initialized).
 * @param {{ params?: URLSearchParams }} [options]
 * @returns {{ quality: string, setQuality: (quality: string) => string }} The quality
 *   that was actually applied, and a setter that persists and applies a new one.
 */
export function setupMeshQuality(Module, options = {}) {
    const params = options.params || new URLSearchParams(location.search);
    const requested = params.get('meshQuality') || readStoredQuality('meshQuality') || 'auto';
    const resolved = setMeshQuality(Module, requested);

    return {
        quality: resolved,
        setQuality: (quality) => {
            writeStoredQuality('meshQuality', quality);
            return setMeshQuality(Module, quality);
        },
    };
}
