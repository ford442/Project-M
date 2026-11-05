// Part of the render worker (html/projectm-render-worker.js), which loads it with
// importScripts() before it handles any message. A classic script: no imports, no
// top-level state of its own beyond the one factory it publishes on `self`.
//
// The engine-to-host relays: the globalThis hooks the C++ side calls (governor
// render scale, perf HUD frames, rhythm events), forwarded to the host.

/**
 * @typedef {object} EngineHookDeps
 * @property {() => number} getEngineHost This worker's engine handle, 0 until it exists.
 * @property {(message: RenderWorkerMessage) => void} postToHost
 * @property {(scale: number) => void} setRenderScale Applies a governor render-scale change.
 */

/**
 * @param {EngineHookDeps} deps
 */
function installWorkerEngineHooks(deps) {
    const { postToHost } = deps;

    /**
     * The engine-to-host hooks the C++ side looks up on `globalThis` — in a worker,
     * this scope (see WasmPerfGovernor.cpp / WasmRhythm.cpp).
     *
     * @typedef {object} EngineHooks
     * @property {(...args: unknown[]) => void} [pmOnGovernorRenderScaleChange]
     * @property {(stats: PerfFrameStats) => void} [pmOnPerfFrame]
     * @property {(...args: unknown[]) => void} [pmSetPerfHudEnabled]
     * @property {(event: RhythmEvent) => void} [pmOnRhythmEvent]
     */

    /** `self`, with the engine hooks this worker publishes on it. */
    const hookScope = /** @type {typeof self & EngineHooks} */ (self);

    /**
     * Reads an engine callback in either bundle shape — 040+ passes the engine's
     * handle first, older ones only the payload (`fieldCount` values) — and says
     * whether it is about this worker's engine. Mirrors decodeWasmCallback() in
     * html/projectm-wasm-callbacks.js; duplicated because this classic worker
     * cannot import it.
     *
     * @param {unknown[]} args
     * @param {number} fieldCount
     * @returns {{ ours: boolean, values: unknown[] }}
     */
    function engineCallback(args, fieldCount) {
        const scoped = args.length > fieldCount;
        const host = scoped ? Number(args[0]) : null;
        // Before create_host_with_config() returns, engineHost is still 0 and the
        // engine being created is the only one there is.
        const engineHost = deps.getEngineHost();
        const ours = host === null || !engineHost || host === engineHost;
        return { ours, values: scoped ? args.slice(1) : args };
    }

    // WasmPerfGovernor.cpp pushes tier changes through globalThis — which in a
    // worker is this scope, not a window. That is the whole point of the
    // globalThis migration in src/wasm/: the same C++ hook reaches the host in
    // either topology, and governor v2 is no longer main-thread-only.
    /** @param {unknown[]} args `(host, scale)`, or `(scale)` before bundle 040. */
    const onGovernorRenderScaleChange = (...args) => {
        const { ours, values } = engineCallback(args, 1);
        if (!ours) return;
        deps.setRenderScale(Number(values[0]) || 1);
    };
    hookScope.pmOnGovernorRenderScaleChange = onGovernorRenderScaleChange;

    // The perf HUD (html/projectm-perf.js) lives on the page, but the engine reports
    // to `globalThis.pmOnPerfFrame` / `pmSetPerfHudEnabled` — this scope. Relay both,
    // so `?perfhud=1` works in the default topology rather than only with
    // `?renderWorker=0`.
    //
    // Frames are batched: the HUD repaints at most every 200 ms, and a postMessage
    // per frame would be 60+ structured clones a second for nothing. A benchmark
    // still sees every frame, because the host replays the batch in order.
    const PERF_FLUSH_INTERVAL_MS = 100;
    /** @type {PerfFrameStats[]} */
    let perfFrames = [];
    let perfLastFlush = 0;

    function flushPerfFrames() {
        if (perfFrames.length === 0) return;
        const frames = perfFrames;
        perfFrames = [];
        perfLastFlush = performance.now();
        postToHost({ type: 'perf-frames', frames });
    }

    /** @param {PerfFrameStats} stats */
    const onPerfFrame = (stats) => {
        const engineHost = deps.getEngineHost();
        if (typeof stats?.host === 'number' && engineHost && stats.host !== engineHost) return;
        perfFrames.push(stats);
        if (performance.now() - perfLastFlush >= PERF_FLUSH_INTERVAL_MS) {
            flushPerfFrames();
        }
    };
    hookScope.pmOnPerfFrame = onPerfFrame;

    /** @param {unknown[]} args `(host, enabled)`, or `(enabled)` before bundle 040. */
    const onPerfHudEnabled = (...args) => {
        const { ours, values } = engineCallback(args, 1);
        if (!ours) return;
        const enabled = !!values[0];
        if (!enabled) {
            // Whatever is buffered was measured; hand it over before the HUD goes.
            flushPerfFrames();
        }
        postToHost({ type: 'perf-hud', enabled });
    };
    hookScope.pmSetPerfHudEnabled = onPerfHudEnabled;

    // Beat/bar/section events (src/wasm/WasmRhythm.cpp) land in this scope too.
    // Relayed one by one: the engine only reports frames that carry an event, a few
    // a second, and batching them would make every beat arrive late.
    /** @param {RhythmEvent} event */
    const onRhythmEvent = (event) => {
        const engineHost = deps.getEngineHost();
        if (engineHost && event.host !== engineHost) return;
        postToHost({ type: 'rhythm-event', event: { ...event } });
    };
    hookScope.pmOnRhythmEvent = onRhythmEvent;

    return { flushPerfFrames };
}

// `self` is the worker global in a real worker, but not in a bundler-wrapped or
// node:vm scope: publish on it explicitly so the entry script finds it.
self.installWorkerEngineHooks = installWorkerEngineHooks;
