// projectm-perf-crossfade.js
//
// The crossfade benchmark's driver (`?benchmark=1&crossfade=1`): keeps a
// soft-cut transition running for the whole sampling window, so the frames
// projectm-perf.js collects all exercise the dual-FBO transition path. A
// steady-state run never composites the Preset B surfaces and shows no
// difference there. Main thread only: it polls transition_is_active() every
// step, which needs the module on this thread.

import { loadPresetFile, transitionIsActive } from './generated/projectm-wasm-api.js';
import { fetchFeaturedManifest, loadPresetEntry } from './projectm-preset-library.js';
import { startTransitionWhenReady } from './projectm-transitions.js';

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-preset-types.ts').PresetEntry} PresetEntry
 */

/**
 * Whether a blend is in progress. In crossfade mode only frames rendered then
 * are representative.
 *
 * @param {ProjectMModule | null} module
 * @returns {boolean}
 */
export function crossfadeActive(module) {
    try {
        return !!module && transitionIsActive(module);
    } catch {
        return false;
    }
}

/**
 * Presets to cycle through: an explicit `?crossfadePresets=a.milk,b.milk`
 * list, else the `?preset=` file, else the first two featured-pack presets.
 *
 * @param {URLSearchParams} params
 * @returns {Promise<(string | PresetEntry)[]>}
 */
export async function resolveCrossfadePresets(params) {
    const explicit = (params.get('crossfadePresets') || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    if (explicit.length) {
        return explicit;
    }
    const presetPath = params.get('preset');
    if (presetPath) {
        return [presetPath];
    }
    try {
        const manifest = await fetchFeaturedManifest();
        return (manifest.presets || []).slice(0, 2);
    } catch (err) {
        console.warn('[projectM benchmark] crossfade mode: featured manifest unavailable:', err);
        return [];
    }
}

/**
 * Keeps a soft-cut transition running until `stopped()` says the benchmark has
 * what it needs. Each time the blend finishes, the next preset is loaded to
 * start a new one.
 *
 * @param {ProjectMModule} module
 * @param {object} options
 * @param {URLSearchParams} options.params The page's query.
 * @param {number} options.durationSec Each transition's length.
 * @param {() => boolean} options.stopped
 */
export async function pumpCrossfade(module, { params, durationSec, stopped }) {
    const playlist = await resolveCrossfadePresets(params);
    if (!playlist.length) {
        console.warn('[projectM benchmark] crossfade mode: no presets available to transition between');
        return;
    }

    let index = 0;
    while (!stopped()) {
        if (!crossfadeActive(module)) {
            const entry = playlist[index % playlist.length];
            index += 1;
            try {
                if (typeof entry === 'string') {
                    loadPresetFile(module, entry);
                } else {
                    await loadPresetEntry(entry, {});
                }
                await startTransitionWhenReady({ module, durationSec });
            } catch (err) {
                console.warn('[projectM benchmark] crossfade step failed:', err);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
