// Unit tests for html/projectm-perf.js — the frame-time HUD and the headless
// `?benchmark=1` harness that PERFORMANCE.md and
// scripts/record_frame_budget.mjs consume. Run with:
//   node --test tests/web/projectm-perf.test.mjs
//
// setupPerfTools() reads `location.search` and paints into `document`, so every
// test drives it through tests/web/helpers/fake-dom.mjs rather than a real
// browser. The engine reaches it through `globalThis.pmOnPerfFrame` /
// `pmSetPerfHudEnabled`, which the WASM callback bus installs (the tests call
// them exactly as WasmPerfGovernor.cpp does).

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { setHudVisible, setupPerfTools } from '../../html/projectm-perf.js';
import { countWasmCallbackSubscribers } from '../../html/projectm-wasm-callbacks.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

/** Perf controllers started by a test; every one is disposed so none outlives it. */
const started = [];
afterEach(() => {
    for (const tools of started.splice(0)) tools.dispose();
});

/** @param {Parameters<typeof setupPerfTools>[0]} module */
function startPerfTools(module) {
    const tools = setupPerfTools(module);
    started.push(tools);
    return tools;
}

/**
 * @param {object} [overrides] Extra `_`-prefixed exports to expose.
 */
function fakeModule(overrides = {}) {
    /** @type {number[]} */
    const perfHudCalls = [];
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const ccalls = [];
    return {
        _set_perf_hud: (enabled) => perfHudCalls.push(enabled),
        _transition_is_active: () => 0,
        ccall: (name, _returnType, _argTypes, args) => { ccalls.push({ name, args }); return null; },
        perfHudCalls,
        ccalls,
        ...overrides,
    };
}

function frame(overrides = {}) {
    return {
        totalMs: 10,
        audioMs: 2,
        perFrameEvalMs: 1,
        perPixelEvalMs: 3,
        blurMs: 1,
        waveformsShapesMs: 1,
        compositeMs: 1,
        gpuMs: -1,
        fps: 60,
        ...overrides,
    };
}

test('the HUD renders per-stage bars, throttles DOM writes, and hides on demand', () => {
    const dom = installFakeDom({ search: '?perfhud=1' });
    const module = fakeModule();
    try {
        const result = startPerfTools(module);
        assert.deepEqual(
            { ...result, dispose: typeof result.dispose },
            { benchmarkRequested: false, crossfadeBench: false, presetSwitchBench: false, dispose: 'function' },
        );
        // ?perfhud=1 turns the C++ side's reporting on without arming a benchmark.
        assert.deepEqual(module.perfHudCalls, [1]);

        // Frames arriving while the HUD is hidden must not build any DOM.
        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.document.getElementById('pm-perf-hud'), null);

        globalThis.pmSetPerfHudEnabled(true);
        const hud = dom.document.getElementById('pm-perf-hud');
        assert.ok(hud, 'enabling the HUD should create it');
        assert.equal(hud.classList.contains('visible'), true);
        assert.ok(dom.document.getElementById('pm-perf-hud-style'), 'styles should be injected once');

        globalThis.pmOnPerfFrame(frame());
        assert.equal(hud.querySelector('[data-key="fps"]').textContent, '60');
        assert.equal(hud.querySelector('[data-key="totalMs"]').textContent, '10.00');

        const audioRow = hud.querySelector('.pm-perf-hud-row[data-key="audioMs"]');
        assert.equal(audioRow.querySelector('.pm-perf-hud-value').textContent, '2.00ms');
        // 2 ms of a 10 ms frame.
        assert.equal(audioRow.querySelector('.pm-perf-hud-bar-fill').style.width, '20%');

        // A negative gpuMs means EXT_disjoint_timer_query is missing — that is
        // reported as unavailable, not as a 0 ms stage.
        const gpuRow = hud.querySelector('.pm-perf-hud-row[data-key="gpuMs"]');
        assert.equal(gpuRow.querySelector('.pm-perf-hud-value').textContent, 'n/a');
        assert.equal(gpuRow.querySelector('.pm-perf-hud-bar-fill').style.width, '0%');

        // The HUD repaints at most every 200 ms, so this frame is dropped...
        globalThis.pmOnPerfFrame(frame({ fps: 12, totalMs: 83 }));
        assert.equal(hud.querySelector('[data-key="fps"]').textContent, '60');

        // ...and the next one, past the interval, lands.
        dom.advanceClock(250);
        globalThis.pmOnPerfFrame(frame({ fps: 12, totalMs: 83 }));
        assert.equal(hud.querySelector('[data-key="fps"]').textContent, '12');

        // Frames drawn while the next preset's shaders link are flagged; bundles
        // that predate the flag leave it absent, which reads as not linking.
        const linkEl = hud.querySelector('[data-key="linkPending"]');
        assert.equal(linkEl.textContent, '');
        dom.advanceClock(250);
        globalThis.pmOnPerfFrame(frame({ shaderLinkPending: true }));
        assert.equal(linkEl.textContent, ' · linking shaders');
        dom.advanceClock(250);
        globalThis.pmOnPerfFrame(frame({ shaderLinkPending: false }));
        assert.equal(linkEl.textContent, '');

        globalThis.pmSetPerfHudEnabled(false);
        assert.equal(hud.classList.contains('visible'), false);
    } finally {
        setHudVisible(false);
        dom.restore();
    }
});

test('the HUD names the per-pixel path, and the benchmark records it', () => {
    // perPixelEvalMs covers the evaluator loop on the CPU path but only the draw
    // submission on the GPU path, so both readouts have to say which one they are.
    // updateHud() only repaints once per 200 ms of performance.now(), and that
    // deadline is module state shared with the tests above, so this one starts its
    // clock well past whatever they left behind.
    const dom = installFakeDom({ search: '?benchmark=1&perfhud=1&frames=2', now: 1_000_000 });
    const module = fakeModule();
    try {
        startPerfTools(module);
        globalThis.pmSetPerfHudEnabled(true);
        const hud = dom.document.getElementById('pm-perf-hud');
        const label = () => hud
            .querySelector('.pm-perf-hud-row[data-key="perPixelEvalMs"]')
            .querySelector('.pm-perf-hud-label').textContent;

        globalThis.pmOnPerfFrame(frame({ perPixelEvalPath: 'gpu' }));
        assert.equal(label(), 'Per-pixel/warp [gpu]');

        globalThis.pmOnPerfFrame(frame({ perPixelEvalPath: 'gpu' }));
        assert.equal(dom.posted.length, 1);
        assert.equal(dom.posted[0].result.perPixelEvalPath, 'gpu');
    } finally {
        setHudVisible(false);
        dom.restore();
    }
});

test('a benchmark that saw both per-pixel paths reports them as mixed', () => {
    // Two runs are only comparable when the path matches, so a run that changed
    // preset mid-flight must not claim either one.
    const dom = installFakeDom({ search: '?benchmark=1&frames=2' });
    const module = fakeModule();
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame({ perPixelEvalPath: 'cpu' }));
        globalThis.pmOnPerfFrame(frame({ perPixelEvalPath: 'gpu' }));

        assert.equal(dom.posted.length, 1);
        assert.equal(dom.posted[0].result.perPixelEvalPath, 'mixed');
    } finally {
        dom.restore();
    }
});

test('a benchmark from a build that reports no per-pixel path records null', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=1' });
    const module = fakeModule();
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame());

        assert.equal(dom.posted.length, 1);
        assert.equal(dom.posted[0].result.perPixelEvalPath, null);
    } finally {
        dom.restore();
    }
});

test('?benchmark=1 collects `frames` samples then reports mean/median/p95', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=2&preset=/presets/x.milk' });
    // The format comes from the module itself, not from a page global.
    const module = fakeModule({ _dual_fbo_get_format: () => 0 });
    try {
        const result = startPerfTools(module);
        assert.equal(result.benchmarkRequested, true);
        assert.equal(result.crossfadeBench, false);
        // ?preset= is loaded before sampling starts.
        assert.deepEqual(module.ccalls, [{ name: 'load_preset_file', args: ['/presets/x.milk'] }]);

        globalThis.pmOnPerfFrame(frame({ totalMs: 10, fps: 100 }));
        assert.equal(dom.posted.length, 0, 'the report should wait for the full sample count');
        globalThis.pmOnPerfFrame(frame({ totalMs: 20, fps: 50 }));

        assert.equal(dom.posted.length, 1);
        const { type, result: report } = dom.posted[0];
        assert.equal(type, 'pm-benchmark-result');
        assert.equal(report.frames, 2);
        assert.equal(report.preset, '/presets/x.milk');
        assert.equal(report.fboFormat, 'RGBA16F');
        assert.equal(report.crossfade, null);
        assert.deepEqual(report.totalMs, { mean: 15, median: 20, p95: 20, min: 10, max: 20 });
        assert.deepEqual(report.fps, { mean: 75, median: 100, p95: 100, min: 50, max: 100 });
        assert.deepEqual(report.breakdownMs.audioMs, { mean: 2, median: 2, p95: 2, min: 2, max: 2 });
        // gpuMs was negative in both frames, so nothing was collected for it.
        assert.deepEqual(report.breakdownMs.gpuMs, { mean: 0, median: 0, p95: 0, min: 0, max: 0 });
        // No OpenMP exports on this module.
        assert.deepEqual(report.openmp, {
            compiled: false, maxThreads: 1, parallelThreadsObserved: 1, blocktimeMs: null,
        });

        // Sampling is over: the HUD reporting the benchmark turned on is turned
        // back off, and further frames are ignored.
        assert.deepEqual(module.perfHudCalls, [1, 0]);
        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.posted.length, 1);
    } finally {
        dom.restore();
    }
});

test('the benchmark counts frames rendered while shaders were linking', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=3' });
    const module = fakeModule();
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame({ shaderLinkPending: true }));
        globalThis.pmOnPerfFrame(frame({ shaderLinkPending: true }));
        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.posted[0].result.shaderLinkPendingFrames, 2);
    } finally {
        dom.restore();
    }
});

test('the benchmark records the OpenMP configuration when the bundle exports it', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=1' });
    const module = fakeModule({
        _get_omp_enabled: () => 1,
        _get_omp_max_threads: () => 4,
        _get_omp_thread_count_in_parallel: () => 3,
        _get_omp_blocktime: () => 0,
    });
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame());
        assert.deepEqual(dom.posted[0].result.openmp, {
            compiled: true, maxThreads: 4, parallelThreadsObserved: 3, blocktimeMs: 0,
        });
        // This bundle exports no dual_fbo_get_format(), so the format is unknown.
        assert.equal(dom.posted[0].result.fboFormat, null);
    } finally {
        dom.restore();
    }
});

test('an older bundle without the blocktime export reports it as unknown', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=1' });
    const module = fakeModule({
        _get_omp_enabled: () => 0,
        _get_omp_max_threads: () => 1,
    });
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame());
        assert.deepEqual(dom.posted[0].result.openmp, {
            compiled: false, maxThreads: 1, parallelThreadsObserved: 1, blocktimeMs: null,
        });
    } finally {
        dom.restore();
    }
});

test('?perfhud=1 alongside a benchmark leaves the HUD on after the run', () => {
    const dom = installFakeDom({ search: '?benchmark=1&perfhud=1&frames=1' });
    const module = fakeModule();
    try {
        startPerfTools(module);
        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.posted.length, 1);
        assert.deepEqual(module.perfHudCalls, [1], 'an explicitly requested HUD is not switched off');
    } finally {
        dom.restore();
    }
});

test('crossfade mode only samples frames rendered mid-blend', async () => {
    const dom = installFakeDom({
        search: '?benchmark=1&crossfade=1&frames=1&crossfadeSec=3&crossfadePresets=a.milk,%20b.milk',
    });
    let blending = false;
    const module = fakeModule({ _transition_is_active: () => (blending ? 1 : 0) });
    // The pump loads the next preset whenever no blend is in flight; treat that
    // load as the blend starting.
    const baseCcall = module.ccall;
    module.ccall = (name, returnType, argTypes, args) => {
        if (name === 'load_preset_file') blending = true;
        return baseCcall(name, returnType, argTypes, args);
    };

    try {
        const result = startPerfTools(module);
        assert.equal(result.crossfadeBench, true);

        // Frames that arrive before a blend is running are not representative
        // and must not be counted.
        globalThis.pmOnPerfFrame(frame({ totalMs: 99 }));
        assert.equal(dom.posted.length, 0);

        // Let the pump run one iteration and start a blend.
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(blending, true, 'the pump should have loaded a preset');
        assert.deepEqual(module.ccalls, [{ name: 'load_preset_file', args: ['a.milk'] }]);

        globalThis.pmOnPerfFrame(frame({ totalMs: 12 }));
        assert.equal(dom.posted.length, 1);
        const report = dom.posted[0].result;
        assert.equal(report.frames, 1);
        assert.deepEqual(report.crossfade, { active: true, durationSec: 3 });
        assert.equal(report.totalMs.mean, 12, 'the pre-blend frame must not be in the sample');

        // Give the pump's 100 ms sleep time to observe benchmarkDone and exit.
        await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
        dom.restore();
    }
});

test('crossfade mode falls back to the featured manifest and warns when it is empty', async () => {
    const dom = installFakeDom({ search: '?benchmark=1&crossfade=1&frames=1' });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    /** @type {string[]} */
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ presets: [] }) });

    try {
        startPerfTools(fakeModule());
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(
            warnings.some((w) => w.includes('no presets available to transition between')),
            `expected a warning, got ${JSON.stringify(warnings)}`,
        );
    } finally {
        console.warn = originalWarn;
        if (originalFetch) globalThis.fetch = originalFetch;
        dom.restore();
    }
});

test('?presetSwitchBench=1 warns instead of throwing when the manifest is empty', async () => {
    const dom = installFakeDom({ search: '?presetSwitchBench=1' });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    /** @type {string[]} */
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ presets: [] }) });

    try {
        const result = startPerfTools(fakeModule());
        assert.equal(result.presetSwitchBench, true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(warnings.some((w) => w.includes('presetSwitchBench: no featured presets')));
    } finally {
        console.warn = originalWarn;
        if (originalFetch) globalThis.fetch = originalFetch;
        dom.restore();
    }
});

// ---- Lifecycle: nothing on the page, and teardown really tears down ----------

test('setup writes nothing to window and listens only through the callback bus', () => {
    const dom = installFakeDom({ search: '?perfhud=1' });
    try {
        const keysBefore = Object.keys(globalThis.window);
        const tools = startPerfTools(fakeModule());

        assert.deepEqual(Object.keys(globalThis.window), keysBefore, 'no window.pm* assignment');
        assert.equal(countWasmCallbackSubscribers('pmOnPerfFrame'), 1);
        assert.equal(countWasmCallbackSubscribers('pmSetPerfHudEnabled'), 1);

        tools.dispose();
        assert.equal(countWasmCallbackSubscribers('pmOnPerfFrame'), 0);
        assert.equal(countWasmCallbackSubscribers('pmSetPerfHudEnabled'), 0);
        assert.equal('pmOnPerfFrame' in globalThis, false, 'the last listener gives the engine hook back');
        assert.equal('pmSetPerfHudEnabled' in globalThis, false);
    } finally {
        dom.restore();
    }
});

test('running setup again for the same module replaces the old subscription', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=1' });
    const module = fakeModule();
    try {
        startPerfTools(module);
        startPerfTools(module);
        assert.equal(countWasmCallbackSubscribers('pmOnPerfFrame'), 1, 'a retried init must not stack listeners');

        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.posted.length, 1, 'one benchmark collector, so one report');
    } finally {
        dom.restore();
    }
});

test('two modules each keep their own listener, and disposing one leaves the other', () => {
    const dom = installFakeDom({ search: '?benchmark=1&frames=1' });
    try {
        const first = startPerfTools(fakeModule());
        startPerfTools(fakeModule());
        assert.equal(countWasmCallbackSubscribers('pmOnPerfFrame'), 2);

        first.dispose();
        assert.equal(countWasmCallbackSubscribers('pmOnPerfFrame'), 1);
        assert.equal(typeof globalThis.pmOnPerfFrame, 'function', 'the second setup still hears the engine');

        globalThis.pmOnPerfFrame(frame());
        assert.equal(dom.posted.length, 1, 'only the surviving controller reported');
    } finally {
        dom.restore();
    }
});

test('a disposed controller stops sampling and ends the crossfade pump', async () => {
    const dom = installFakeDom({ search: '?benchmark=1&crossfade=1&frames=5&crossfadePresets=a.milk' });
    const module = fakeModule();
    try {
        const tools = startPerfTools(module);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const loadsBefore = module.ccalls.length;
        assert.ok(loadsBefore >= 1, 'the pump loaded a preset');

        tools.dispose();
        // The pump sleeps 100 ms per iteration; after that it must have exited
        // rather than keep loading presets for a controller nobody owns.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const loadsAfter = module.ccalls.length;
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(module.ccalls.length, loadsAfter, 'no more preset loads after dispose');
    } finally {
        dom.restore();
    }
});
