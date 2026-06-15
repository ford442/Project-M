// projectm-perf.js
//
// Optional frame-time profiling HUD and headless benchmark harness for the
// projectM WASM build. See docs/PERFORMANCE.md.
//
// - HUD: toggled via `Module._set_perf_hud(1)` / `Module._set_perf_hud(0)`. Shows
//   FPS, total frame time, and a CPU/GPU timing breakdown as bars.
// - Benchmark mode: append `?benchmark=1&frames=1000&preset=/presets/foo.milk` to
//   the page URL. Once `frames` samples have been collected, prints a JSON
//   summary (mean/median/p95) to the console and posts it via
//   `window.postMessage({ type: 'pm-benchmark-result', result }, '*')`.

const STYLE_ID = 'pm-perf-hud-style';
const HUD_ID = 'pm-perf-hud';

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

    hudEl = document.getElementById(HUD_ID);
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
    el.querySelector('[data-key="fps"]').textContent = stats.fps.toFixed(0);
    el.querySelector('[data-key="totalMs"]').textContent = stats.totalMs.toFixed(2);

    BARS.forEach((bar) => {
        const row = el.querySelector(`.pm-perf-hud-row[data-key="${bar.key}"]`);
        if (!row) {
            return;
        }
        const value = stats[bar.key];
        const valid = typeof value === 'number' && value >= 0;
        const ms = valid ? value : 0;
        const pct = stats.totalMs > 0 ? Math.min(100, (ms / stats.totalMs) * 100) : 0;
        row.querySelector('.pm-perf-hud-bar-fill').style.width = pct + '%';
        row.querySelector('.pm-perf-hud-value').textContent = valid ? ms.toFixed(2) + 'ms' : 'n/a';
    });
}

function percentile(sortedValues, p) {
    if (sortedValues.length === 0) {
        return 0;
    }
    const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
    return sortedValues[idx];
}

function collectOpenmpInfo(Module) {
    if (!Module || typeof Module._get_omp_enabled !== 'function') {
        return { compiled: false, maxThreads: 1, parallelThreadsObserved: 1 };
    }
    return {
        compiled: Module._get_omp_enabled() !== 0,
        maxThreads: Module._get_omp_max_threads(),
        parallelThreadsObserved: typeof Module._get_omp_thread_count_in_parallel === 'function'
            ? Module._get_omp_thread_count_in_parallel()
            : 1,
    };
}

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
 * @param {*} Module The Emscripten module instance (must already be initialized).
 * @returns {{ benchmarkRequested: boolean }}
 */
export function setupPerfTools(Module) {
    const params = new URLSearchParams(location.search);
    const benchmarkRequested = params.get('benchmark') === '1';
    const showHud = params.get('perfhud') === '1' || benchmarkRequested;
    const frameTarget = Math.max(1, parseInt(params.get('frames'), 10) || 500);
    const presetPath = params.get('preset');

    let samples = null;
    let benchmarkDone = false;

    window.pmSetPerfHudEnabled = setHudVisible;
    window.pmOnPerfFrame = (stats) => {
        updateHud(stats);

        if (samples && !benchmarkDone) {
            samples.totalMs.push(stats.totalMs);
            samples.fps.push(stats.fps);
            BARS.forEach((bar) => {
                const value = stats[bar.key];
                if (typeof value === 'number' && value >= 0) {
                    samples.breakdown[bar.key].push(value);
                }
            });

            if (samples.totalMs.length >= frameTarget) {
                benchmarkDone = true;
                finishBenchmark();
            }
        }
    };

    function finishBenchmark() {
        const breakdownMs = {};
        BARS.forEach((bar) => {
            breakdownMs[bar.key] = summarize(samples.breakdown[bar.key]);
        });

        const result = {
            frames: samples.totalMs.length,
            preset: presetPath || null,
            openmp: collectOpenmpInfo(Module),
            totalMs: summarize(samples.totalMs),
            fps: summarize(samples.fps),
            breakdownMs: breakdownMs,
        };

        console.log('[projectM benchmark] ' + JSON.stringify(result, null, 2));
        window.postMessage({ type: 'pm-benchmark-result', result: result }, '*');

        if (params.get('perfhud') !== '1') {
            Module._set_perf_hud(0);
        }
    }

    if (showHud || benchmarkRequested) {
        Module._set_perf_hud(1);
    }

    if (benchmarkRequested) {
        if (presetPath) {
            Module.ccall('load_preset_file', null, ['string'], [presetPath]);
        }
        samples = {
            totalMs: [],
            fps: [],
            breakdown: BARS.reduce((acc, bar) => {
                acc[bar.key] = [];
                return acc;
            }, {}),
        };
    }

    return { benchmarkRequested };
}
