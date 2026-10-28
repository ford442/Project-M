// projectm-perf.js
//
// Optional frame-time profiling HUD and headless benchmark harness for the
// projectM WASM build. See docs/PERFORMANCE.md.
//
// This module wires an engine's perf frames to the pieces and collects the
// benchmark samples; the pieces are:
//
//   projectm-perf-hud.js           the on-screen HUD
//   projectm-perf-stats.js         stats keys, summaries, OpenMP / FBO facts
//   projectm-perf-crossfade.js     the crossfade benchmark's transition pump
//   projectm-perf-preset-switch.js the preset-switch (shader cache) benchmark

import { loadPresetFile, setPerfHud } from './generated/projectm-wasm-api.js';
import { FORMAT_NAMES } from './projectm-fbo-format.js';
import { subscribeWasmCallback } from './projectm-wasm-callbacks.js';
import { setHudVisible, updateHud } from './projectm-perf-hud.js';
import { SAMPLE_KEYS, collectOpenmpInfo, readFboFormat, summarize } from './projectm-perf-stats.js';
import { crossfadeActive, pumpCrossfade } from './projectm-perf-crossfade.js';
import { runPresetSwitchBench } from './projectm-perf-preset-switch.js';

export { setHudVisible };

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
 * @typedef {import('./projectm-perf-stats.js').PerfBarKey} PerfBarKey
 * @typedef {import('./projectm-perf-stats.js').PerfSummary} PerfSummary
 * @typedef {import('./projectm-perf-stats.js').OpenmpInfo} OpenmpInfo
 */

/**
 * Per-frame stats pushed from `js_perf_report_frame()` (WasmPerfGovernor.cpp).
 * The canonical shape is `PerfFrameStats` in projectm-render-worker-types.ts,
 * because the render worker relays it across postMessage.
 *
 * @typedef {import('./projectm-render-worker-types.ts').PerfFrameStats} PerfFrameStats
 * @typedef {import('./projectm-transport-types.ts').RenderTransport} RenderTransport
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
        onPerfHudEnabled: (listener) => subscribeWasmCallback('pmSetPerfHudEnabled', ({ enabled }) => listener(enabled)),
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

    const unsubscribeHudToggle = source.onPerfHudEnabled(setHudVisible);
    const unsubscribeFrames = source.onPerfFrame((stats) => {
        updateHud(stats, source.topology);

        if (samples && !benchmarkDone && (!crossfadeBench || crossfadeActive(Module))) {
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
        const breakdownMs = /** @type {Record<PerfBarKey, PerfSummary>} */ ({});
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
            pumpCrossfade(Module, {
                params,
                durationSec: crossfadeSec,
                stopped: () => benchmarkDone || disposed,
            }).catch((error) => {
                console.warn('[projectM benchmark] crossfade pump stopped:', error);
            });
        }
    }

    const presetSwitchRequested = params.get('presetSwitchBench') === '1';
    // Drives loads and polls readiness through the module on this thread.
    const presetSwitchBench = presetSwitchRequested && !!Module;
    if (presetSwitchRequested && !Module) {
        console.warn('[projectM] presetSwitchBench needs the main-thread topology (?renderWorker=0)');
    }
    if (presetSwitchBench && Module) {
        void runPresetSwitchBench(Module);
    }

    return { benchmarkRequested, crossfadeBench, presetSwitchBench, dispose };
}
