// <project-m-visualizer> lifecycle: a failed boot is one `pm-error` and no
// unhandled rejection, an element removed mid-boot destroys its context, and a
// removed-then-re-attached element starts on fresh canvases.
//
// The element runs for real over the fake browser in helpers/lifecycle-env.mjs;
// only the Module is fake. Run with: node --test tests/web/element-lifecycle.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { hideInitError } from '../../html/projectm-init-errors.js';
import { getHostAudioSourceRouter, setHostAudioSourceRouter } from '../../html/projectm-audio-source-router.js';
import { getExternalPcmReceiverCount, resetExternalPcmStateForTests } from '../../html/projectm-external-pcm.js';
import { installLifecycleEnv, makeFakeModule } from './helpers/lifecycle-env.mjs';

// `class ProjectMVisualizerElement extends HTMLElement` is evaluated on import,
// so the fake registry has to exist first. Each test then installs its own.
const bootstrap = installLifecycleEnv({ withCustomElements: true });
const { ProjectMVisualizerElement, registerProjectMElement, ELEMENT_TAG } = await import('../../html/projectm-element.js');
const registeredAtImport = bootstrap.customElementRegistry.get(ELEMENT_TAG);
bootstrap.restore();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function until(condition, what = 'condition') {
    for (let i = 0; i < 200; i += 1) {
        if (condition()) return;
        await tick();
    }
    assert.fail(`timed out waiting for ${what}`);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * Runs `body` in a fresh environment, collecting any rejection nobody handled,
 * and leaves the process-wide modules clean afterwards.
 */
async function withEnv(options, body) {
    const env = installLifecycleEnv({ withCustomElements: true, ...options });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    /** @type {any[]} */
    const elements = [];
    env.mount = (attributes = {}, props = {}) => {
        const element = new ProjectMVisualizerElement();
        for (const [name, value] of Object.entries({ 'crossorigin-isolated': 'false', ...attributes })) {
            element.setAttribute(name, value);
        }
        Object.assign(element, props);
        elements.push(element);
        env.body.append(element);
        return element;
    };
    env.unhandled = unhandled;
    try {
        await body(env);
    } finally {
        for (const element of elements) element.remove();
        await settle();
        process.off('unhandledRejection', onUnhandled);
        hideInitError();
        resetExternalPcmStateForTests();
        setHostAudioSourceRouter(null);
        env.restore();
    }
}

function assertNoLeaks(env, message = '') {
    const prefix = message ? `${message}: ` : '';
    assert.deepEqual(env.allListeners.outstanding(), {}, `${prefix}a fake target still has listeners`);
    assert.equal(env.openChannels().length, 0, `${prefix}a BroadcastChannel was left open`);
    assert.equal(env.liveWorkers().length, 0, `${prefix}a Worker was left running`);
    assert.equal(getExternalPcmReceiverCount(), 0, `${prefix}an external PCM receiver is still open`);
    assert.equal(getHostAudioSourceRouter(), null, `${prefix}a router is still registered`);
    assert.equal('Module' in env.window, false, `${prefix}window.Module was left behind`);
}

// ---- registration ------------------------------------------------------------

test('importing the module registers the element under its tag', () => {
    assert.equal(registeredAtImport, ProjectMVisualizerElement);
});

test('registerProjectMElement defines a custom tag once', async () => {
    await withEnv({}, async (env) => {
        registerProjectMElement({ tagName: 'x-viz' });
        registerProjectMElement({ tagName: 'x-viz' });
        assert.equal(env.customElementRegistry.get('x-viz'), ProjectMVisualizerElement);
    });
});

// ---- a failed boot ---------------------------------------------------------------

test('a boot failure is exactly one pm-error and no unhandled rejection', async () => {
    await withEnv({}, async (env) => {
        // create_host() returns 0: the failure surfaces from inside context.start().
        const element = env.mount({}, { sharedModule: makeFakeModule({ hostHandle: 0 }) });

        await assert.rejects(element.ready(), /create_host\(\) failed/);
        await settle();

        assert.equal(element.count('pm-error'), 1, 'the event used to fire twice: from onError, and again from the boot\'s catch');
        assert.equal(element.dispatched.find((event) => event.type === 'pm-error').detail.code, 4);
        assert.equal(element.count('pm-ready'), 0);
        assert.deepEqual(env.unhandled, [], 'connectedCallback used to drop a promise that rejected on every failed boot');
        assert.equal(element.context, null);

        element.remove();
        assertNoLeaks(env);
    });
});

test('a failure that is not a start() error still produces one pm-error', async () => {
    await withEnv({ crossOriginIsolated: false }, async (env) => {
        const element = env.mount({ 'crossorigin-isolated': 'true' }, { sharedModule: makeFakeModule() });

        await assert.rejects(element.ready(), /Cross-origin isolation/);
        await settle();

        assert.equal(element.count('pm-error'), 1);
        assert.equal(element.dispatched.find((event) => event.type === 'pm-error').detail.code, 4);
        assert.deepEqual(env.unhandled, []);
    });
});

test('ready() keeps rejecting for callers after a failed boot', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({}, { sharedModule: makeFakeModule({ hostHandle: 0 }) });
        await assert.rejects(element.ready());
        await assert.rejects(element.ready());
        await assert.rejects(element.loadPreset('https://cdn.test/a.milk'));
        assert.deepEqual(env.unhandled, []);
    });
});

// ---- a successful boot -----------------------------------------------------------

test('a boot that succeeds reports pm-ready once and exposes the context', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({}, { sharedModule: makeFakeModule() });

        const context = await element.ready();
        assert.ok(context, 'ready() resolves the running context');
        assert.equal(element.context, context);
        assert.equal(context.ready, true);
        assert.equal(element.count('pm-ready'), 1);
        assert.equal(element.count('pm-error'), 0);
        assert.deepEqual(env.unhandled, []);
    });
});

// ---- removal ---------------------------------------------------------------------

test('an element removed mid-boot destroys its context instead of letting it render detached', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const factory = deferred();
        let called = false;
        env.window.createModule = () => { called = true; return factory.promise; };
        const element = env.mount({
            'render-topology': 'main',
            'wasm-script-url': 'https://cdn.test/pm/projectm.js',
            'wasm-base-url': 'https://cdn.test/pm/',
        });
        await until(() => called, 'the module factory to be called');
        const boot = element.ready();
        boot.catch(() => {});

        element.remove();
        factory.resolve(module);
        await assert.rejects(boot, (error) => error.name === 'AbortError');
        await settle();

        assert.equal(element.context, null, 'the context used to be assigned after the element was gone');
        assert.equal(module.destructed, true, 'the Module the removed element booted must be freed');
        assert.equal(module.calls.some((call) => call.name === 'init_with_canvases'), false);
        assert.equal(element.count('pm-ready'), 0);
        assert.equal(element.count('pm-error'), 0, 'removing an element is not an error');
        assert.deepEqual(env.unhandled, []);
        assertNoLeaks(env);
    });
});

test('an element removed mid-boot in the worker topology terminates the worker', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({
            'render-topology': 'worker',
            'wasm-script-url': 'https://cdn.test/pm/projectm.js',
            'wasm-base-url': 'https://cdn.test/pm/',
        });
        await until(() => env.workers.length === 1, 'the render worker to be spawned');
        const boot = element.ready();
        boot.catch(() => {});

        element.remove();

        await assert.rejects(boot, (error) => error.name === 'AbortError');
        assert.equal(env.workers[0].terminated, true);
        assert.equal(element.count('pm-error'), 0);
        assert.deepEqual(env.unhandled, []);
        assertNoLeaks(env);
    });
});

test('removing a running element destroys its context and releases everything', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({ 'audio-source': 'external' }, { sharedModule: makeFakeModule() });
        const context = await element.ready();
        assert.equal(getExternalPcmReceiverCount(), 1);

        element.remove();

        assert.equal(context.destroyed, true);
        assert.equal(element.context, null);
        assertNoLeaks(env);
        await element.ready().then((result) => assert.equal(result, null), () => {});
    });
});

test('a removed and re-attached element starts again on fresh canvases', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({}, { sharedModule: makeFakeModule() });
        await element.ready();
        const firstCanvas = element.querySelector('canvas.pm-main-canvas');
        assert.ok(firstCanvas);

        element.remove();
        assert.equal(element.querySelector('canvas'), null, 'the markup the element made must go with it');

        env.body.append(element);
        const context = await element.ready();
        const secondCanvas = element.querySelector('canvas.pm-main-canvas');

        assert.ok(secondCanvas);
        assert.notEqual(secondCanvas, firstCanvas, 'a transferred canvas cannot be reused by a second engine');
        assert.equal(context.ready, true);
        assert.equal(element.count('pm-ready'), 2);
        assert.deepEqual(env.unhandled, []);
    });
});

test('canvases the page supplied are left in place when the element is removed', async () => {
    await withEnv({}, async (env) => {
        const element = new ProjectMVisualizerElement();
        element.setAttribute('crossorigin-isolated', 'false');
        element.sharedModule = makeFakeModule();
        const canvas = env.document.createElement('canvas');
        canvas.className = 'pm-main-canvas';
        element.append(canvas);
        env.body.append(element);

        await element.ready();
        element.remove();

        assert.equal(element.querySelector('canvas.pm-main-canvas'), canvas, 'markup the page wrote is not the element\'s to delete');
    });
});

// ---- attributes and methods -------------------------------------------------------

test('attribute changes reach the running context', async () => {
    await withEnv({}, async (env) => {
        const module = makeFakeModule();
        const element = env.mount({}, { sharedModule: module });
        const context = await element.ready();
        const calls = () => module.calls.map((call) => call.name);

        const before = calls().length;
        element.setAttribute('locked', 'true');
        assert.ok(calls().slice(before).includes('_set_preset_locked'), 'locked → set_preset_locked');

        const transparent = calls().length;
        element.setAttribute('transparent', 'true');
        assert.ok(calls().length > transparent, 'transparent → engine call');
        assert.equal(context.secondaryCanvas.style.display, 'none');

        const mesh = calls().length;
        element.setAttribute('mesh-quality', 'low');
        assert.ok(calls().length > mesh, 'mesh-quality → engine call');

        const fps = calls().length;
        element.setAttribute('target-fps', '30');
        assert.ok(calls().length > fps, 'target-fps → engine call');

        const next = calls().length;
        element.nextPreset();
        assert.ok(calls().length > next, 'nextPreset() → engine call');
    });
});

test('a failing preset-url change is reported as a pm-error, not left unhandled', async () => {
    await withEnv({}, async (env) => {
        const element = env.mount({}, { sharedModule: makeFakeModule() });
        await element.ready();

        // The fake Module has no filesystem, so the load fails.
        element.setAttribute('preset-url', 'https://cdn.test/presets/a.milk');
        await settle();

        assert.equal(element.count('pm-error'), 1);
        assert.deepEqual(env.unhandled, []);
    });
});

test('loadPreset and loadPresetFile need a running context', async () => {
    await withEnv({}, async (env) => {
        const element = new ProjectMVisualizerElement();
        await assert.rejects(element.loadPreset('https://cdn.test/a.milk'), /failed to initialize/);
        await assert.rejects(element.loadPresetFile({ name: 'a.milk' }), /failed to initialize/);
        assert.equal(await element.ready(), null);
        element.nextPreset();
    });
});

test('several elements without a shared Module warn once each about the memory cost', async () => {
    await withEnv({}, async (env) => {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            env.window.createModule = () => new Promise(() => {});
            env.mount({ 'render-topology': 'main', 'wasm-script-url': 'https://cdn.test/pm/projectm.js', 'wasm-base-url': 'https://cdn.test/pm/' });
            env.mount({ 'render-topology': 'main', 'wasm-script-url': 'https://cdn.test/pm/projectm.js', 'wasm-base-url': 'https://cdn.test/pm/' });
            await settle();
        } finally {
            console.warn = originalWarn;
        }
        assert.ok(warnings.some((line) => line.includes('Multiple elements each booting their own Module')));
    });
});
