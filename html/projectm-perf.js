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
import { FORMAT_NAMES, getFboFormatName } from './projectm-fbo-format.js';
import { measurePresetSwitchTimings } from './projectm-shader-cache.js';
import { fetchFeaturedManifest, loadPresetEntry } from './projectm-preset-library.js';
import { startTransitionWhenReady } from './projectm-transitions.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';

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
//
// Two columns per stage. CPU is libprojectM's steady_clock submit time; GPU is a
// TIME_ELAPSED query per stage (WasmPerfGovernor.cpp), so fill-rate costs — the
// Y-flip copies, blur, float bandwidth — show up in the stage that caused them
// instead of only in whole-frame gpuMs. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md
// "Measurement: what the HUD can and cannot tell you".
//
// Both render topologies: setupPerfTools(Module) on the main thread,
// setupTransportPerfTools(transport) for whichever one a ProjectMContext picked.
// In the worker topology the frames are relayed from the worker (see
// RenderWorkerPerfFramesMessage in projectm-render-worker-types.ts).

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/**
 * Per-frame stats pushed from `js_perf_report_frame()` (WasmPerfGovernor.cpp).
 * The canonical shape is `PerfFrameStats` in projectm-render-worker-types.ts,
 * because the render worker relays it across postMessage.
 *
 * @typedef {import('./projectm-render-worker-types.ts').PerfFrameStats} PerfFrameStats
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
 */

/** CPU submit-time buckets (libprojectM PerfTimers.hpp). */
/** @typedef {'audioMs' | 'perFrameEvalMs' | 'perPixelEvalMs' | 'blurMs' | 'waveformsShapesMs' | 'compositeMs'} PerfCpuKey */
/** GPU TIME_ELAPSED buckets: one per libprojectM GPU stage, plus the whole frame. */
/** @typedef {'gpuWarpMs' | 'gpuBlurMs' | 'gpuShapesMs' | 'gpuCopyMs' | 'gpuCompositeMs' | 'gpuPresentMs' | 'gpuOtherMs' | 'gpuMs'} PerfGpuKey */
/** Every {@link PerfFrameStats} key the benchmark summarizes besides totalMs/fps. */
/** @typedef {PerfCpuKey | PerfGpuKey} PerfBarKey */

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

/** @type {ReadonlyArray<PerfCpuKey>} */
const CPU_KEYS = ['audioMs', 'perFrameEvalMs', 'perPixelEvalMs', 'blurMs', 'waveformsShapesMs', 'compositeMs'];
/** @type {ReadonlyArray<PerfGpuKey>} */
const GPU_KEYS = ['gpuWarpMs', 'gpuBlurMs', 'gpuShapesMs', 'gpuCopyMs', 'gpuCompositeMs', 'gpuPresentMs', 'gpuOtherMs', 'gpuMs'];
/** @type {ReadonlyArray<PerfBarKey>} */
const SAMPLE_KEYS = [...CPU_KEYS, ...GPU_KEYS];

/**
 * One HUD row per stage, with the CPU bucket and the GPU bucket that time it.
 * A null column is a stage that side cannot see: audio and per-frame equations
 * issue no GL, and the CPU has no bucket of its own for the flips (they are
 * inside `compositeMs`), the output blit, or the unattributed remainder.
 *
 * @type {ReadonlyArray<{ id: string, label: string, cpu: PerfCpuKey | 'totalMs' | null, gpu: PerfGpuKey | null, color: string }>}
 */
const ROWS = [
    { id: 'audio', label: 'Audio FFT/Loudness', cpu: 'audioMs', gpu: null, color: '#60a5fa' },
    { id: 'perFrame', label: 'Per-frame eval', cpu: 'perFrameEvalMs', gpu: null, color: '#34d399' },
    { id: 'perPixel', label: 'Per-pixel/warp', cpu: 'perPixelEvalMs', gpu: 'gpuWarpMs', color: '#fbbf24' },
    { id: 'blur', label: 'Blur', cpu: 'blurMs', gpu: 'gpuBlurMs', color: '#a78bfa' },
    { id: 'shapes', label: 'Waveforms/shapes', cpu: 'waveformsShapesMs', gpu: 'gpuShapesMs', color: '#f472b6' },
    { id: 'copy', label: 'Y-flip copies', cpu: null, gpu: 'gpuCopyMs', color: '#fb923c' },
    { id: 'composite', label: 'Composite', cpu: 'compositeMs', gpu: 'gpuCompositeMs', color: '#22d3ee' },
    { id: 'present', label: 'Present', cpu: null, gpu: 'gpuPresentMs', color: '#4ade80' },
    { id: 'other', label: 'Other', cpu: null, gpu: 'gpuOtherMs', color: '#94a3b8' },
    { id: 'total', label: 'Total', cpu: 'totalMs', gpu: 'gpuMs', color: '#f87171' },
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
#${HUD_ID} .pm-perf-hud-bar-fill,
#${HUD_ID} .pm-perf-hud-bar-fill-gpu {
  display: block;
  height: 50%;
  width: 0%;
  transition: width 0.1s linear;
}
#${HUD_ID} .pm-perf-hud-bar-fill-gpu {
  opacity: 0.55;
}
#${HUD_ID} .pm-perf-hud-value,
#${HUD_ID} .pm-perf-hud-gpu {
  flex: 0 0 52px;
  text-align: right;
  color: #e2e8f0;
}
#${HUD_ID} .pm-perf-hud-gpu {
  color: #fca5a5;
}
#${HUD_ID} .pm-perf-hud-head {
  color: #64748b;
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
    // The cached element is only good while it is still the one in the document.
    // Checking identity rather than just non-null keeps the HUD from writing into a
    // detached node after the page it was built for is gone.
    hudEl = /** @type {HTMLDivElement | null} */ (document.getElementById(HUD_ID));
    if (hudEl) {
        return hudEl;
    }

    injectStyles();

    hudEl = document.createElement('div');
    hudEl.id = HUD_ID;

    const rows = ROWS.map((row) => `
        <div class="pm-perf-hud-row" data-key="${row.id}">
            <span class="pm-perf-hud-label">${row.label}</span>
            <span class="pm-perf-hud-bar-track"><span class="pm-perf-hud-bar-fill" style="background:${row.color}"></span><span class="pm-perf-hud-bar-fill-gpu" style="background:${row.color}"></span></span>
            <span class="pm-perf-hud-value">-</span>
            <span class="pm-perf-hud-gpu">-</span>
        </div>
    `).join('');

    hudEl.innerHTML = `
        <h3 class="pm-perf-hud-title">Perf: <span data-key="fps">0</span> fps / <span data-key="totalMs">0.0</span>ms<span data-key="topology"></span><span data-key="linkPending"></span></h3>
        <div class="pm-perf-hud-row pm-perf-hud-head">
            <span class="pm-perf-hud-label">stage</span>
            <span class="pm-perf-hud-bar-track" style="background:none">CPU bar / GPU bar</span>
            <span class="pm-perf-hud-value">CPU</span>
            <span class="pm-perf-hud-gpu">GPU</span>
        </div>
        ${rows}
    `;
    document.body.appendChild(hudEl);

    return hudEl;
}

/**
 * Shows or hides the on-screen perf HUD. `setupPerfTools()` subscribes it to
 * `pmSetPerfHudEnabled`, which C++ calls via js_perf_hud_set_enabled() when
 * set_perf_hud() is toggled.
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

/**
 * A HUD cell: `-` for a stage that side cannot see, `n/a` for one it can but
 * has no number for (no timer-query extension, or no result yet).
 *
 * @param {string | null} key
 * @param {PerfFrameStats} stats
 * @returns {{ text: string, ms: number }}
 */
function cell(key, stats) {
    if (!key) {
        return { text: '-', ms: 0 };
    }
    const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (stats))[key];
    if (typeof value !== 'number' || value < 0) {
        return { text: 'n/a', ms: 0 };
    }
    return { text: value.toFixed(2) + 'ms', ms: value };
}

/**
 * @param {PerfFrameStats} stats
 * @param {string} topology
 */
function updateHud(stats, topology) {
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
    const topologyEl = el.querySelector('[data-key="topology"]');
    const linkEl = el.querySelector('[data-key="linkPending"]');
    if (fpsEl) fpsEl.textContent = stats.fps.toFixed(0);
    if (totalEl) totalEl.textContent = stats.totalMs.toFixed(2);
    // Which topology produced the numbers: the worker's frames are relayed, and
    // a comparison across topologies is not like for like.
    if (topologyEl) topologyEl.textContent = topology === 'worker' ? ' · worker' : '';
    if (linkEl) linkEl.textContent = stats.shaderLinkPending ? ' · linking shaders' : '';

    // perPixelEvalMs means different work on the two paths, so the row says which one
    // produced it rather than leaving two incomparable numbers looking alike.
    const perPixelRow = el.querySelector('.pm-perf-hud-row[data-key="perPixel"]');
    const perPixelLabel = perPixelRow && perPixelRow.querySelector('.pm-perf-hud-label');
    if (perPixelLabel) {
        const path = stats.perPixelEvalPath === 'gpu' ? 'gpu' : 'cpu';
        perPixelLabel.textContent = 'Per-pixel/warp [' + path + ']';
    }

    ROWS.forEach((row) => {
        const rowEl = el.querySelector(`.pm-perf-hud-row[data-key="${row.id}"]`);
        if (!rowEl) {
            return;
        }
        const cpu = cell(row.cpu, stats);
        const gpu = cell(row.gpu, stats);
        // Each bar is a share of its own column's frame total, so CPU and GPU
        // read on the same scale: which stage dominates that side of the frame.
        const cpuPct = stats.totalMs > 0 ? Math.min(100, (cpu.ms / stats.totalMs) * 100) : 0;
        const gpuPct = stats.gpuMs > 0 ? Math.min(100, (gpu.ms / stats.gpuMs) * 100) : 0;
        const cpuFill = /** @type {HTMLElement | null} */ (rowEl.querySelector('.pm-perf-hud-bar-fill'));
        const gpuFill = /** @type {HTMLElement | null} */ (rowEl.querySelector('.pm-perf-hud-bar-fill-gpu'));
        const cpuEl = rowEl.querySelector('.pm-perf-hud-value');
        const gpuEl = rowEl.querySelector('.pm-perf-hud-gpu');
        if (cpuFill) cpuFill.style.width = cpuPct + '%';
        if (gpuFill) gpuFill.style.width = gpuPct + '%';
        if (cpuEl) cpuEl.textContent = cpu.text;
        if (gpuEl) gpuEl.textContent = gpu.text;
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
 * The dual-FBO format name for the benchmark record, or null when the bundle
 * cannot say (older bundles, or a module that is not initialised yet).
 *
 * @param {ProjectMModule} Module
 * @returns {string | null}
 */
function readFboFormat(Module) {
    try {
        return getFboFormatName(Module);
    } catch {
        return null;
    }
}

/**
 * @typedef {{ compiled: boolean, maxThreads: number, parallelThreadsObserved: number, blocktimeMs: number | null }} OpenmpInfo
 */

/**
 * Where the perf tools get their frames from and how they drive the engine.
 * One per topology: the module on this thread, or a render transport whose
 * module is in the worker.
 *
 * @typedef {object} PerfSource
 * @property {object} key Identity for the one-controller-per-engine rule.
 * @property {'main' | 'worker'} topology
 * @property {ProjectMModule | null} module Only on the main thread; the
 *   crossfade and preset-switch benchmarks need synchronous engine access.
 * @property {(listener: (stats: PerfFrameStats) => void) => () => void} onPerfFrame
 * @property {(listener: (enabled: boolean) => void) => () => void} onPerfHudEnabled
 * @property {(enabled: 0 | 1) => void} setPerfHud
 * @property {(path: string) => void} loadPreset
 * @property {() => string | null} fboFormat
 * @property {() => OpenmpInfo} openmp
 */

/**
 * One perf controller per engine: running setup again for the same module or
 * transport (a retried init) replaces the earlier subscription instead of
 * stacking a second HUD updater and a second benchmark collector.
 *
 * @type {WeakMap<object, () => void>}
 */
const activePerfTools = new WeakMap();

/** @typedef {{ benchmarkRequested: boolean, crossfadeBench: boolean, presetSwitchBench: boolean, dispose: () => void }} PerfTools */

/**
 * Sets up the perf HUD feed and, if `?benchmark=1` is present in the page URL,
 * runs a headless benchmark for `?frames=N` frames (default 500) on an optional
 * `?preset=<path>` and reports JSON results.
 *
 * Both engine callbacks (`pmOnPerfFrame` for the per-frame stats and
 * `pmSetPerfHudEnabled` for the HUD toggle) arrive through the WASM callback bus,
 * so this module writes nothing to `window` and works without the legacy shim.
 *
 * @param {ProjectMModule} Module The Emscripten module instance (must already be initialized).
 * @returns {PerfTools}
 */
export function setupPerfTools(Module) {
    return startPerfTools({
        key: Module,
        topology: 'main',
        module: Module,
        onPerfFrame: (listener) => subscribeWasmCallback('pmOnPerfFrame', listener),
        onPerfHudEnabled: (listener) => subscribeWasmCallback('pmSetPerfHudEnabled', listener),
        setPerfHud: (enabled) => setPerfHud(Module, enabled),
        loadPreset: (path) => loadPresetFile(Module, path),
        fboFormat: () => readFboFormat(Module),
        openmp: () => collectOpenmpInfo(Module),
    });
}

/**
 * The same tools for whichever topology a ProjectMContext picked.
 *
 * On the main thread this is {@link setupPerfTools}. In the render worker the
 * frames and the HUD toggle are relayed by the worker, the engine is driven
 * with proxied calls, and the FBO format comes from the worker's stats. The
 * crossfade and preset-switch benchmarks poll engine state synchronously, so
 * they stay main-thread-only and say so; the HUD and the plain `?benchmark=1`
 * run work in both.
 *
 * @param {RenderTransport} transport
 * @returns {PerfTools}
 */
export function setupTransportPerfTools(transport) {
    if (transport.module) {
        return setupPerfTools(/** @type {ProjectMModule} */ (transport.module));
    }

    const handle = transport.workerHandle;
    /** @type {OpenmpInfo} */
    let openmp = { compiled: false, maxThreads: 1, parallelThreadsObserved: 1, blocktimeMs: null };
    // Answered asynchronously by the worker, well before a benchmark has
    // collected its frames. Each call that fails (an older bundle) keeps the
    // default above.
    Promise.all([
        transport.call('getOmpEnabled'),
        transport.call('getOmpMaxThreads'),
        transport.call('getOmpThreadCountInParallel'),
        transport.call('getOmpBlocktime'),
    ]).then(([enabled, maxThreads, observed, blocktime]) => {
        openmp = {
            compiled: Number(enabled) !== 0,
            maxThreads: Number(maxThreads) || 1,
            parallelThreadsObserved: Number(observed) || 1,
            blocktimeMs: typeof blocktime === 'number' ? blocktime : null,
        };
    }, () => {});

    return startPerfTools({
        key: transport,
        topology: 'worker',
        module: null,
        onPerfFrame: (listener) => transport.onPerfFrame(listener),
        onPerfHudEnabled: (listener) => transport.onPerfHudEnabled(listener),
        setPerfHud: (enabled) => transport.callVoid('setPerfHud', enabled),
        loadPreset: (path) => transport.callVoid('loadPresetFile', path),
        fboFormat: () => {
            const index = handle?.getLastStats()?.fboFormat;
            return typeof index === 'number' && index >= 0 ? (FORMAT_NAMES[index] || 'RGBA8') : null;
        },
        openmp: () => openmp,
    });
}

/**
 * @param {PerfSource} source
 * @returns {PerfTools}
 */
function startPerfTools(source) {
    activePerfTools.get(source.key)?.();
    const Module = source.module;

    const params = new URLSearchParams(location.search);
    const benchmarkRequested = params.get('benchmark') === '1';
    const showHud = params.get('perfhud') === '1' || benchmarkRequested;
    const frameTarget = Math.max(1, parseInt(params.get('frames') ?? '', 10) || 500);
    const presetPath = params.get('preset');
    const crossfadeRequested = benchmarkRequested && params.get('crossfade') === '1';
    // Polls transition_is_active() every frame, which needs the module here.
    const crossfadeBench = crossfadeRequested && !!Module;
    if (crossfadeRequested && !Module) {
        console.warn('[projectM benchmark] crossfade mode needs the main-thread topology (?renderWorker=0); sampling steady-state frames instead');
    }
    const crossfadeSec = Math.max(0.5, parseFloat(params.get('crossfadeSec') ?? '') || 20);

    /**
     * @type {{
     *   totalMs: number[],
     *   fps: number[],
     *   breakdown: Record<PerfBarKey, number[]>,
     *   shaderLinkPendingFrames: number,
     *   perPixelEvalPaths: Set<string>,
     * } | null}
     */
    let samples = null;
    let benchmarkDone = false;
    let disposed = false;

    // In crossfade mode only frames rendered while a blend is actually in
    // progress are representative — everything else is a steady-state frame
    // that never touches the Preset B FBOs.
    function crossfadeActive() {
        try {
            return !!Module && transitionIsActive(Module);
        } catch {
            return false;
        }
    }

    const unsubscribeHudToggle = source.onPerfHudEnabled(setHudVisible);
    const unsubscribeFrames = source.onPerfFrame((stats) => {
        updateHud(stats, source.topology);

        if (samples && !benchmarkDone && (!crossfadeBench || crossfadeActive())) {
            // Bound locally so the narrowing survives into the closure below.
            const collected = samples;
            collected.totalMs.push(stats.totalMs);
            collected.fps.push(stats.fps);
            if (stats.shaderLinkPending) {
                collected.shaderLinkPendingFrames += 1;
            }
            if (stats.perPixelEvalPath === 'gpu' || stats.perPixelEvalPath === 'cpu') {
                collected.perPixelEvalPaths.add(stats.perPixelEvalPath);
            }
            // GPU results arrive a frame or two late and repeat until the next
            // one lands; only a fresh one is a new sample. (Bundles without the
            // flag report a fresh result every frame, as they always did.)
            const gpuFresh = stats.gpuFresh !== false;
            SAMPLE_KEYS.forEach((key) => {
                if (!gpuFresh && key.startsWith('gpu')) {
                    return;
                }
                const value = stats[key];
                if (typeof value === 'number' && value >= 0) {
                    collected.breakdown[key].push(value);
                }
            });

            if (collected.totalMs.length >= frameTarget) {
                benchmarkDone = true;
                finishBenchmark(collected);
            }
        }
    });

    const dispose = () => {
        disposed = true;
        unsubscribeFrames();
        unsubscribeHudToggle();
        if (activePerfTools.get(source.key) === dispose) {
            activePerfTools.delete(source.key);
        }
    };
    activePerfTools.set(source.key, dispose);

    /**
     * @param {Set<string>} paths
     * @returns {'gpu' | 'cpu' | 'mixed' | null}
     */
    function summarizePerPixelPath(paths) {
        if (paths.size === 1) {
            return /** @type {'gpu' | 'cpu'} */ ([...paths][0]);
        }
        return paths.size > 1 ? 'mixed' : null;
    }

    /** @param {NonNullable<typeof samples>} samples */
    function finishBenchmark(samples) {
        /** @type {Record<PerfBarKey, PerfSummary>} */
        const breakdownMs = /** @type {any} */ ({});
        SAMPLE_KEYS.forEach((key) => {
            breakdownMs[key] = summarize(samples.breakdown[key]);
        });

        const result = {
            frames: samples.totalMs.length,
            preset: presetPath || null,
            // Recorded so before/after runs can be told apart: the dual-FBO
            // color format is what `?fboPrecision=high` switches.
            fboFormat: source.fboFormat(),
            // The worker's frames are relayed over postMessage; the engine work
            // is the same, but a run is only like for like with its own topology.
            topology: source.topology,
            // Which per-pixel path produced breakdownMs.perPixelEvalMs. 'gpu' or 'cpu'
            // for a run that stayed on one, 'mixed' if the preset changed under the
            // benchmark. Two runs are only comparable when this matches, because the
            // bucket covers different work on the two paths -- `?perPixelEval=cpu`
            // forces the CPU side of that A/B.
            perPixelEvalPath: summarizePerPixelPath(samples.perPixelEvalPaths),
            crossfade: crossfadeBench ? { active: true, durationSec: crossfadeSec } : null,
            openmp: source.openmp(),
            totalMs: summarize(samples.totalMs),
            fps: summarize(samples.fps),
            breakdownMs: breakdownMs,
            // Frames that drew the previous preset while the next one's shaders linked.
            shaderLinkPendingFrames: samples.shaderLinkPendingFrames,
        };

        console.log('[projectM benchmark] ' + JSON.stringify(result, null, 2));
        window.postMessage({ type: 'pm-benchmark-result', result: result }, '*');

        if (params.get('perfhud') !== '1') {
            source.setPerfHud(0);
        }
    }

    if (showHud || benchmarkRequested) {
        source.setPerfHud(1);
    }

    if (benchmarkRequested) {
        if (presetPath) {
            source.loadPreset(presetPath);
        }
        samples = {
            totalMs: [],
            fps: [],
            shaderLinkPendingFrames: 0,
            perPixelEvalPaths: new Set(),
            breakdown: SAMPLE_KEYS.reduce((acc, key) => {
                acc[key] = [];
                return acc;
            }, /** @type {Record<PerfBarKey, number[]>} */ ({})),
        };

        if (crossfadeBench && Module) {
            pumpCrossfade(Module);
        }
    }

    /**
     * Keeps a soft-cut transition running until the benchmark has collected
     * `frames` in-crossfade samples. Each time the blend finishes, the next
     * preset is loaded to start a new one.
     *
     * @param {ProjectMModule} Module
     */
    async function pumpCrossfade(Module) {
        const playlist = await resolveCrossfadePresets();
        if (!playlist.length) {
            console.warn('[projectM benchmark] crossfade mode: no presets available to transition between');
            return;
        }

        let index = 0;
        while (!benchmarkDone && !disposed) {
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

    const presetSwitchRequested = params.get('presetSwitchBench') === '1';
    // Drives loads and polls readiness through the module on this thread.
    const presetSwitchBench = presetSwitchRequested && !!Module;
    if (presetSwitchRequested && !Module) {
        console.warn('[projectM] presetSwitchBench needs the main-thread topology (?renderWorker=0)');
    }
    if (presetSwitchBench && Module) {
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

    return { benchmarkRequested, crossfadeBench, presetSwitchBench, dispose };
}
