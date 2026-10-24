// projectm-perf-preset-switch.js
//
// `?presetSwitchBench=1`: times switching between the first three featured
// presets (fetch, compile, first frame) through the shader cache's
// measurePresetSwitchTimings(). Main thread only: it drives loads and polls
// readiness through the module on this thread.

import { measurePresetSwitchTimings } from './projectm-shader-cache.js';
import { fetchFeaturedManifest, loadPresetEntry } from './projectm-preset-library.js';

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * Runs the benchmark once; it reports through the console like the others.
 *
 * @param {ProjectMModule} module
 * @returns {Promise<void>} Settles when the run does; never rejects.
 */
export function runPresetSwitchBench(module) {
    return fetchFeaturedManifest()
        .then((manifest) => {
            const presets = (manifest.presets || []).slice(0, 3);
            if (!presets.length) {
                console.warn('[projectM] presetSwitchBench: no featured presets in manifest');
                return null;
            }
            return measurePresetSwitchTimings(module, presets, {
                loadEntry: (entry, opts) => loadPresetEntry(entry, opts),
            });
        })
        .then(() => {}, (err) => {
            console.warn('[projectM] presetSwitchBench failed:', err);
        });
}
