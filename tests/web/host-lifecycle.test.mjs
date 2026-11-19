// Host lifecycle (#353 Track 1): the per-context replay record a context-loss
// recovery plays back (html/context/replay.js), the page-lifecycle watcher
// (html/context/lifecycle.js), the audio graph's acquire/release ownership
// (html/projectm-worklet-playback.js) and live-texture restore.
//
// Run with: node --test tests/web/host-lifecycle.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { ReplayRecord, replayOpsFor } from '../../html/context/replay.js';
import { watchPageLifecycle } from '../../html/context/lifecycle.js';
import { ProjectMContextControls, replayOf } from '../../html/context/controls.js';
import { acquireAudioGraph, audioGraphHolderCount } from '../../html/projectm-worklet-playback.js';
import { createLiveTextures } from '../../html/projectm-live-texture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A transport that records calls and answers `call()` from `answers`. */
function fakeTransport({ supported = () => true, answers = {} } = {}) {
    const calls = [];
    let restored = 0;
    return {
        calls,
        topology: 'main',
        supports: (name) => supported(name),
        callVoid: (name, ...args) => calls.push([name, ...args]),
        call: (name, ...args) => {
            calls.push([name, ...args]);
            const answer = answers[name];
            return Promise.resolve(typeof answer === 'function' ? answer(...args) : answer ?? 1);
        },
        setFlashLimit: (enabled, threshold) => calls.push(['setFlashLimit', enabled, threshold]),
        restoreTextures: () => {
            restored += 1;
            return Promise.resolve(restored);
        },
        get restored() {
            return restored;
        },
    };
}

/** Replay ops that do nothing unless overridden. */
function ops(overrides = {}) {
    return {
        loadPreset: () => {},
        setMeshQuality: () => {},
        setFlashLimit: () => {},
        setLocked: () => {},
        setEvalVar: async () => true,
        createSprite: async () => 0,
        setSpriteVar: async () => {},
        ...overrides,
    };
}

test('the replay record plays settings back in order, flash limit first', async () => {
    const record = new ReplayRecord();
    record.recordPreset('/presets/a.milk');
    record.recordPreset('');
    record.recordMeshQuality('low');
    record.recordFlashLimit(true, 0.1);
    record.recordLocked(true);
    record.recordEvalVar('Q1', 0.5);
    record.recordEvalVar('zoom', 1.1);
    record.recordEvalClear('zoom');
    const transport = fakeTransport();
    const order = [];
    await record.replay(transport, ops({
        loadPreset: (p) => order.push(['preset', p]),
        setMeshQuality: (q) => order.push(['mesh', q]),
        setFlashLimit: (e, t) => order.push(['flash', e, t]),
        setLocked: (l) => order.push(['lock', l]),
        setEvalVar: async (n, v) => {
            order.push(['eval', n, v]);
            return true;
        },
    }));
    assert.deepEqual(order, [
        ['flash', true, 0.1],
        ['mesh', 'low'],
        ['lock', true],
        ['eval', 'q1', 0.5],
        ['preset', '/presets/a.milk'],
    ]);
    assert.equal(transport.restored, 1);

    record.recordEvalClear('');
    assert.equal(record.evalVars.size, 0);
    record.clear();
    assert.equal(record.preset, null);
    assert.equal(record.flashLimit, null);
});

test('a failing replay step is logged and the rest still run', async () => {
    const record = new ReplayRecord();
    record.recordMeshQuality('high');
    record.recordPreset('/p.milk');
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    const loaded = [];
    try {
        await record.replay(fakeTransport(), ops({
            loadPreset: (p) => loaded.push(p),
            setMeshQuality: () => {
                throw new Error('boom');
            },
        }));
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(loaded, ['/p.milk']);
    assert.equal(warnings.length, 1);
});

test('sprites come back under new engine ids and keep their host-facing id', async () => {
    const record = new ReplayRecord();
    assert.equal(record.recordSprite(1, 'img=a', 'milkdrop'), 1);
    assert.equal(record.recordSprite(2, 'img=b', 'milkdrop'), 2);
    record.recordSpriteVar(1, 'x', 0.25);
    record.recordSpriteVar(99, 'x', 1); // unknown: ignored
    record.recordSpriteDestroyed(2);

    let next = 7;
    const vars = [];
    await record.replay(fakeTransport(), ops({
        createSprite: async () => next++,
        setSpriteVar: async (id, n, v) => {
            vars.push([id, n, v]);
        },
    }));
    assert.equal(record.spriteId(1), 7);
    assert.deepEqual(vars, [[7, 'x', 0.25]]);
    // An unrecorded id passes through.
    assert.equal(record.spriteId(42), 42);
    // The engine hands out 1 again after the recovery: the host gets a free id.
    assert.equal(record.recordSprite(1, 'img=c', 'milkdrop'), 2);
    assert.equal(record.spriteId(2), 1);
});

test('the context records what its methods set, and replayOpsFor reaches the transport', async () => {
    const context = new ProjectMContextControls();
    const transport = fakeTransport({ answers: { projectmSpriteCreateWrapper: 5, evalSet: 1, evalClear: 1 } });
    context.transport = transport;
    context.setLocked(true);
    context.setMeshQuality('low');
    context.setFlashLimit(true, 0.2);
    assert.equal(await context.setEvalVar('q2', 3), true);
    await context.clearEvalVar('q9');
    const record = replayOf(context);
    assert.equal(record.locked, true);
    assert.equal(record.meshQuality, 'low');
    assert.deepEqual(record.flashLimit, { enabled: true, threshold: 0.2 });
    assert.deepEqual([...record.evalVars], [['q2', 3]]);

    const replay = replayOpsFor(context, transport);
    replay.loadPreset('/x.milk');
    replay.setMeshQuality('high');
    replay.setFlashLimit(false, undefined);
    replay.setLocked(false);
    assert.equal(await replay.setEvalVar('q3', 1), true);
    const names = transport.calls.map((c) => c[0]);
    assert.ok(names.includes('loadPresetFile'));
    assert.ok(names.includes('setMesh'));
    assert.ok(names.includes('setPresetLocked'));
    assert.ok(names.includes('evalSet'));
});

/** A document with a settable visibilityState and real listeners. */
function fakeDocument(visibilityState = 'visible') {
    return Object.assign(new EventTarget(), { visibilityState });
}

test('hiding the page pauses the render loop and showing it resumes it', () => {
    const transport = fakeTransport();
    const doc = fakeDocument();
    const win = new EventTarget();
    const dispose = watchPageLifecycle({
        context: { destroyed: false },
        transport,
        documentRef: doc,
        windowRef: win,
        wakeLock: false,
    });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.dispatchEvent(new Event('freeze')); // already paused: no second call
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.dispatchEvent(new Event('freeze'));
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    assert.deepEqual(transport.calls, [
        ['setRenderLoopPaused', true],
        ['setRenderLoopPaused', false],
        ['setRenderLoopPaused', true],
        ['setRenderLoopPaused', false],
    ]);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    dispose();
    dispose();
    // Disposing while paused hands the Module's loop back running.
    assert.deepEqual(transport.calls.at(-1), ['setRenderLoopPaused', false]);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(transport.calls.length, 6);
});

test('without transport support the watcher never pauses; without a document it is inert', () => {
    const transport = fakeTransport({ supported: () => false });
    const doc = fakeDocument('hidden');
    const dispose = watchPageLifecycle({ context: { destroyed: false }, transport, documentRef: doc, windowRef: null, wakeLock: false });
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    dispose();
    assert.deepEqual(transport.calls, []);
    const inert = watchPageLifecycle({ context: { destroyed: false }, transport, documentRef: null, windowRef: null, wakeLock: true });
    assert.equal(typeof inert, 'function');
    inert();
});

test('the wake lock is held while visible with running audio, and released on hide and dispose', async () => {
    const requests = [];
    const releases = [];
    const navigatorRef = {
        wakeLock: {
            request(type) {
                requests.push(type);
                const lock = new EventTarget();
                lock.release = () => {
                    releases.push(type);
                    lock.dispatchEvent(new Event('release'));
                    return Promise.resolve();
                };
                return Promise.resolve(lock);
            },
        },
    };
    const audio = { state: 'running' };
    const doc = fakeDocument();
    const dispose = watchPageLifecycle({
        context: { destroyed: false },
        transport: fakeTransport(),
        documentRef: doc,
        windowRef: null,
        getAudioContext: () => audio,
        navigatorRef,
    });
    await tick();
    assert.deepEqual(requests, ['screen']);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(releases, ['screen']);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('resume'));
    await tick();
    assert.equal(requests.length, 2);
    dispose();
    assert.equal(releases.length, 2);
});

test('a refused wake lock is retried on the next sync', async () => {
    let attempts = 0;
    const navigatorRef = {
        wakeLock: {
            request() {
                attempts += 1;
                return Promise.reject(new Error('NotAllowedError'));
            },
        },
    };
    const doc = fakeDocument();
    const dispose = watchPageLifecycle({
        context: { destroyed: false },
        transport: fakeTransport(),
        documentRef: doc,
        windowRef: null,
        getAudioContext: () => ({ state: 'running' }),
        navigatorRef,
    });
    await tick();
    doc.dispatchEvent(new Event('visibilitychange'));
    await tick();
    assert.equal(attempts, 2);
    dispose();
});

test('the last audio-graph release closes the AudioContext it created and drops the worklet', async () => {
    const closed = [];
    const disconnected = [];
    const ctx = { state: 'running', close: () => (closed.push(1), Promise.resolve()) };
    const node = { port: { onmessage: () => {}, close() {} }, disconnect: () => disconnected.push(1) };
    const releaseA = acquireAudioGraph();
    const releaseB = acquireAudioGraph();
    globalThis.projectMAudioContext_Global_Cpp = ctx;
    globalThis.projectMWorkletNode_Global_Cpp = node;
    assert.equal(audioGraphHolderCount(), 2);
    releaseA();
    releaseA();
    await tick();
    assert.equal(closed.length, 0);
    releaseB();
    await tick();
    assert.equal(audioGraphHolderCount(), 0);
    assert.equal(closed.length, 1);
    assert.equal(disconnected.length, 1);
    assert.equal(node.port.onmessage, null);
    assert.equal(globalThis.projectMAudioContext_Global_Cpp, undefined);
    assert.equal(globalThis.projectMWorkletNode_Global_Cpp, null);
});

test('an injected AudioContext is adopted and never closed', async () => {
    const injected = { state: 'running', close: () => assert.fail("closed the embedder's AudioContext") };
    const release = acquireAudioGraph({ audioContext: injected });
    assert.equal(globalThis.projectMAudioContext_Global_Cpp, injected);
    release();
    await tick();
    assert.equal(globalThis.projectMAudioContext_Global_Cpp, undefined);
});

test('live textures re-register at their sizes on a rebuilt engine; refused ones are forgotten', async () => {
    const registered = [];
    let refuse = false;
    const live = createLiveTextures({
        registerSlot: (name, w, h) => {
            registered.push([name, w, h]);
            return !refuse || name !== 'cam';
        },
        unregisterSlot: () => true,
        writeFrame: () => true,
    });
    await live.register('cam', 64, 32);
    await live.register('Depth', 16, 16);
    registered.length = 0;
    refuse = true;
    assert.equal(await live.restore(), 1);
    assert.deepEqual(registered, [['cam', 64, 32], ['depth', 16, 16]]);
    assert.equal(live.size('cam'), null);
    assert.deepEqual(live.size('depth'), { width: 16, height: 16 });
});
