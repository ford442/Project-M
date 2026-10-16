// html/projectm-context-boot.js — ProjectMContext's boot as ordered steps that
// unwind on failure, and html/projectm-rhythm-facade.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    bootStep,
    createContextBootSteps,
    resolvePresetDuration,
    runBootSteps,
} from '../../html/projectm-context-boot.js';
import { RhythmFacade } from '../../html/projectm-rhythm-facade.js';
import { ProjectMContext } from '../../html/projectm-context.js';
import { WASM_API_SIGNATURES } from '../../html/generated/projectm-wasm-api.js';
import { resetExternalPcmStateForTests } from '../../html/projectm-external-pcm.js';
import { setHostAudioSourceRouter } from '../../html/projectm-audio-source-router.js';
import { hideInitError } from '../../html/projectm-init-errors.js';
import { installLifecycleEnv, makeFakeModule } from './helpers/lifecycle-env.mjs';

/** A BootHost with only what runBootSteps itself touches. */
function fakeHost() {
    /** @type {Array<() => void>} */
    const owned = [];
    return {
        owned,
        own: (dispose) => owned.push(dispose),
        throwIfAborted: (signal) => {
            if (signal.aborted) {
                const error = new Error('aborted');
                error.name = 'AbortError';
                throw error;
            }
        },
    };
}

test('steps run in order, and their undos are registered with the host as each starts', async () => {
    const log = [];
    const host = fakeHost();
    const steps = ['a', 'b', 'c'].map((name) => bootStep(name, (_ctx, _signal, own) => {
        log.push(`run ${name}`);
        own(() => log.push(`undo ${name}`));
    }));
    await runBootSteps(steps, /** @type {any} */ (host), new AbortController().signal);
    assert.deepEqual(log, ['run a', 'run b', 'run c']);
    assert.equal(host.owned.length, 3, 'one context-level undo per step');

    // What destroy() does: the context runs its disposers newest first.
    for (const dispose of host.owned.reverse()) dispose();
    assert.deepEqual(log.slice(3), ['undo c', 'undo b', 'undo a']);
    // Idempotent: a second teardown releases nothing twice.
    for (const dispose of host.owned) dispose();
    assert.equal(log.length, 6);
});

test('a step that throws unwinds every started step, itself included, newest first', async () => {
    const log = [];
    const failure = new Error('boom');
    const steps = [
        bootStep('first', (_c, _s, own) => { own(() => log.push('undo first:1')); own(() => log.push('undo first:2')); }),
        bootStep('second', (_c, _s, own) => { own(() => log.push('undo second')); }),
        bootStep('third', async (_c, _s, own) => {
            own(() => log.push('undo third (partial)'));
            await Promise.resolve();
            throw failure;
        }),
        bootStep('never', () => log.push('ran never')),
    ];
    await assert.rejects(runBootSteps(steps, /** @type {any} */ (fakeHost()), new AbortController().signal), failure);
    assert.deepEqual(log, ['undo third (partial)', 'undo second', 'undo first:2', 'undo first:1']);
});

test('an abort noticed between steps stops the boot and unwinds it', async () => {
    const log = [];
    const controller = new AbortController();
    const steps = [
        bootStep('first', (_c, _s, own) => { own(() => log.push('undo first')); controller.abort(); }),
        bootStep('second', () => log.push('ran second')),
    ];
    await assert.rejects(runBootSteps(steps, /** @type {any} */ (fakeHost()), controller.signal), { name: 'AbortError' });
    assert.deepEqual(log, ['undo first']);
});

test('an undo that throws is reported and the rest still run', async () => {
    const log = [];
    const warn = console.warn;
    console.warn = (...args) => log.push(String(args[0]));
    try {
        const step = bootStep('s', (_c, _s, own) => {
            own(() => log.push('ran first-registered'));
            own(() => { throw new Error('bad release'); });
        });
        await step.run(/** @type {any} */ ({}), new AbortController().signal);
        step.undo();
    } finally {
        console.warn = warn;
    }
    assert.ok(log.some((line) => line.includes('undoing boot step "s" failed')));
    assert.ok(log.includes('ran first-registered'));
});

test('the context boot is a fixed, named sequence', () => {
    assert.deepEqual(createContextBootSteps().map((step) => step.name), [
        'audio-element',
        'cross-origin-isolation',
        'engine',
        'host-wiring',
        'flash-limit',
        'first-frame',
        'engine-settings',
        'render-scale',
        'init-error-watch',
        'transparency',
        'audio',
        'resize-observer',
        'preset-events',
        'initial-preset',
        'ready',
    ]);
});

test('resolvePresetDuration', () => {
    assert.equal(resolvePresetDuration(undefined), null);
    assert.equal(resolvePresetDuration(0), null);
    assert.equal(resolvePresetDuration({ seconds: Number.NaN }), null);
    assert.deepEqual(resolvePresetDuration(20), [20, 0]);
    assert.deepEqual(resolvePresetDuration({ seconds: 27, randomExtra: 30 }), [27, 30]);
    assert.deepEqual(resolvePresetDuration({ seconds: 27, randomExtra: -1 }), [27, 0]);
});

// ---- the boot inside a real ProjectMContext ---------------------------------

async function withContext(extra, body) {
    const env = installLifecycleEnv({});
    const canvas = env.makeCanvas();
    const context = new ProjectMContext({
        canvas,
        container: canvas.parentElement,
        windowRef: env.window,
        documentRef: env.document,
        requireCrossOriginIsolation: false,
        ...extra,
    });
    try {
        await body(context, env);
    } finally {
        context.destroy();
        hideInitError();
        resetExternalPcmStateForTests();
        setHostAudioSourceRouter(null);
        env.restore();
    }
}

test('a failure in a late boot step unwinds the earlier ones and frees the engine', async () => {
    const module = makeFakeModule({ hostHandle: 12 });
    const errors = [];
    await withContext({
        sharedModule: module,
        presetUrl: 'https://presets.test/broken.milk',
        onError: (detail) => errors.push(detail),
    }, async (context, env) => {
        // The fake Module has no VFS, so the initial preset — the second-last
        // step — cannot be loaded.
        globalThis.fetch = async () => ({ ok: false, status: 503 });
        await assert.rejects(() => context.start());

        assert.equal(errors.length, 1, 'reported once');
        assert.equal(context.ready, false);
        assert.equal(context.transport, null);
        assert.ok(module.calls.some((call) => call.name === 'destroy_host' && call.args[0] === 12), 'host freed');
        assert.deepEqual(env.windowLedger.outstanding(), {}, 'every listener the earlier steps added is gone');
        assert.equal('Module' in env.window, false, 'window.Module released');
    });
});

test('the presetDuration option reaches the engine after it is created', { skip: !('setPresetDuration' in WASM_API_SIGNATURES) && 'generated API predates set_preset_duration()' }, async () => {
    const module = makeFakeModule({ hostHandle: 5 });
    await withContext({ sharedModule: module, presetDuration: { seconds: 27, randomExtra: 30 } }, async (context) => {
        await context.start();
        const call = module.engineCalls.find((entry) => entry.name === '_set_preset_duration');
        assert.ok(call, 'set_preset_duration() was called');
        assert.equal(call.host, 5, 'on this context\'s host');
        assert.deepEqual(module.calls.find((entry) => entry.name === '_set_preset_duration').args, [27, 30]);
    });
});

test('without presetDuration the engine keeps its own', async () => {
    const module = makeFakeModule();
    await withContext({ sharedModule: module }, async (context) => {
        await context.start();
        assert.equal(module.calls.some((entry) => entry.name === '_set_preset_duration'), false);
    });
});

test('setTransparent(true) on a context without an alpha channel warns once', async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(String(args[0]));
    try {
        await withContext({ sharedModule: makeFakeModule(), contextAlpha: false }, async (context) => {
            await context.start();
            context.setTransparent(true);
            context.setTransparent(false);
            context.setTransparent(true);
        });
        await withContext({ sharedModule: makeFakeModule(), contextAlpha: true }, async (context) => {
            await context.start();
            context.setTransparent(true);
        });
    } finally {
        console.warn = warn;
    }
    assert.equal(warnings.filter((line) => line.includes('without an alpha channel')).length, 1);
});

// ---- the rhythm facade ------------------------------------------------------

/** A transport that records calls and lets the test fire rhythm events. */
function fakeRhythmTransport({ supported = () => true } = {}) {
    const calls = [];
    /** @type {((event: any) => void) | null} */
    let listener = null;
    return {
        calls,
        fire: (event) => listener?.(event),
        get subscribed() { return listener !== null; },
        supports: (name) => supported(name),
        callVoid: (name, ...args) => calls.push([name, ...args]),
        call: async (name) => ({ getRhythmBpm: 128, getRhythmBeatPhase: 0.25, getRhythmBarPhase: 0.5,
            getRhythmConfidence: 0.9, getRhythmBeatIndex: 40, getRhythmSection: 2 })[name],
        onRhythmEvent: (fn) => {
            listener = fn;
            return () => { listener = null; };
        },
    };
}

test('the facade reports only while someone listens, and only this host\'s events', () => {
    const transport = fakeRhythmTransport();
    const emitted = [];
    let host = 9;
    const rhythm = new RhythmFacade({
        getTransport: () => /** @type {any} */ (transport),
        getHostHandle: () => host,
        emit: (type, detail) => emitted.push([type, detail.beatIndex]),
    });
    assert.deepEqual(rhythm.retain('ready')(), undefined, 'non-rhythm events are not counted');
    assert.equal(transport.subscribed, false);

    const releaseBeat = rhythm.retain('beat');
    const releaseBar = rhythm.retain('bar');
    assert.deepEqual(transport.calls, [['setRhythmEvents', true]], 'the engine is asked once');
    transport.fire({ host: 9, beat: true, bar: true, beatIndex: 4 });
    transport.fire({ host: 3, beat: true, beatIndex: 5 });
    assert.deepEqual(emitted, [['beat', 4], ['bar', 4]]);

    releaseBeat();
    assert.equal(transport.subscribed, true, 'still one listener');
    releaseBar();
    assert.deepEqual(transport.calls.at(-1), ['setRhythmEvents', false]);
    assert.equal(transport.subscribed, false);

    // detach() drops the subscription without telling the (departing) engine.
    rhythm.retain('section');
    const before = transport.calls.length;
    rhythm.detach();
    assert.equal(transport.subscribed, false);
    assert.equal(transport.calls.length, before);
    host = 0;
});

test('facade controls coerce their arguments and skip what the bundle lacks', async () => {
    const transport = fakeRhythmTransport({ supported: (name) => name !== 'setHardCutOnBeat' });
    const rhythm = new RhythmFacade({ getTransport: () => /** @type {any} */ (transport), getHostHandle: () => 0, emit: () => {} });
    rhythm.setRhythmHint(-3);
    rhythm.setPresetSwitchPolicy('bars', 7.6);
    rhythm.setPresetSwitchPolicy('section', 0);
    rhythm.setTransitionDurationBeats(Number.NaN);
    rhythm.setHardCutOnBeat(true);
    assert.throws(() => rhythm.setPresetSwitchPolicy(/** @type {any} */ ('never')), RangeError);
    rhythm.applyOptions({ presetSwitchPolicy: 'timer', transitionBeats: 2, rhythmHint: 120 });
    assert.deepEqual(transport.calls, [
        ['setRhythmHint', 0],
        ['setPresetSwitchPolicy', 1, 8],
        ['setPresetSwitchPolicy', 2, 16],
        ['transitionSetDurationBeats', 0],
        ['transitionSetDurationBeats', 2],
        ['setRhythmHint', 120],
    ]);
    assert.deepEqual(await rhythm.getRhythmInfo(), {
        bpm: 128, beatPhase: 0.25, barPhase: 0.5, confidence: 0.9, beatIndex: 40, section: 2,
    });

    const idle = new RhythmFacade({ getTransport: () => null, getHostHandle: () => 0, emit: () => {} });
    assert.equal(await idle.getRhythmInfo(), null);
    idle.setRhythmHint(100); // no transport: nothing to call, no throw
});
