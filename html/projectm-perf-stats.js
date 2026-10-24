// projectm-perf-stats.js
//
// The numbers behind the perf HUD and the benchmark record: which per-frame
// stats keys exist (CPU submit-time buckets, GPU TIME_ELAPSED buckets), the
// summary statistics a benchmark reports, and the engine facts recorded with
// it (OpenMP, dual-FBO format) so runs can be told apart. See
// docs/PERFORMANCE.md.

import {
    getOmpEnabled,
    getOmpMaxThreads,
    getOmpThreadCountInParallel,
    getOmpBlocktime,
} from './generated/projectm-wasm-api.js';
import { getFboFormatName } from './projectm-fbo-format.js';

/**
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

/** CPU submit-time buckets (libprojectM PerfTimers.hpp). */
/** @typedef {'audioMs' | 'rhythmMs' | 'perFrameEvalMs' | 'perPixelEvalMs' | 'blurMs' | 'waveformsShapesMs' | 'compositeMs'} PerfCpuKey */
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

/** @type {ReadonlyArray<PerfCpuKey>} */
export const CPU_KEYS = ['audioMs', 'rhythmMs', 'perFrameEvalMs', 'perPixelEvalMs', 'blurMs', 'waveformsShapesMs', 'compositeMs'];
/** @type {ReadonlyArray<PerfGpuKey>} */
export const GPU_KEYS = ['gpuWarpMs', 'gpuBlurMs', 'gpuShapesMs', 'gpuCopyMs', 'gpuCompositeMs', 'gpuPresentMs', 'gpuOtherMs', 'gpuMs'];
/** @type {ReadonlyArray<PerfBarKey>} */
export const SAMPLE_KEYS = [...CPU_KEYS, ...GPU_KEYS];

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
export function collectOpenmpInfo(Module) {
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
export function summarize(values) {
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
export function readFboFormat(Module) {
    try {
        return getFboFormatName(Module);
    } catch {
        return null;
    }
}

/**
 * @typedef {{ compiled: boolean, maxThreads: number, parallelThreadsObserved: number, blocktimeMs: number | null }} OpenmpInfo
 */
