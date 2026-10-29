// Lifecycle of ProjectMContext: overlapping start(), destroy() during a boot, a
// start that fails part-way, and two contexts on one page where one is
// destroyed. Every test ends by asking what is still there — workers,
// BroadcastChannels, window listeners, process-wide globals — because that is
// where these bugs live: the functional behaviour was always fine.
//
// Run with: node --test tests/web/context-lifecycle.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { PRESET_SWITCH_FAILED, ProjectMContext } from '../../html/projectm-context.js';
import {
    createAudioSourceRouter,
    getHostAudioSourceRouter,
    setHostAudioSourceRouter,
} from '../../html/projectm-audio-source-router.js';
import {
    getExternalPcmReceiverCount,
    resetExternalPcmStateForTests,
} from '../../html/projectm-external-pcm.js';
import { countWasmCallbackSubscribers } from '../../html/projectm-wasm-callbacks.js';
import { hideInitError } from '../../html/projectm-init-errors.js';
import { setupPresetTweaker } from '../../html/projectm-preset-tweaker.js';
import { setupAudioTestPanel } from '../../html/projectm-synthetic-audio.js';
import { installLifecycleEnv, isCreateHostCall, makeFakeModule } from './helpers/lifecycle-env.mjs';
import {
    CONTEXT_CONFIG_FLAGS,
    CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT,
    CONTEXT_SNAPSHOT_BITS,
    CONTEXT_SNAPSHOT_POWER_SHIFT,
} from '../../html/projectm-context-config.js';
import { CANVAS_REPLACED_EVENT } from '../../html/context/boot.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits (in macrotasks) until `condition()` holds, for up to `timeoutMs`. */
async function until(condition, what = 'condition', timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await tick();
    }
    if (condition()) return;
    assert.fail(`timed out waiting for ${what}`);
}

/** A promise a test settles by hand. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * Runs `body` inside a fresh environment and always leaves the process-wide
 * modules (external PCM, router registry) and the globals as it found them.
 * Contexts created through `env.newContext` are destroyed even if the test fails.
 */
async function withEnv(options, body) {
    const env = installLifecycleEnv(options);
    /** @type {ProjectMContext[]} */
    const contexts = [];
    env.newContext = (extra = {}) => {
        const canvas = env.makeCanvas(extra.canvasId);
        const context = new ProjectMContext({
            canvas,
            container: canvas.parentElement,
            windowRef: env.window,
            documentRef: env.document,
            requireCrossOriginIsolation: false,
            ...extra,
        });
        contexts.push(context);
        return context;
    };
    try {
        await body(env);
    } finally {
        for (const context of contexts) context.destroy();
        hideInitError();
        resetExternalPcmStateForTests();
        setHostAudioSourceRouter(null);
        env.restore();
    }
}

/** Options that boot a Module in-process through a fake factory (main-thread topology). */
function mainTopology(env, factory) {
    env.window.createModule = factory;
    return { renderTopology: 'main', wasmScriptUrl: 'https://cdn.test/pm/projectm.js', wasmBaseUrl: 'https://cdn.test/pm/' };
}

/** Everything the page must be free of once no context is left. */
function assertNothingLeft(env, message = '') {
    const prefix = message ? `${message}: ` : '';
    assert.deepEqual(env.windowLedger.outstanding(), {}, `${prefix}window still has listeners`);
    assert.deepEqual(env.allListeners.outstanding(), {}, `${prefix}some fake target still has listeners`);
    assert.equal(env.openChannels().length, 0, `${prefix}a BroadcastChannel was left open`);
    assert.equal(env.liveWorkers().length, 0, `${prefix}a Worker was left running`);
    assert.equal(env.pendingFrames(), 0, `${prefix}an animation frame is still scheduled`);
    assert.equal(getExternalPcmReceiverCount(), 0, `${prefix}an external PCM receiver is still open`);
    assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange', env.window), 0, `${prefix}the governor hook is still subscribed`);
    assert.equal('pmOnGovernorRenderScaleChange' in env.window, false, `${prefix}the governor global was left installed`);
    assert.equal('Module' in env.window, false, `${prefix}window.Module was left pointing at a destroyed engine`);
    assert.equal(globalThis.projectMWritePcmRing, undefined, `${prefix}the PCM writer global was left installed`);
    assert.equal(globalThis.projectMLoadSongIntoWorklet, undefined, `${prefix}the song-load hook was left installed`);
    assert.equal(getHostAudioSourceRouter(), null, `${prefix}a router is still registered`);
}

// ---- start() is idempotent ----------------------------------------------------

test('overlapping start() calls share one boot and boot one Module', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const factory = deferred();
        let factoryCalls = 0;
        const context = env.newContext(mainTopology(env, () => { factoryCalls += 1; return factory.promise; }));

        const first = context.start();
        const second = context.start();
        assert.equal(first, second, 'concurrent callers must get the same promise');

        await until(() => factoryCalls > 0, 'the module factory to be called');
        factory.resolve(module);
        const [a, b] = await Promise.all([first, second]);

        assert.equal(factoryCalls, 1, 'two overlapping start() calls booted two Modules');
        assert.equal(a, context);
        assert.equal(b, context);
        assert.equal(context.ready, true);
        assert.equal(module.calls.filter((call) => call.name === 'create_host_with_config').length, 1);

        assert.equal(await context.start(), context, 'once ready, start() resolves immediately');
        assert.equal(factoryCalls, 1);

        context.destroy();
        assertNothingLeft(env, 'after destroy');
    });
});

test('after a failed start, a later start() boots again from scratch', async () => {
    await withEnv({}, async (env) => {
        const errors = [];
        const good = makeFakeModule();
        const bad = makeFakeModule({ hostHandle: 0, initError: 2 });
        let calls = 0;
        const context = env.newContext({
            ...mainTopology(env, async () => (++calls === 1 ? bad : good)),
            onError: (detail) => errors.push(detail),
        });

        await assert.rejects(() => context.start(), /projectM init failed \(init code 2\)/);
        assert.equal(errors[0].code, 2, 'the init code reaches onError, not a generic -1');
        assert.equal(context.ready, false);
        assert.equal(context.destroyed, false, 'a failed start is not a destroy');
        assert.equal(bad.destructed, true, 'the half-booted Module must be freed');
        assert.equal(context.module, null);

        await context.start();
        assert.equal(context.ready, true);
        assert.equal(calls, 2);
        assert.equal(errors.length, 1, 'only the failed attempt reports an error');

        context.destroy();
        assertNothingLeft(env);
    });
});

// ---- destroy() during a boot --------------------------------------------------

test('destroy() while the Module factory is running aborts start() and frees the Module', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const factory = deferred();
        let called = false;
        const errors = [];
        let ready = 0;
        const context = env.newContext({
            ...mainTopology(env, () => { called = true; return factory.promise; }),
            onError: (detail) => errors.push(detail),
            onReady: () => { ready += 1; },
        });

        const started = context.start();
        await until(() => called, 'the module factory to be called');

        context.destroy();
        factory.resolve(module);

        await assert.rejects(started, (error) => error.name === 'AbortError');
        assert.equal(context.ready, false, 'a destroyed context must not become ready');
        assert.equal(ready, 0, 'onReady must not fire for a destroyed context');
        assert.deepEqual(errors, [], 'cancelling a boot is not a failure to report');
        assert.equal(module.destructed, true, 'a Module that arrives after destroy() must still be freed');
        assert.equal(module.calls.some((call) => call.name === 'init_with_canvases'), false, 'and must not be initialised');
        assert.equal(context.module, null);
        assertNothingLeft(env);
    });
});

test('destroy() while the glue script is being resolved aborts start() without booting anything', async () => {
    await withEnv({}, async (env) => {
        let factoryCalls = 0;
        // The HEAD probe hangs until aborted.
        const probe = deferred();
        globalThis.fetch = (_url, init) => {
            init?.signal?.addEventListener('abort', () => probe.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            return probe.promise;
        };
        env.window.createModule = () => { factoryCalls += 1; return makeFakeModule(); };
        const context = env.newContext({ renderTopology: 'main', wasmBaseUrl: 'https://cdn.test/pm/' });

        const started = context.start();
        await tick();
        context.destroy();

        await assert.rejects(started, (error) => error.name === 'AbortError');
        assert.equal(factoryCalls, 0);
        assertNothingLeft(env);
    });
});

test('start() after destroy() rejects, and destroy() is idempotent', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext({ sharedModule: makeFakeModule() });
        const destroyed = [];
        context.events.addEventListener('destroy', () => destroyed.push(1));

        context.destroy();
        context.destroy();

        assert.equal(destroyed.length, 1, 'the destroy event fires once');
        await assert.rejects(() => context.start(), /destroyed/);
    });
});

// ---- render worker -----------------------------------------------------------

/** Options that boot the render worker; the test drives the worker's messages. */
function workerTopology() {
    return { renderTopology: 'worker', wasmScriptUrl: 'https://cdn.test/pm/projectm.js', wasmBaseUrl: 'https://cdn.test/pm/' };
}

test('a render worker that errors before it is ready is terminated, and the failure is reported once', async () => {
    await withEnv({}, async (env) => {
        const errors = [];
        const context = env.newContext({ ...workerTopology(env), onError: (detail) => errors.push(detail) });

        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'error', message: 'importScripts failed' });

        await assert.rejects(started, /worker could not start/);
        assert.equal(env.workers[0].terminated, true, 'the worker leaked: nothing else holds its handle');
        assert.equal(errors.length, 1);
        assertNothingLeft(env);
    });
});

test('a render worker whose boot throws after createModule() makes start() reject, well inside the deadline', async () => {
    await withEnv({}, async (env) => {
        const reasons = [];
        const context = env.newContext({
            ...workerTopology(env),
            renderWorkerBootTimeoutMs: 5000,
            onRenderWorkerFallback: (reason) => reasons.push(reason),
        });

        const startedAt = Date.now();
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        // What the worker posts when create_host_with_config() (or anything after
        // createModule() resolved) throws — before, an unhandled rejection that
        // left start() waiting for a 'ready' that never came.
        env.workers[0].emit({ type: 'init-error', code: 6, message: 'render worker init threw: RuntimeError: unreachable' });

        await assert.rejects(started, /worker could not start/);
        assert.ok(Date.now() - startedAt < 5000, 'rejected on the init-error, not by waiting out the deadline');
        assert.equal(reasons.length, 1);
        assert.match(reasons[0], /failed to boot \(init code 6\): render worker init threw/);
        assert.equal(env.workers[0].terminated, true);
        assertNothingLeft(env);
    });
});

test('auto topology: a render worker that never answers is abandoned at the deadline and start() renders on the main thread', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const reasons = [];
        const context = env.newContext({
            ...mainTopology(env, async () => module),
            renderTopology: 'auto',
            renderWorkerBootTimeoutMs: 20,
            onRenderWorkerFallback: (reason) => reasons.push(reason),
        });
        const originalCanvas = context.canvas;
        const container = originalCanvas.parentElement;

        await context.start();

        assert.equal(env.workers.length, 1);
        assert.equal(env.workers[0].terminated, true, 'the wedged worker was terminated');
        assert.match(reasons[0], /did not report ready within 20 ms/);
        assert.equal(context.transport.topology, 'main');
        // The worker took the original canvas for good; the fallback draws into a copy.
        assert.equal(originalCanvas.transferred, true);
        assert.notEqual(context.canvas, originalCanvas);
        assert.equal(context.canvas.transferred, false);
        assert.equal(context.canvas.id, originalCanvas.id, 'the copy keeps the selector the engine resolves');
        assert.equal(container.children.includes(context.canvas), true);
        assert.equal(container.children.includes(originalCanvas), false);

        context.destroy();
        assertNothingLeft(env);
    });
});

test('auto topology: an init-error falls back to the main thread at once', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const reasons = [];
        const context = env.newContext({
            ...mainTopology(env, async () => module),
            renderTopology: 'auto',
            onRenderWorkerFallback: (reason) => reasons.push(reason),
        });

        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'init-error', code: -1, message: 'module init failed: Error: out of memory' });
        await started;

        assert.equal(context.transport.topology, 'main');
        assert.match(reasons[0], /init code -1/);
        assert.ok(module.calls.some((call) => isCreateHostCall(call.name) || call.name === '_init'),
            'the main-thread engine was created');
        context.destroy();
        assertNothingLeft(env);
    });
});

test('destroy() after the worker is up shuts it down before terminating it', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready', host: 1 });
        await started;

        context.destroy();

        assert.ok(env.workers[0].messages.some((message) => message.type === 'shutdown'),
            'the worker was asked to destruct its engine');
        assert.equal(env.workers[0].terminated, true, 'and terminated on its answer');
        assertNothingLeft(env);
    });
});

test('destroy() terminates a worker that never answers shutdown, at the shutdown deadline', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].answersShutdown = false;
        env.workers[0].emit({ type: 'ready', host: 1 });
        await started;

        context.destroy();
        assert.equal(env.workers[0].terminated, false, 'given a moment to shut down');
        await until(() => env.workers[0].terminated, 'the shutdown deadline to terminate the worker');
        assertNothingLeft(env);
    });
});

test('destroy() while the render worker is booting terminates it', async () => {
    await withEnv({}, async (env) => {
        const errors = [];
        const context = env.newContext({ ...workerTopology(env), onError: (detail) => errors.push(detail) });

        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        context.destroy();

        await assert.rejects(started, (error) => error.name === 'AbortError');
        assert.equal(env.workers[0].terminated, true);
        assert.deepEqual(errors, []);
        assertNothingLeft(env);
    });
});

test('a start that fails after the worker is up terminates the worker and releases every listener', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const errors = [];
        // A failing preset fetch is the last step of start(), after everything is wired.
        globalThis.fetch = async (url) => (String(url).endsWith('.milk')
            ? { ok: false, status: 404 }
            : { ok: true, redirected: false, url: String(url), headers: { get: () => 'application/javascript' } });
        const context = env.newContext({
            ...workerTopology(env),
            audioSource: 'external',
            presetUrl: 'https://cdn.test/presets/missing.milk',
            onError: (detail) => errors.push(detail),
        });

        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready' });

        await assert.rejects(started, /Failed to fetch preset \(404\)/);

        assert.equal(env.workers[0].terminated, true, 'a failed start leaked its Worker');
        assert.equal(errors.length, 1, 'one failure, one onError');
        assert.equal(context.ready, false);
        assert.equal(context.transport, null);
        assertNothingLeft(env, 'after the failed start');
    });
});

// ---- a start that fails after everything is wired -------------------------------

test('a failing start leaves 0 workers, 0 listeners, 0 channels and no globals behind', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const module = makeFakeModule();
        const errors = [];
        let presetChanged = 0;
        const context = env.newContext({
            sharedModule: module,
            audioSource: 'external',
            // No `module.FS` on the fake, so this fails last — after the router,
            // receiver, context-loss handlers, resize listener and hooks exist.
            presetUrl: 'https://cdn.test/presets/x.milk',
            onError: (detail) => errors.push(detail),
            onPresetChanged: () => { presetChanged += 1; },
            onFps: () => {},
        });

        await assert.rejects(() => context.start(), /Module\.FS not available/);

        assert.equal(errors.length, 1);
        assert.equal(context.ready, false);
        assert.equal(context.hostHandle, 0);
        assert.ok(module.calls.some((call) => call.name === 'destroy_host'), "the failed start's engine must be released");
        assertNothingLeft(env);
        env.window.dispatch('pm:preset-loaded', { detail: {} });
        assert.equal(presetChanged, 0, 'the preset listener must be gone');
    });
});

test('a start that fails validation before touching anything reports one error and leaves nothing', async () => {
    await withEnv({ crossOriginIsolated: false }, async (env) => {
        const errors = [];
        const context = env.newContext({ requireCrossOriginIsolation: true, sharedModule: makeFakeModule(), onError: (detail) => errors.push(detail) });

        await assert.rejects(() => context.start(), /Cross-origin isolation/);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 4);
        assertNothingLeft(env);
    });
});

test('create_host_with_config() failure is reported once, with its own code', async () => {
    await withEnv({}, async (env) => {
        const errors = [];
        const seen = [];
        const context = env.newContext({ sharedModule: makeFakeModule({ hostHandle: 0 }), onError: (detail) => errors.push(detail) });
        context.events.addEventListener('error', (event) => seen.push(event.detail));

        await assert.rejects(() => context.start(), /create_host_with_config\(\) failed \(init code 4/);

        assert.equal(errors.length, 1, 'it used to be reported here and again by the outer handler');
        assert.equal(errors[0].code, 4);
        assert.equal(seen.length, 1, 'the per-instance event fires once too');
        assertNothingLeft(env);
    });
});

// ---- a healthy context cleans up after itself ----------------------------------

test('a started context leaves no listeners, channels, frames or globals after destroy()', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const module = makeFakeModule();
        const context = env.newContext({
            sharedModule: module,
            audioSource: 'external',
            onPresetChanged: () => {},
            onFps: () => {},
        });

        await context.start();
        assert.equal(context.ready, true);
        // Prove the wiring exists, so the balance check below is not vacuous.
        assert.ok(Object.keys(env.windowLedger.outstanding()).length > 0, 'expected the context to attach window listeners');
        assert.equal(env.openChannels().length > 0, true, 'expected open BroadcastChannels while running');
        assert.equal(env.pendingFrames(), 1, 'the fps monitor schedules a frame');
        assert.equal(getExternalPcmReceiverCount(), 1);

        context.destroy();
        assertNothingLeft(env);
        assert.ok(env.windowLedger.adds > 0 && env.windowLedger.adds === env.windowLedger.removes, 'every listener added was removed');
    });
});

test('setups a page hands to own() are disposed by destroy(): the listener ledger is empty after', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const module = makeFakeModule();
        const context = env.newContext({ sharedModule: module, audioSource: 'external' });
        await context.start();

        const panel = context.own(setupAudioTestPanel(module, { documentRef: env.document, search: '?audioTest=1' }));
        assert.ok(panel.element, 'the audio test panel was built');
        const tweaker = context.own(setupPresetTweaker({ onApply: () => {}, documentRef: env.document }));
        assert.ok(tweaker);
        let plainDisposed = 0;
        const onKey = () => {};
        env.window.addEventListener('keydown', onKey);
        context.own(() => {
            plainDisposed += 1;
            env.window.removeEventListener('keydown', onKey);
        });
        assert.ok(env.allListeners.adds > env.allListeners.removes, 'the setups attached listeners');

        context.destroy();
        assertNothingLeft(env);
        assert.equal(plainDisposed, 1);
        assert.equal(env.document.getElementById('pm-audio-test'), null, 'the panel left the page');

        // Owned after destroy: undone at once rather than leaked.
        let late = 0;
        context.own({ dispose: () => { late += 1; } });
        assert.equal(late, 1);
    });
});

test('start/destroy cycles do not accumulate listeners or channels', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        for (let cycle = 0; cycle < 4; cycle += 1) {
            const context = env.newContext({ sharedModule: makeFakeModule(), audioSource: 'external' });
            await context.start();
            context.destroy();
        }
        assertNothingLeft(env);
        assert.equal(env.windowLedger.adds, env.windowLedger.removes);
    });
});

test('the fallback resize listener is attached to the context\'s window and removed on destroy', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const context = env.newContext({ sharedModule: makeFakeModule() });
        await context.start();
        assert.equal(env.windowLedger.outstanding().resize, 1);

        let resizes = 0;
        context.resize = () => { resizes += 1; };
        env.window.dispatch('resize');
        assert.equal(resizes, 1);

        context.destroy();
        assert.equal(env.windowLedger.outstanding().resize, undefined);
        env.window.dispatch('resize');
        assert.equal(resizes, 1, 'a destroyed context must not react to resizes');
    });
});

test('resize() follows the window\'s live devicePixelRatio unless the host pinned one', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext({ sharedModule: makeFakeModule() });
        await context.start();
        env.window.devicePixelRatio = 2; // browser zoom, or a move to a HiDPI display
        context.resize();
        assert.equal(context.canvas.width, 1280);
        assert.equal(context.canvas.style.width, '640px');
        context.destroy();

        const pinned = env.newContext({ sharedModule: makeFakeModule(), devicePixelRatio: 1 });
        await pinned.start();
        pinned.resize();
        assert.equal(pinned.canvas.width, 640, 'an explicit devicePixelRatio option still wins');
        pinned.destroy();
    });
});

test('the ResizeObserver is disconnected on destroy', async () => {
    await withEnv({ withResizeObserver: true }, async (env) => {
        const context = env.newContext({ sharedModule: makeFakeModule() });
        await context.start();
        const observer = globalThis.ResizeObserver.instances[0];
        assert.equal(observer.observing, 1);

        context.destroy();
        assert.equal(observer.observing, 0);
    });
});

test('context.events reports ready, audio-source and destroy for this context only', async () => {
    await withEnv({}, async (env) => {
        const log = [];
        const context = env.newContext({ sharedModule: makeFakeModule() });
        for (const type of ['ready', 'audio-source', 'destroy']) {
            context.events.addEventListener(type, (event) => log.push([type, event.detail?.activeSource]));
        }

        await context.start();
        context.setAudioSource('external');
        context.destroy();

        assert.deepEqual(log, [['ready', undefined], ['audio-source', 'external'], ['destroy', undefined]]);
    });
});

// ---- the media element -----------------------------------------------------------

/** An AudioContext + worklet stand-in, and a media element whose source node is observable. */
function installAudioGraph({ withNode }) {
    const created = [];
    const ctx = {
        state: 'running',
        addEventListener() {},
        removeEventListener() {},
        createMediaElementSource(element) {
            const source = { element, connected: 0, disconnected: 0, connect() { this.connected += 1; }, disconnect() { this.disconnected += 1; } };
            created.push(source);
            return source;
        },
        audioWorklet: { addModule: async () => {} },
    };
    globalThis.projectMAudioContext_Global_Cpp = ctx;
    globalThis.projectMWorkletNode_Global_Cpp = withNode ? { port: { postMessage() {} } } : null;
    return {
        created,
        cleanup() {
            delete globalThis.projectMAudioContext_Global_Cpp;
            delete globalThis.projectMWorkletNode_Global_Cpp;
            delete globalThis.projectMWorkletReady;
            delete globalThis.projectMConnectMediaElement;
        },
    };
}

test('a media element is connected while the context runs and disconnected when it is destroyed', async () => {
    await withEnv({}, async (env) => {
        const graph = installAudioGraph({ withNode: true });
        try {
            const media = env.document.createElement('audio');
            const context = env.newContext({ sharedModule: makeFakeModule(), audioSource: 'element', audioElement: media });
            await context.start();
            await until(() => graph.created.length === 1, 'the media element to be connected');
            assert.equal(graph.created[0].connected, 1);

            context.destroy();
            assert.equal(graph.created[0].disconnected, 1, 'a destroyed context must not keep its element wired into the worklet');
        } finally {
            graph.cleanup();
        }
    });
});

test('destroy() before the worklet is ready stops the media element being connected afterwards', async () => {
    await withEnv({}, async (env) => {
        const graph = installAudioGraph({ withNode: false });
        try {
            // The engine's own worklet setup is still in flight.
            const engineSetup = deferred();
            globalThis.projectMWorkletReady = engineSetup.promise;

            const media = env.document.createElement('audio');
            const context = env.newContext({ sharedModule: makeFakeModule(), audioSource: 'element', audioElement: media });
            await context.start();

            context.destroy();
            // The worklet finishes booting after the context is gone.
            globalThis.projectMWorkletNode_Global_Cpp = { port: { postMessage() {} } };
            engineSetup.resolve(globalThis.projectMWorkletNode_Global_Cpp);
            await tick();
            await tick();

            assert.equal(graph.created.length, 0, 'ensureWorkletReady().then(connect) fired for a destroyed context');
        } finally {
            graph.cleanup();
        }
    });
});

// ---- two contexts on one page ------------------------------------------------------

// ---- Flash limiter (#286) ---------------------------------------------------------
//
// A viewer who needs the limiter must never be shown an unlimited frame, so it
// is switched on before the engine renders anything — on this thread before
// start_render(), in the worker from its init message.

test('the flashLimit option is applied to the context\'s engine before it renders', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule({ hostHandle: 31 });
        const context = env.newContext({ sharedModule: module, flashLimit: { threshold: 0.05 } });
        await context.start();

        const order = module.engineCalls
            .filter((call) => ['_set_flash_limit_threshold', '_set_flash_limit_enabled', '_start_render'].includes(call.name));
        assert.deepEqual(order.map((call) => [call.name, call.host]), [
            ['_set_flash_limit_threshold', 31],
            ['_set_flash_limit_enabled', 31],
            ['_start_render', 31],
        ]);
        const enabled = module.calls.find((call) => call.name === '_set_flash_limit_enabled');
        assert.deepEqual(enabled?.args, [1]);
    });
});

test('without the flashLimit option the engine\'s limiter is left alone', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const context = env.newContext({ sharedModule: module, flashLimit: false });
        await context.start();
        assert.equal(module.calls.some((call) => call.name.startsWith('_set_flash_limit')), false);
    });
});

test('in the worker topology the flash limit travels with the init message', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext({ ...workerTopology(env), flashLimit: true });
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        const init = env.workers[0].messages.find((message) => message.type === 'init');
        assert.deepEqual(init?.flashLimit, { enabled: true });
        env.workers[0].emit({ type: 'ready', host: 3 });
        await started;
        assert.equal(env.workers[0].messages.some((message) => message.type === 'set-flash-limit'), false,
            'not sent a second time after ready');

        context.setFlashLimit(false);
        assert.deepEqual(env.workers[0].messages.at(-1), { type: 'set-flash-limit', enabled: false, host: 3 });
    });
});

test('two contexts on one shared Module each get the context config they asked for', async () => {
    await withEnv({}, async (env) => {
        // Models the C++ registry: a host's config is whatever its create call
        // carried. set_context_config() would be the old process-wide slot,
        // consumed by whichever create came next.
        /** @type {Map<number, unknown[]>} */
        const configByHandle = new Map();
        let legacySlot = null;
        let nextHandle = 20;
        /** @type {Promise<unknown> | null} */
        let bStart = null;
        /** @type {any} */
        let b = null;
        const module = makeFakeModule({
            onCall: (name, args) => {
                if (name === 'set_context_config') {
                    legacySlot = args;
                    return 0;
                }
                if (name === 'create_host_with_config') {
                    const handle = nextHandle++;
                    configByHandle.set(handle, args.slice(2));
                    // Start the second context from a microtask queued in
                    // between: under the old configure-then-create protocol
                    // this is where B's config could replace A's.
                    if (bStart === null) queueMicrotask(() => { bStart = b.start(); });
                    return handle;
                }
                if (name === 'create_host') {
                    const handle = nextHandle++;
                    configByHandle.set(handle, legacySlot);
                    return handle;
                }
                return undefined;
            },
        });
        const a = env.newContext({ sharedModule: module, canvasId: 'pm-a', fboPrecision: 'half', antialias: false });
        b = env.newContext({ sharedModule: module, canvasId: 'pm-b', fboPrecision: 'byte', antialias: true });

        await a.start();
        await until(() => bStart !== null, 'the second start() to be queued');
        await bStart;

        assert.equal(module.calls.filter((call) => call.name === 'set_context_config').length, 0);
        assert.notEqual(a.hostHandle, b.hostHandle);
        // [flags, powerPreference, fboPrecision]: 32 = premultipliedAlpha, +1 antialias.
        assert.deepEqual(configByHandle.get(a.hostHandle), [32, 2, 0]);
        assert.deepEqual(configByHandle.get(b.hostHandle), [33, 2, 2]);
    });
});

/** Two contexts, each with its own shared Module and host handle. */
async function startPair(env, extra = {}) {
    let nextHandle = 10;
    const moduleA = makeFakeModule({ onCall: (name) => (isCreateHostCall(name) ? nextHandle++ : undefined) });
    const moduleB = makeFakeModule({ onCall: (name) => (isCreateHostCall(name) ? nextHandle++ : undefined) });
    const a = env.newContext({ sharedModule: moduleA, canvasId: 'pm-a', ...extra });
    const b = env.newContext({ sharedModule: moduleB, canvasId: 'pm-b', ...extra });
    await a.start();
    await b.start();
    return { a, b, moduleA, moduleB };
}

// ---- two engines in ONE Module: events and calls stay with their engine ----------
//
// kMaxHosts is 2: embed-multi-same-module.html runs two engines in one Module.
// Every engine callback is one global name for both, so the handle the engine
// passes (bundle 040+) is the only thing that says whose it is; and almost every
// export acts on the *active* engine, so a call that resumes after an await has
// to select its own again.

/** Two contexts sharing one Module, as embed-multi-same-module.html runs them. */
async function startSharedPair(env, { extraA = {}, extraB = {} } = {}) {
    let nextHandle = 30;
    const module = makeFakeModule({ onCall: (name) => (isCreateHostCall(name) ? nextHandle++ : undefined) });
    const a = env.newContext({ sharedModule: module, canvasId: 'pm-a', ...extraA });
    const b = env.newContext({ sharedModule: module, canvasId: 'pm-b', ...extraB });
    await a.start();
    await b.start();
    assert.notEqual(a.hostHandle, b.hostHandle);
    return { a, b, module };
}

/** A preset fetch the test releases by hand; restored with the environment. */
function gatedPresetFetch() {
    const gate = deferred();
    globalThis.fetch = async () => {
        await gate.promise;
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    return gate;
}

test('two engines in one Module: a governor scale change resizes only its own engine\'s canvas', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b } = await startSharedPair(env);
        const resizes = { a: 0, b: 0 };
        a.resize = () => { resizes.a += 1; };
        b.resize = () => { resizes.b += 1; };

        // js_governor_report_render_scale(host, scale): engine A dropped a tier.
        env.window.pmOnGovernorRenderScaleChange(a.hostHandle, 0.5);
        assert.deepEqual(resizes, { a: 1, b: 0 }, 'B\'s canvas used to resize too');
        assert.equal(a.renderScale, 0.5);
        assert.equal(b.renderScale, 1, 'B stays at its own tier');

        env.window.pmOnGovernorRenderScaleChange(b.hostHandle, 0.75);
        assert.deepEqual(resizes, { a: 1, b: 1 });
        assert.equal(a.renderScale, 0.5, 'and A keeps its own');
        assert.equal(b.renderScale, 0.75);

        // A bundle before 040 cannot say which engine: both hear it, as before.
        env.window.pmOnGovernorRenderScaleChange(1);
        assert.deepEqual(resizes, { a: 2, b: 2 });
    });
});

test('two engines in one Module: an init failure reaches only the engine that failed', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const errors = { a: [], b: [] };
        const { a, b } = await startSharedPair(env, {
            extraA: { onError: (detail) => errors.a.push(detail) },
            extraB: { onError: (detail) => errors.b.push(detail) },
        });

        // js_notify_init_error(host, code, detail): A's re-init (a context-loss
        // recovery, say) found no WebGL 2.
        env.window.pmReportInitError(a.hostHandle, 2, 'WebGL 2 unavailable');
        assert.deepEqual(errors.a.map((detail) => detail.code), [2]);
        assert.match(errors.a[0].message, /init code 2.*WebGL 2 unavailable/);
        assert.deepEqual(errors.b, [], 'B\'s onError must not fire for A\'s code');

        env.window.pmReportInitError(b.hostHandle, 6, 'Primary canvas selector not found in document');
        assert.deepEqual(errors.b.map((detail) => detail.code), [6]);
        assert.equal(errors.a.length, 1);

        // Not anyone's failure to report: the context is still lost (5), a
        // create refused at the instance cap before any engine existed (-1),
        // and a pre-040 call that cannot say whose it was.
        env.window.pmReportInitError(a.hostHandle, 5, 'WebGL context is lost');
        env.window.pmReportInitError(-1, 4, 'Maximum projectM instances per Module reached');
        env.window.pmReportInitError(2, 'from an old bundle');
        assert.equal(errors.a.length, 1);
        assert.equal(errors.b.length, 1);

        a.destroy();
        b.destroy();
        assert.equal('pmReportInitError' in env.window, false, 'the last context gives the hook back');
    });
});

test('two engines in one Module: a preset that failed to switch reaches only the engine it failed on', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const errors = { a: [], b: [] };
        const events = { a: [], b: [] };
        const { a, b } = await startSharedPair(env, {
            extraA: { onError: (detail) => errors.a.push(detail) },
            extraB: { onError: (detail) => errors.b.push(detail) },
        });
        a.on('error', (detail) => events.a.push(detail));

        // js_report_preset_switch_failed(host, preset, message): the engine
        // calls a bus hook instead of writing the page's DOM.
        env.window.pmOnPresetSwitchFailed(a.hostHandle, '/presets/weeks_0.milk', 'warp shader: syntax error');
        assert.equal(errors.a.length, 1);
        assert.equal(errors.a[0].code, PRESET_SWITCH_FAILED, 'a code that tells it from a failed boot');
        assert.match(errors.a[0].message, /Preset failed: weeks_0\.milk \(warp shader: syntax error\)/);
        assert.equal(errors.a[0].error.preset, '/presets/weeks_0.milk');
        assert.deepEqual(events.a.map((detail) => detail.code), [PRESET_SWITCH_FAILED], 'and the context error event');
        assert.deepEqual(errors.b, [], 'B did not fail');

        // The same preset failing again is a second event: not deduplicated
        // like a boot failure, and a failure with no reason still reports.
        env.window.pmOnPresetSwitchFailed(a.hostHandle, '/presets/weeks_0.milk', '');
        assert.equal(errors.a.length, 2);
        assert.equal(errors.a[1].message, 'Preset failed: weeks_0.milk');

        env.window.pmOnPresetSwitchFailed(b.hostHandle, '/presets/other.milk', 'bad');
        assert.equal(errors.b.length, 1);
        assert.equal(errors.a.length, 2);

        a.destroy();
        env.window.pmOnPresetSwitchFailed(a.hostHandle, '/presets/late.milk', 'after destroy');
        assert.equal(errors.a.length, 2, 'a destroyed context reports nothing');

        b.destroy();
        assert.equal('pmOnPresetSwitchFailed' in env.window, false, 'the last context gives the hook back');
    });
});

test('a context that booted its own Module hears its engine\'s preset failures although it never learned the handle', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        // checkInit() creates the engine through create_host_with_config() but
        // returns only the init code, so on this path context.hostHandle stays 0
        // while the engine's events name the real handle (7 here). A filter on
        // `engineHost: 0` would mean "the legacy default host only" and drop
        // every one of them: seen in a real browser, not just on paper.
        const errors = [];
        const context = env.newContext({
            ...mainTopology(env, async () => makeFakeModule({ hostHandle: 7 })),
            onError: (detail) => errors.push(detail),
        });
        await context.start();
        assert.equal(context.hostHandle, 0, 'the premise: this path does not know its handle');

        env.window.pmOnPresetSwitchFailed(7, '/presets/bad.milk', 'warp shader: syntax error');
        assert.equal(errors.length, 1, 'the failure from the engine\'s real handle must arrive');
        assert.equal(errors[0].code, PRESET_SWITCH_FAILED);
        assert.equal(errors[0].error.preset, '/presets/bad.milk');
    });
});

test('a preset load that awaits its fetch still lands on its own engine after a sibling activated', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b, module } = await startSharedPair(env);
        module.FS = { writeFile: () => {} };
        env.window.dispatchEvent = () => true; // the pm:preset-loaded notification
        const gate = gatedPresetFetch();

        const loadA = a.loadPresetUrl('https://cdn.test/presets/a.milk');
        await tick();
        // B drives its engine while A is waiting on the network: B is now the
        // active host, and "whoever called last" would be B.
        b.setLocked(true);
        assert.equal(module.activeHost, b.hostHandle);

        gate.resolve();
        await loadA;

        const loads = module.engineCalls.filter((call) => call.name === 'load_preset_file');
        assert.deepEqual(loads.map((call) => call.host), [a.hostHandle], 'A\'s preset loaded into A');
        // Each start() locks its own engine, then B's setLocked() above.
        const locks = module.engineCalls.filter((call) => call.name === '_set_preset_locked');
        assert.deepEqual(locks.map((call) => call.host), [a.hostHandle, b.hostHandle, b.hostHandle]);
    });
});

test('a context destroyed mid-load neither applies its preset to the survivor nor unsubscribes it', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b, module } = await startSharedPair(env);
        module.FS = { writeFile: () => {} };
        const gate = gatedPresetFetch();

        const loadA = a.loadPresetUrl('https://cdn.test/presets/a.milk');
        await tick();
        a.destroy();
        assert.equal(module.activeHost, b.hostHandle, 'the survivor is the active engine now');

        gate.resolve();
        await assert.rejects(loadA);
        assert.equal(module.engineCalls.filter((call) => call.name === 'load_preset_file').length, 0,
            'A\'s preset must not load into B');

        // B still hears its own engine, and only it.
        let resizesB = 0;
        b.resize = () => { resizesB += 1; };
        assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange', env.window), 1);
        env.window.pmOnGovernorRenderScaleChange(b.hostHandle, 0.5);
        assert.equal(resizesB, 1);
        assert.equal(b.renderScale, 0.5);
    });
});

test('destroying context A leaves context B\'s governor hook subscribed', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b } = await startPair(env);
        assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange', env.window), 2);

        a.destroy();
        assert.equal(typeof env.window.pmOnGovernorRenderScaleChange, 'function', 'A\'s destroy() used to null the global B relies on');
        assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange', env.window), 1);

        b.resize = () => {};
        env.window.pmOnGovernorRenderScaleChange(0.5);
        assert.equal(b.renderScale, 0.5, 'B still hears the governor');

        b.destroy();
        assertNothingLeft(env);
    });
});

test('destroying context A leaves context B\'s resize handling running', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b } = await startPair(env);
        let resizesB = 0;
        b.resize = () => { resizesB += 1; };
        let resizesA = 0;
        a.resize = () => { resizesA += 1; };

        env.window.dispatch('resize');
        assert.deepEqual([resizesA, resizesB], [1, 1]);

        a.destroy();
        env.window.dispatch('resize');
        assert.deepEqual([resizesA, resizesB], [1, 2], 'B keeps resizing, A does not');

        b.destroy();
        assertNothingLeft(env);
    });
});

test('destroying context A leaves B\'s ResizeObserver observing', async () => {
    await withEnv({ withResizeObserver: true }, async (env) => {
        const { a, b } = await startPair(env);
        const [observerA, observerB] = globalThis.ResizeObserver.instances;

        a.destroy();
        assert.equal(observerA.observing, 0);
        assert.equal(observerB.observing, 1);

        b.destroy();
        assert.equal(observerB.observing, 0);
    });
});

test('window.Module follows the newest live context and is released with the last one', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b, moduleA, moduleB } = await startPair(env);
        assert.equal(env.window.Module, moduleB, 'the newest context owns the legacy global');

        b.destroy();
        assert.equal(env.window.Module, moduleA, 'the older context gets it back — not a destructed engine');

        a.destroy();
        assert.equal('Module' in env.window, false);
    });
});

test('destroying the older context leaves the newer one\'s Module published', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b, moduleB } = await startPair(env);
        a.destroy();
        assert.equal(env.window.Module, moduleB);
        b.destroy();
    });
});

test('destroying A leaves B\'s audio path intact: router registry, PCM writer and worklet safety net', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b } = await startPair(env);
        const writerBefore = globalThis.projectMWritePcmRing;
        const routerB = b.audioRouter;
        assert.equal(getHostAudioSourceRouter(), routerB);
        assert.equal(env.openChannels().length, 1, 'both contexts share one worklet safety-net channel');

        a.destroy();

        assert.equal(getHostAudioSourceRouter(), routerB, 'A\'s destroy() used to unregister every router');
        assert.equal(globalThis.projectMWritePcmRing, writerBefore, 'B\'s PCM writer must stay installed');
        assert.equal(env.openChannels().length, 1, 'the safety-net channel is still needed by B');
        assert.equal(typeof globalThis.projectMLoadSongIntoWorklet, 'function');

        b.destroy();
        assertNothingLeft(env);
    });
});

test('destroying the newer context hands the audio path back to the older one', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const { a, b } = await startPair(env);
        const routerA = a.audioRouter;

        b.destroy();

        assert.equal(getHostAudioSourceRouter(), routerA);
        assert.equal(typeof globalThis.projectMWritePcmRing, 'function', 'A\'s writer comes back');

        a.destroy();
        assertNothingLeft(env);
    });
});

test('external PCM keeps reaching B\'s worker after A is destroyed, and A\'s after B is', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const errors = [];
        const opts = { ...workerTopology(env), audioSource: 'external', externalPcmOrigins: [], onError: (d) => errors.push(d) };
        const a = env.newContext({ ...opts, canvasId: 'pm-a' });
        const b = env.newContext({ ...opts, canvasId: 'pm-b' });

        const startedA = a.start();
        await until(() => env.workers.length === 1, 'worker A');
        env.workers[0].emit({ type: 'ready' });
        await startedA;
        const startedB = b.start();
        await until(() => env.workers.length === 2, 'worker B');
        env.workers[1].emit({ type: 'ready' });
        await startedB;

        const [workerA, workerB] = env.workers;
        const pcmPosts = (worker) => worker.messages.filter((message) => message.type === 'pcm').length;
        const sendPcm = () => env.window.dispatch('message', {
            origin: env.window.location.origin,
            data: { type: 'pcm', buffer: new Float32Array([0.1, 0.2, 0.3, 0.4]), channels: 2, sampleRate: 48000 },
        });

        sendPcm();
        assert.equal(pcmPosts(workerB), 1, 'the newest receiver is live');
        assert.equal(pcmPosts(workerA), 0, 'and only it feeds, so nothing is fed twice');

        a.destroy();
        assert.equal(workerA.terminated, true);
        sendPcm();
        assert.equal(pcmPosts(workerB), 2, 'A\'s destroy() used to cut off every other context\'s PCM');

        const c = env.newContext({ ...opts, canvasId: 'pm-c' });
        const startedC = c.start();
        await until(() => env.workers.length === 3, 'worker C');
        env.workers[2].emit({ type: 'ready' });
        await startedC;
        c.destroy();
        sendPcm();
        assert.equal(pcmPosts(workerB), 3, 'closing the newest receiver hands live back to B');

        b.destroy();
        assertNothingLeft(env);
        assert.deepEqual(errors, []);
    });
});

test('an injected router belongs to the host: destroy() detaches from it instead of destroying it', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const statuses = [];
        const shared = createAudioSourceRouter({ autoSwitchOnFeed: true, onStatusChange: (status) => statuses.push(`page:${status.activeSource}`) });
        const module = makeFakeModule();
        const contextStatuses = [];
        const context = env.newContext({ sharedModule: module, audioRouter: shared, onAudioSourceChange: (status) => contextStatuses.push(status.activeSource) });
        await context.start();
        assert.equal(shared.module, module);

        shared.setActiveSource('external');
        assert.deepEqual(contextStatuses, ['external']);
        assert.deepEqual(statuses, ['page:external'], 'the page\'s own listener still runs');

        context.destroy();

        assert.equal(shared.destroyed, false, 'the page\'s router must survive the context');
        assert.equal(getHostAudioSourceRouter(), shared);
        assert.equal(shared.module, null, 'but it no longer drives this context\'s engine');
        shared.setActiveSource('none');
        assert.deepEqual(contextStatuses, ['external'], 'and no longer reports to the destroyed context');
        assert.deepEqual(statuses, ['page:external', 'page:none']);

        shared.destroy();
    });
});

// ---- global-write guard ------------------------------------------------------------

/**
 * Names a context may legitimately leave behind on `window` / `globalThis` once it
 * is destroyed. Empty on purpose: everything a context publishes is claimed and
 * released, so a new entry here needs a reason — an engine-owned global the page
 * expects to outlive one context (the shared AudioContext and worklet node are
 * created by the WASM side, not by the context, so they are not listed either).
 */
const ALLOWED_LEFTOVER_GLOBALS = new Set([]);

function snapshotGlobals(env) {
    return {
        window: new Set(Object.getOwnPropertyNames(env.window)),
        global: new Set(Object.getOwnPropertyNames(globalThis)),
    };
}

function leftovers(before, env) {
    const after = snapshotGlobals(env);
    return {
        window: [...after.window].filter((name) => !before.window.has(name) && !ALLOWED_LEFTOVER_GLOBALS.has(name)),
        global: [...after.global].filter((name) => !before.global.has(name) && !ALLOWED_LEFTOVER_GLOBALS.has(name)),
    };
}

test('global-write guard: a shared-Module context leaves no key on window or globalThis after destroy()', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const before = snapshotGlobals(env);
        const context = env.newContext({ sharedModule: makeFakeModule(), audioSource: 'external', onFps: () => {}, onPresetChanged: () => {} });
        await context.start();

        const whileRunning = leftovers(before, env);
        assert.ok(whileRunning.window.length + whileRunning.global.length > 0, 'a running context does publish hooks; the guard would be vacuous otherwise');

        context.destroy();
        assert.deepEqual(leftovers(before, env), { window: [], global: [] });
    });
});

test('global-write guard: a main-thread context (its own Module) leaves nothing behind', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const before = snapshotGlobals(env);
        env.window.createModule = async () => makeFakeModule();
        before.window.add('createModule');
        const context = env.newContext({ renderTopology: 'main', wasmScriptUrl: 'https://cdn.test/pm/projectm.js', wasmBaseUrl: 'https://cdn.test/pm/' });
        await context.start();
        assert.ok(env.window.Module, 'the legacy global is published while the context runs');

        context.destroy();
        assert.deepEqual(leftovers(before, env), { window: [], global: [] });
    });
});

test('global-write guard: a worker-topology context leaves nothing behind', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const before = snapshotGlobals(env);
        const context = env.newContext({ ...workerTopology(env), audioSource: 'external' });
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready' });
        await started;

        context.destroy();
        assert.deepEqual(leftovers(before, env), { window: [], global: [] });
    });
});

test('global-write guard: a failed start leaves nothing behind either', async () => {
    await withEnv({ withResizeObserver: false }, async (env) => {
        const before = snapshotGlobals(env);
        const context = env.newContext({ sharedModule: makeFakeModule(), presetUrl: 'https://cdn.test/presets/x.milk', audioSource: 'external' });
        await assert.rejects(() => context.start());
        assert.deepEqual(leftovers(before, env), { window: [], global: [] });
    });
});

// ---- contextSnapshot: what the engine negotiated with WebGL -------------------------
//
// ProjectMContext.contextSnapshot reports get_context_snapshot() as a frozen object
// once the engine is up. Packed values: bit 0 has a context, bit 1 float colour
// buffer, bit 2 float blend, bit 3 WEBGL_lose_context, bits 8-9 the dual-FBO format.
const SNAPSHOT_ALL_FLOAT = 0x10f; // everything present, RGBA32F
const SNAPSHOT_BYTE_ONLY = 0x209; // WEBGL_lose_context only, RGBA8

test('contextSnapshot is null until start(), then what the engine negotiated, frozen and read-only', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule({ hostHandle: 12 });
        /** @type {number[]} */
        const readOnHost = [];
        module._get_context_snapshot = () => { readOnHost.push(module.activeHost); return SNAPSHOT_ALL_FLOAT; };
        const context = env.newContext({ sharedModule: module });

        assert.equal(context.contextSnapshot, null, 'nothing negotiated before start()');
        await context.start();

        assert.deepEqual(context.contextSnapshot, {
            floatColorBuffer: true,
            floatBlend: true,
            loseContext: true,
            fboFormat: 1,
            fboFormatName: 'RGBA32F',
            attributes: null,
            mismatches: [],
        });
        assert.ok(Object.isFrozen(context.contextSnapshot), 'a host must not be able to edit what the engine reported');
        assert.throws(() => { /** @type {any} */ (context).contextSnapshot = null; }, TypeError, 'read-only on the context too');
        assert.deepEqual(readOnHost, [12], 'read once, from this context\'s own engine');

        context.destroy();
        assert.equal(context.contextSnapshot, null, 'a destroyed context describes nothing');
    });
});

test('a degraded context shows up as RGBA8 with the float capabilities off', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        module._get_context_snapshot = () => SNAPSHOT_BYTE_ONLY;
        const context = env.newContext({ sharedModule: module });
        await context.start();
        assert.deepEqual(context.contextSnapshot, {
            floatColorBuffer: false,
            floatBlend: false,
            loseContext: true,
            fboFormat: 2,
            fboFormatName: 'RGBA8',
            attributes: null,
            mismatches: [],
        });
    });
});

test('a bundle without get_context_snapshot() starts fine and reports null', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        module._get_context_snapshot = undefined; // an older deployed bundle
        const context = env.newContext({ sharedModule: module });
        await context.start();
        assert.equal(context.ready, true);
        assert.equal(context.contextSnapshot, null);
    });
});

test('a snapshot of 0 (no context behind it) is null, never a made-up RGBA16F', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        module._get_context_snapshot = () => 0;
        const context = env.newContext({ sharedModule: module });
        await context.start();
        assert.equal(context.contextSnapshot, null);
    });
});

test('worker topology: the snapshot comes with ready, so start() never waits on a reply', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready', host: 3, contextSnapshot: SNAPSHOT_ALL_FLOAT });
        await started;

        assert.equal(context.contextSnapshot?.fboFormatName, 'RGBA32F');
        assert.equal(context.contextSnapshot?.floatColorBuffer, true);
        assert.equal(
            env.workers[0].messages.some((message) => message.type === 'ccall' && message.name === 'get_context_snapshot'),
            false,
            'a ccall for the snapshot would hang start() on a bundle that lacks the export',
        );
    });
});

test('worker topology: a worker that reports no snapshot (older bundle) leaves it null and still starts', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready', host: 3 });
        await started;
        assert.equal(context.ready, true);
        assert.equal(context.contextSnapshot, null);
    });
});

test('a successful context recovery re-reads the snapshot, a failed one keeps the last', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready', host: 3, contextSnapshot: SNAPSHOT_ALL_FLOAT });
        await started;

        const stillLost = context.recoverContext();
        env.workers[0].emit({ type: 'context-recovered', status: 5 });
        assert.equal(await stillLost, 5);
        assert.equal(context.contextSnapshot?.fboFormatName, 'RGBA32F', 'no new context, so nothing new to report');

        const recovered = context.recoverContext();
        env.workers[0].emit({ type: 'context-recovered', status: 0, contextSnapshot: SNAPSHOT_BYTE_ONLY });
        assert.equal(await recovered, 0);
        assert.equal(context.contextSnapshot?.fboFormatName, 'RGBA8', 'the restored context is the one described');
        assert.equal(context.contextSnapshot?.floatColorBuffer, false);
    });
});

test('destroy() during a recovery does not bring the snapshot back', async () => {
    await withEnv({}, async (env) => {
        const context = env.newContext(workerTopology(env));
        const started = context.start();
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        env.workers[0].emit({ type: 'ready', host: 3, contextSnapshot: SNAPSHOT_ALL_FLOAT });
        await started;

        const recovering = context.recoverContext();
        context.destroy();
        env.workers[0].emit({ type: 'context-recovered', status: 0, contextSnapshot: SNAPSHOT_ALL_FLOAT });
        await recovering;
        assert.equal(context.contextSnapshot, null);
    });
});

/**
 * A snapshot whose context really has `flags` (CONTEXT_CONFIG_FLAGS bits) and
 * the high-performance power preference, as get_context_snapshot() packs it.
 *
 * @param {number} flags
 */
const snapshotWithAttributes = (flags) => CONTEXT_SNAPSHOT_BITS.valid
    | CONTEXT_SNAPSHOT_BITS.attributesKnown
    | (2 << CONTEXT_SNAPSHOT_POWER_SHIFT)
    | (flags << CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT);

/**
 * Runs `body` with console.warn recorded instead of printed.
 *
 * @param {(warnings: string[]) => Promise<void>} body
 */
async function recordingWarnings(body) {
    const original = console.warn;
    /** @type {string[]} */
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
        await body(warnings);
    } finally {
        console.warn = original;
    }
}

test('requested vs effective: a context without the attributes it asked for says which, once', async () => {
    await recordingWarnings(async (warnings) => {
        await withEnv({}, async (env) => {
            const F = CONTEXT_CONFIG_FLAGS;
            const module = makeFakeModule();
            // The canvas still held an opaque context with a depth buffer.
            module._get_context_snapshot = () => snapshotWithAttributes(F.premultipliedAlpha | F.depth);
            const context = env.newContext({ sharedModule: module, transparent: true });
            await context.start();

            assert.deepEqual(context.contextSnapshot?.attributes?.contextAlpha, false);
            assert.deepEqual(context.contextSnapshot?.mismatches, [
                { attribute: 'depth', requested: false, effective: true },
                { attribute: 'contextAlpha', requested: true, effective: false },
            ]);
            const reports = warnings.filter((message) => message.includes('requested attributes'));
            assert.equal(reports.length, 1);
            assert.match(reports[0], /depth false -> true, contextAlpha true -> false/);
        });
    });
});

test('a context that got what it asked for logs nothing about its attributes', async () => {
    await recordingWarnings(async (warnings) => {
        await withEnv({}, async (env) => {
            const module = makeFakeModule();
            module._get_context_snapshot = () => snapshotWithAttributes(CONTEXT_CONFIG_FLAGS.premultipliedAlpha);
            const context = env.newContext({ sharedModule: module });
            await context.start();
            assert.deepEqual(context.contextSnapshot?.mismatches, []);
            assert.equal(context.contextSnapshot?.attributes?.contextAlpha, false, 'opaque by default');
            assert.deepEqual(warnings, []);
        });
    });
});

test('transparency on an opaque canvas warns once; on a canvas with alpha it does not', async () => {
    await recordingWarnings(async (warnings) => {
        await withEnv({}, async (env) => {
            const F = CONTEXT_CONFIG_FLAGS;
            const opaqueModule = makeFakeModule({ hostHandle: 31 });
            opaqueModule._get_context_snapshot = () => snapshotWithAttributes(F.premultipliedAlpha);
            const opaque = env.newContext({ sharedModule: opaqueModule, canvasId: 'pm-opaque' });
            await opaque.start();
            opaque.setTransparent(true);
            opaque.setTransparent(false);
            opaque.setTransparent(true);
            assert.equal(warnings.filter((message) => message.includes('without an alpha channel')).length, 1);

            warnings.length = 0;
            const glassModule = makeFakeModule({ hostHandle: 32 });
            glassModule._get_context_snapshot = () => snapshotWithAttributes(F.premultipliedAlpha | F.contextAlpha);
            const glass = env.newContext({ sharedModule: glassModule, canvasId: 'pm-glass', contextAlpha: true });
            await glass.start();
            glass.setTransparent(true);
            assert.deepEqual(warnings, []);
        });
    });
});

/**
 * A fake engine create that does what the C++ side does when the canvas holds a
 * context with other attributes: swaps in a copy of the element and announces it.
 *
 * @param {any} env
 * @param {() => any} previous The element being replaced.
 */
function replacingCanvasOnCreate(env, previous) {
    /** @type {{ fresh: any }} */
    const swap = { fresh: null };
    return {
        swap,
        onCall: (/** @type {string} */ name) => {
            if (name !== 'create_host_with_config') return undefined;
            const old = previous();
            swap.fresh = env.makeCanvas(old.id);
            env.document.dispatch(CANVAS_REPLACED_EVENT, { target: swap.fresh, detail: { previous: old } });
            return undefined;
        },
    };
}

test('shared Module: an engine create that moves to a fresh canvas element leaves the context drawing into it', async () => {
    await withEnv({}, async (env) => {
        /** @type {any} */
        let context = null;
        const { swap, onCall } = replacingCanvasOnCreate(env, () => context.canvas);
        const module = makeFakeModule({ onCall });
        context = env.newContext({ sharedModule: module, canvasId: 'pm-moved' });
        const original = context.canvas;
        await context.start();

        assert.ok(swap.fresh, 'the create replaced the canvas');
        assert.notEqual(swap.fresh, original);
        assert.equal(context.canvas, swap.fresh);

        context.destroy();
        assertNothingLeft(env, 'the replacement listener is gone with the boot');
    });
});

test('own Module: init() moving to a fresh canvas element leaves the context drawing into it', async () => {
    await withEnv({}, async (env) => {
        /** @type {any} */
        let context = null;
        const { swap, onCall } = replacingCanvasOnCreate(env, () => context.canvas);
        const module = makeFakeModule({ onCall });
        context = env.newContext({ ...mainTopology(env, () => Promise.resolve(module)), canvasId: 'pm-moved-own' });
        const original = context.canvas;
        await context.start();

        assert.notEqual(swap.fresh, original);
        assert.equal(context.canvas, swap.fresh);
    });
});

test('a replacement announced for some other canvas is not this context\'s', async () => {
    await withEnv({}, async (env) => {
        const elsewhere = env.makeCanvas('pm-elsewhere');
        const module = makeFakeModule({
            onCall: (name) => {
                if (name === 'create_host_with_config') {
                    env.document.dispatch(CANVAS_REPLACED_EVENT, {
                        target: env.makeCanvas('pm-elsewhere'),
                        detail: { previous: elsewhere },
                    });
                }
                return undefined;
            },
        });
        const context = env.newContext({ sharedModule: module, canvasId: 'pm-mine' });
        const original = context.canvas;
        await context.start();
        assert.equal(context.canvas, original);
    });
});
