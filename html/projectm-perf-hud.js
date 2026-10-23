// projectm-perf-hud.js
//
// The on-screen perf HUD: one row per render stage, a CPU and a GPU column
// each, repainted at most every 200 ms from the frames projectm-perf.js
// relays. Built from constant markup; created on first show, and reused for
// as long as it is still in the document.

/**
 * @typedef {import('./projectm-render-worker-types.ts').PerfFrameStats} PerfFrameStats
 * @typedef {import('./projectm-perf-stats.js').PerfCpuKey} PerfCpuKey
 * @typedef {import('./projectm-perf-stats.js').PerfGpuKey} PerfGpuKey
 */

const STYLE_ID = 'pm-perf-hud-style';
const HUD_ID = 'pm-perf-hud';

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
    { id: 'rhythm', label: 'Rhythm (tempo/beat)', cpu: 'rhythmMs', gpu: null, color: '#93c5fd' },
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

    // eslint-disable-next-line no-restricted-syntax -- built only from the constant ROWS table
    hudEl.innerHTML = `
        <h3 class="pm-perf-hud-title">Perf: <span data-key="fps">0</span> fps / <span data-key="totalMs">0.0</span>ms<span data-key="topology"></span><span data-key="linkPending"></span><span data-key="flashClamped"></span></h3>
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
export function updateHud(stats, topology) {
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
    // This engine's flash limiter, while it is on: how many frames it has had
    // to hold back (docs/FLASH_LIMITER.md).
    const flashEl = el.querySelector('[data-key="flashClamped"]');
    if (flashEl) {
        const clamped = stats.flashClampedFrames;
        flashEl.textContent = typeof clamped === 'number' && clamped >= 0 ? ` · flash-limited ${clamped}` : '';
    }

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
