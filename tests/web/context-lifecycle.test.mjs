// Lifecycle of ProjectMContext: overlapping start(), destroy() during a boot, a
// start that fails part-way, and two contexts on one page where one is
// destroyed. Every test ends by asking what is still there — workers,
// BroadcastChannels, window listeners, process-wide globals — because that is
// where these bugs live: the functional behaviour was always fine.
//
// Run with: node --test tests/web/context-lifecycle.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { ProjectMContext } from '../../html/projectm-context.js';
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
import { installLifecycleEnv, makeFakeModule } from './helpers/lifecycle-env.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits (in macrotasks) until `condition()` holds. */
async function until(condition, what = 'condition') {
    for (let i = 0; i < 200; i += 1) {
        if (condition()) return;
        await tick();
    }
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
        assert.equal(module.calls.filter((call) => call.name === 'init_with_canvases').length, 1);

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
        const bad = makeFakeModule({ onCall: (name) => (name === 'init_with_canvases' ? 1 : undefined) });
        let calls = 0;
        const context = env.newContext({
            ...mainTopology(env, async () => (++calls === 1 ? bad : good)),
            onError: (detail) => errors.push(detail),
        });

        await assert.rejects(() => context.start(), /init\(\) failed/);
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
function workerTopology(env) {
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

test('create_host() failure is reported once, with its own code', async () => {
    await withEnv({}, async (env) => {
        const errors = [];
        const seen = [];
        const context = env.newContext({ sharedModule: makeFakeModule({ hostHandle: 0 }), onError: (detail) => errors.push(detail) });
        context.events.addEventListener('error', (event) => seen.push(event.detail));

        await assert.rejects(() => context.start(), /create_host\(\) failed/);

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

/** Two contexts, each with its own shared Module and host handle. */
async function startPair(env, extra = {}) {
    let nextHandle = 10;
    const moduleA = makeFakeModule({ onCall: (name) => (name === 'create_host' ? nextHandle++ : undefined) });
    const moduleB = makeFakeModule({ onCall: (name) => (name === 'create_host' ? nextHandle++ : undefined) });
    const a = env.newContext({ sharedModule: moduleA, canvasId: 'pm-a', ...extra });
    const b = env.newContext({ sharedModule: moduleB, canvasId: 'pm-b', ...extra });
    await a.start();
    await b.start();
    return { a, b, moduleA, moduleB };
}

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
