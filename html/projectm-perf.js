// projectm-perf.js
//
// Optional frame-time profiling HUD and headless benchmark harness for the
// projectM WASM build. See docs/PERFORMANCE.md.

import {
    getOmpEnabled,
    getOmpMaxThreads,
    getOmpThreadCountInParallel,
    getOmpBlocktime,
    loadPresetFile,
    setPerfHud,
    transitionIsActive,
} from './generated/projectm-wasm-api.js';
import { measurePresetSwitchTimings } from './projectm-shader-cache.js';
import { fetchFeaturedManifest, loadPresetEntry } from './projectm-preset-library.js';
import { startTransitionWhenReady } from './projectm-transitions.js';

// - HUD: toggled via setPerfHud(module, 1/0). Shows FPS, total frame time, and bars.
// - Benchmark mode: append `?benchmark=1&frames=1000&preset=/presets/foo.milk` to
//   the page URL. Once `frames` samples have been collected, prints a JSON
//   summary (mean/median/p95) to the console and posts it via
//   `window.postMessage({ type: 'pm-benchmark-result', result }, '*')`.
// - Crossfade benchmark mode: add `&crossfade=1` to `?benchmark=1` to keep a
//   soft-cut transition running for the whole sampling window and only count
//   frames where `transition_is_active()` is true. This is the mode to use when
//   measuring anything on the dual-FBO transition path (e.g. the RGBA16F vs.
//   RGBA32F color-format comparison) — a steady-state run never composites the
//   Preset B surfaces at all and will show no difference.

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * Per-frame stats pushed from `js_perf_report_frame()` (WasmPerfGovernor.cpp).
 * Keep the keys in sync with that EM_JS block.
 *
 * @typedef {object} PerfFrameStats
 * @property {number} totalMs
 * @property {number} audioMs
 * @property {number} perFrameEvalMs
 * @property {number} perPixelEvalMs
 * @property {number} blurMs
 * @property {number} waveformsShapesMs
 * @property {number} compositeMs
 * @property {number} gpuMs Negative when EXT_disjoint_timer_query is unavailable.
 * @property {number} fps
 */

/** The {@link PerfFrameStats} keys the HUD renders as bars. */
/** @typedef {'audioMs' | 'perFrameEvalMs' | 'perPixelEvalMs' | 'blurMs' | 'waveformsShapesMs' | 'compositeMs' | 'gpuMs'} PerfBarKey */

/**
 * @typedef {object} PerfSummary
 * @property {number} mean
 * @property {number} median
 * @property {number} p95
 * @property {number} min
 * @property {number} max
 */

const STYLE_ID = 'pm-perf-hud-style';
const HUD_ID = 'pm-perf-hud';

/** @type {ReadonlyArray<{ key: PerfBarKey, label: string, color: string }>} */
const BARS = [
    { key: 'audioMs', label: 'Audio FFT/Loudness', color: '#60a5fa' },
    { key: 'perFrameEvalMs', label: 'Per-frame eval', color: '#34d399' },
    { key: 'perPixelEvalMs', label: 'Per-pixel/warp', color: '#fbbf24' },
    { key: 'blurMs', label: 'Blur', color: '#a78bfa' },
    { key: 'waveformsShapesMs', label: 'Waveforms/shapes', color: '#f472b6' },
    { key: 'compositeMs', label: 'Composite', color: '#22d3ee' },
    { key: 'gpuMs', label: 'GPU (TIME_ELAPSED)', color: '#f87171' },
];

const STYLE_CSS = `
#${HUD_ID} {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 99998;
  display: none;
  min-width: 220px;
  padding: 10px 12px;
  background: linear-gradient(160deg, #1b2436, #0d1117);
  border: 1px solid #2a3f5f;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-family: "Lucida Console", "Courier New", monospace;
  font-size: 11px;
  line-height: 1.4;
  color: #e2e8f0;
  pointer-events: none;
}
#${HUD_ID}.visible {
  display: block;
}
#${HUD_ID} .pm-perf-hud-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: bold;
  color: #cbd5e1;
}
#${HUD_ID} .pm-perf-hud-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}
#${HUD_ID} .pm-perf-hud-label {
  flex: 0 0 110px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${HUD_ID} .pm-perf-hud-bar-track {
  flex: 1 1 auto;
  height: 8px;
  background: #1e293b;
  border-radius: 4px;
  overflow: hidden;
}
#${HUD_ID} .pm-perf-hud-bar-fill {
  height: 100%;
  width: 0%;
  border-radius: 4px;
  transition: width 0.1s linear;
}
#${HUD_ID} .pm-perf-hud-value {
  flex: 0 0 52px;
  text-align: right;
  color: #e2e8f0;
}
`;

/** @type {HTMLDivElement | null} */
let hudEl = null;
let hudVisible = false;
let lastDomUpdate = 0;
const DOM_UPDATE_INTERVAL_MS = 200;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
}

function ensureHud() {
    if (hudEl) {
        return hudEl;
    }

    injectStyles();

    hudEl = /** @type {HTMLDivElement | null} */ (document.getElementById(HUD_ID));
    if (hudEl) {
        return hudEl;
    }

    hudEl = document.createElement('div');
    hudEl.id = HUD_ID;

    const rows = BARS.map((bar) => `
        <div class="pm-perf-hud-row" data-key="${bar.key}">
            <span class="pm-perf-hud-label">${bar.label}</span>
            <span class="pm-perf-hud-bar-track"><span class="pm-perf-hud-bar-fill" style="background:${bar.color}"></span></span>
            <span class="pm-perf-hud-value">0.0ms</span>
        </div>
    `).join('');

    hudEl.innerHTML = `
        <h3 class="pm-perf-hud-title">Perf: <span data-key="fps">0</span> fps / <span data-key="totalMs">0.0</span>ms</h3>
        ${rows}
    `;
    document.body.appendChild(hudEl);

    return hudEl;
}

/**
 * Shows or hides the on-screen perf HUD. Wired up as `window.pmSetPerfHudEnabled`
 * and called from C++ via js_perf_hud_set_enabled() when set_perf_hud() is toggled.
 * @param {boolean} enabled
 */
export function setHudVisible(enabled) {
    hudVisible = !!enabled;
    if (hudVisible) {
        ensureHud().classList.add('visible');
    } else if (hudEl) {
        hudEl.classList.remove('visible');
    }
}

/** @param {PerfFrameStats} stats */
function updateHud(stats) {
    if (!hudVisible) {
        return;
    }
    const now = performance.now();
    if (now - lastDomUpdate < DOM_UPDATE_INTERVAL_MS) {
        return;
    }
    lastDomUpdate = now;

    const el = ensureHud();
    const fpsEl = el.querySelector('[data-key="fps"]');
    const totalEl = el.querySelector('[data-key="totalMs"]');
    if (fpsEl) fpsEl.textContent = stats.fps.toFixed(0);
    if (totalEl) totalEl.textContent = stats.totalMs.toFixed(2);

    BARS.forEach((bar) => {
        const row = el.querySelector(`.pm-perf-hud-row[data-key="${bar.key}"]`);
        if (!row) {
            return;
        }
        const value = stats[bar.key];
        const valid = typeof value === 'number' && value >= 0;
        const ms = valid ? value : 0;
        const pct = stats.totalMs > 0 ? Math.min(100, (ms / stats.totalMs) * 100) : 0;
        const fill = /** @type {HTMLElement | null} */ (row.querySelector('.pm-perf-hud-bar-fill'));
        const valueEl = row.querySelector('.pm-perf-hud-value');
        if (fill) fill.style.width = pct + '%';
        if (valueEl) valueEl.textContent = valid ? ms.toFixed(2) + 'ms' : 'n/a';
    });
}

/**
 * @param {number[]} sortedValues Ascending.
 * @param {number} p Fraction in [0, 1].
 * @returns {number}
 */
function percentile(sortedValues, p) {
    if (sortedValues.length === 0) {
        return 0;
    }
    const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
    return sortedValues[idx];
}

/**
 * @param {ProjectMModule | null | undefined} Module
 * `blocktimeMs` is the libomp spin-wait window: 0 means helper threads sleep
 * as soon as a parallel region ends, 200 (libomp's default) means they spin
 * through every frame gap and starve the page's AudioWorklet. -1 means the
 * bundle has no libomp, and older bundles without the export report null.
 *
 * @param {ProjectMModule | null | undefined} Module
 * @returns {{ compiled: boolean, maxThreads: number, parallelThreadsObserved: number, blocktimeMs: number | null }}
 */
function collectOpenmpInfo(Module) {
    if (!Module || typeof Module._get_omp_enabled !== 'function') {
        return { compiled: false, maxThreads: 1, parallelThreadsObserved: 1, blocktimeMs: null };
    }
    return {
        compiled: getOmpEnabled(Module) !== 0,
        maxThreads: getOmpMaxThreads(Module),
        parallelThreadsObserved: typeof Module._get_omp_thread_count_in_parallel === 'function'
            ? getOmpThreadCountInParallel(Module)
            : 1,
        blocktimeMs: typeof Module._get_omp_blocktime === 'function'
            ? getOmpBlocktime(Module)
            : null,
    };
}

/**
 * @param {number[]} values
 * @returns {PerfSummary}
 */
function summarize(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        mean: sorted.length ? sum / sorted.length : 0,
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        min: sorted.length ? sorted[0] : 0,
        max: sorted.length ? sorted[sorted.length - 1] : 0,
    };
}

/**
 * Sets up the perf HUD hooks and, if `?benchmark=1` is present in the page URL,
 * runs a headless benchmark for `?frames=N` frames (default 500) on an optional
 * `?preset=<path>` and reports JSON results.
 *
 * @param {ProjectMModule} Module The Emscripten module instance (must already be initialized).
 * @returns {{ benchmarkRequested: boolean, crossfadeBench: boolean, presetSwitchBench: boolean }}
 */
export function setupPerfTools(Module) {
    const params = new URLSearchParams(location.search);
    const benchmarkRequested = params.get('benchmark') === '1';
    const showHud = params.get('perfhud') === '1' || benchmarkRequested;
    const frameTarget = Math.max(1, parseInt(params.get('frames') ?? '', 10) || 500);
    const presetPath = params.get('preset');
    const crossfadeBench = benchmarkRequested && params.get('crossfade') === '1';
    const crossfadeSec = Math.max(0.5, parseFloat(params.get('crossfadeSec') ?? '') || 20);

    /**
     * @type {{
     *   totalMs: number[],
     *   fps: number[],
     *   breakdown: Record<PerfBarKey, number[]>,
     * } | null}
     */
    let samples = null;
    let benchmarkDone = false;

    // In crossfade mode only frames rendered while a blend is actually in
    // progress are representative — everything else is a steady-state frame
    // that never touches the Preset B FBOs.
    function crossfadeActive() {
        try {
            return transitionIsActive(Module);
        } catch {
            return false;
        }
    }

    window.pmSetPerfHudEnabled = setHudVisible;
    window.pmOnPerfFrame = (stats) => {
        updateHud(stats);

        if (samples && !benchmarkDone && (!crossfadeBench || crossfadeActive())) {
            // Bound locally so the narrowing survives into the closure below.
            const collected = samples;
            collected.totalMs.push(stats.totalMs);
            collected.fps.push(stats.fps);
            BARS.forEach((bar) => {
                const value = stats[bar.key];
                if (typeof value === 'number' && value >= 0) {
                    collected.breakdown[bar.key].push(value);
                }
            });

            if (collected.totalMs.length >= frameTarget) {
                benchmarkDone = true;
                finishBenchmark(collected);
            }
        }
    };

    /** @param {NonNullable<typeof samples>} samples */
    function finishBenchmark(samples) {
        /** @type {Record<PerfBarKey, PerfSummary>} */
        const breakdownMs = /** @type {any} */ ({});
        BARS.forEach((bar) => {
            breakdownMs[bar.key] = summarize(samples.breakdown[bar.key]);
        });

        const result = {
            frames: samples.totalMs.length,
            preset: presetPath || null,
            // Recorded so before/after runs can be told apart: the dual-FBO
            // color format is what `?fboPrecision=high` switches.
            fboFormat: (typeof window.pmGetFboFormat === 'function') ? window.pmGetFboFormat() : null,
            crossfade: crossfadeBench ? { active: true, durationSec: crossfadeSec } : null,
            openmp: collectOpenmpInfo(Module),
            totalMs: summarize(samples.totalMs),
            fps: summarize(samples.fps),
            breakdownMs: breakdownMs,
        };

        console.log('[projectM benchmark] ' + JSON.stringify(result, null, 2));
        window.postMessage({ type: 'pm-benchmark-result', result: result }, '*');

        if (params.get('perfhud') !== '1') {
            setPerfHud(Module, 0);
        }
    }

    if (showHud || benchmarkRequested) {
        setPerfHud(Module, 1);
    }

    if (benchmarkRequested) {
        if (presetPath) {
            loadPresetFile(Module, presetPath);
        }
        samples = {
            totalMs: [],
            fps: [],
            breakdown: BARS.reduce((acc, bar) => {
                acc[bar.key] = [];
                return acc;
            }, /** @type {Record<PerfBarKey, number[]>} */ ({})),
        };

        if (crossfadeBench) {
            pumpCrossfade();
        }
    }

    /**
     * Keeps a soft-cut transition running until the benchmark has collected
     * `frames` in-crossfade samples. Each time the blend finishes, the next
     * preset is loaded to start a new one.
     */
    async function pumpCrossfade() {
        const playlist = await resolveCrossfadePresets();
        if (!playlist.length) {
            console.warn('[projectM benchmark] crossfade mode: no presets available to transition between');
            return;
        }

        let index = 0;
        while (!benchmarkDone) {
            if (!crossfadeActive()) {
                const entry = playlist[index % playlist.length];
                index += 1;
                try {
                    if (typeof entry === 'string') {
                        loadPresetFile(Module, entry);
                    } else {
                        await loadPresetEntry(entry, {});
                    }
                    await startTransitionWhenReady({ module: Module, durationSec: crossfadeSec });
                } catch (err) {
                    console.warn('[projectM benchmark] crossfade step failed:', err);
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /**
     * Presets to cycle through in crossfade mode: an explicit
     * `?crossfadePresets=a.milk,b.milk` list, else the `?preset=` file, else the
     * first two featured-pack presets.
     */
    async function resolveCrossfadePresets() {
        const explicit = (params.get('crossfadePresets') || '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
        if (explicit.length) {
            return explicit;
        }
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

    const presetSwitchBench = params.get('presetSwitchBench') === '1';
    if (presetSwitchBench) {
        fetchFeaturedManifest()
            .then((manifest) => {
                const presets = (manifest.presets || []).slice(0, 3);
                if (!presets.length) {
                    console.warn('[projectM] presetSwitchBench: no featured presets in manifest');
                    return null;
                }
                return measurePresetSwitchTimings(Module, presets, {
                    loadEntry: (entry, opts) => loadPresetEntry(entry, opts),
                });
            })
            .catch((err) => {
                console.warn('[projectM] presetSwitchBench failed:', err);
            });
    }

    return { benchmarkRequested, crossfadeBench, presetSwitchBench };
}
