// The modules ProjectMContext is split into (html/projectm-context.ts's header
// comment): context/options.ts (configuration), context/session.ts (the start
// gate and the teardown stack), context/connect.ts (error reporting) and
// context/recovery.ts (loss-replay). projectm-context.test.mjs drives them
// through the class; these pin down each one's own contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveContextSetup } from '../../html/context/options.js';
import { StartGate, TeardownStack } from '../../html/context/session.js';
import { ContextErrorReporter } from '../../html/context/connect.js';
import { recordLoaded, recoverEngine } from '../../html/context/recovery.js';
import { ProjectMContext, createProjectMContext } from '../../html/projectm-context.js';
import { hideInitError } from '../../html/projectm-init-errors.js';

function makeCanvas(id = '') {
    return { tagName: 'CANVAS', parentElement: null, id, style: {}, width: 0, height: 0 };
}

/** A document with nothing in it: enough for the preset display and the init-error overlay. */
function makeDocument() {
    const element = () => ({
        id: '',
        className: '',
        style: {},
        classList: { add() {}, remove() {}, contains: () => false },
        querySelector: () => null,
        appendChild() {},
        addEventListener() {},
    });
    return {
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        createElement: element,
    };
}

// ---- context/options.ts -----------------------------------------------------

test('resolveContextSetup refuses options without a canvas', () => {
    assert.throws(() => resolveContextSetup({}), /requires a canvas/);
    assert.throws(() => resolveContextSetup(undefined), /requires a canvas/);
});

test('resolveContextSetup sizes to the container, else the parent, else the canvas', () => {
    const container = { tagName: 'DIV' };
    const parent = { tagName: 'SECTION' };
    const orphan = makeCanvas('orphan');
    const child = { ...makeCanvas('child'), parentElement: parent };

    assert.equal(resolveContextSetup({ canvas: orphan, container }).container, container);
    assert.equal(resolveContextSetup({ canvas: child }).container, parent);
    assert.equal(resolveContextSetup({ canvas: orphan }).container, orphan);
});

test('resolveContextSetup selects canvases by id, and a missing secondary by its selector or #scanvas', () => {
    const canvas = makeCanvas('main');
    const secondary = makeCanvas('second');

    const withSecondary = resolveContextSetup({ canvas, secondaryCanvas: secondary });
    assert.equal(withSecondary.primaryCanvasSelector, '#main');
    assert.equal(withSecondary.secondaryCanvasSelector, '#second');
    assert.equal(withSecondary.secondaryCanvas, secondary);

    const without = resolveContextSetup({ canvas });
    assert.equal(without.secondaryCanvas, null);
    assert.equal(without.secondaryCanvasSelector, '#scanvas');
    assert.equal(resolveContextSetup({ canvas, secondaryCanvasSelector: '#other' }).secondaryCanvasSelector, '#other');
    // Defaults filled in: the resolved options are the context's.
    assert.equal(without.options.audioSource, new ProjectMContext({ canvas: makeCanvas('x') }).options.audioSource);
});

// ---- context/session.ts: StartGate ------------------------------------------

test('StartGate shares one boot between overlapping starts and forgets it once settled', async () => {
    const gate = new StartGate();
    let runs = 0;
    /** @type {(value: string) => void} */
    let finish = () => {};
    const run = () => {
        runs += 1;
        return new Promise((resolve) => {
            finish = resolve;
        });
    };

    assert.equal(gate.signal, undefined, 'no attempt before the first start');
    const first = gate.start(run);
    const second = gate.start(run);
    assert.equal(first, second);
    assert.equal(runs, 1);
    assert.equal(gate.signal?.aborted, false);

    finish('booted');
    assert.equal(await first, 'booted');
    // The signal outlives the boot (a preset load after start() still uses it).
    assert.equal(gate.signal?.aborted, false);

    const third = gate.start(() => Promise.resolve('again'));
    assert.notEqual(third, first);
    assert.equal(await third, 'again');
});

test('StartGate.abort() aborts the attempt in flight, and a failed boot can start over', async () => {
    const gate = new StartGate();
    /** @type {AbortSignal | null} */
    let seen = null;
    const failing = gate.start((signal) => {
        seen = signal;
        return Promise.reject(new Error('no engine'));
    });
    gate.abort();
    assert.equal(seen?.aborted, true);
    assert.equal(gate.signal, undefined);
    gate.abort(); // a second abort is a no-op
    await assert.rejects(failing, /no engine/);

    assert.equal(await gate.start(() => Promise.resolve(1)), 1);
});

// ---- context/session.ts: TeardownStack ---------------------------------------

test('TeardownStack runs steps newest first, once, and survives a step that throws', () => {
    const stack = new TeardownStack();
    const order = [];
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
        stack.add(() => order.push('first'));
        stack.add({ dispose: () => order.push('second') });
        stack.add(null);
        stack.add(undefined);
        stack.add(() => {
            throw new Error('broken step');
        });
        stack.add(() => order.push('last'));
        stack.run();
        stack.run();
    } finally {
        console.warn = originalWarn;
    }
    assert.deepEqual(order, ['last', 'second', 'first']);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1]), /broken step/);
});

test('TeardownStack.adopt returns what it was given, and disposes at once on a destroyed context', () => {
    const stack = new TeardownStack();
    const disposed = [];
    const later = { dispose: () => disposed.push('later') };
    assert.equal(stack.adopt(later, false), later);
    assert.deepEqual(disposed, []);

    const now = () => disposed.push('now');
    assert.equal(stack.adopt(now, true), now);
    assert.deepEqual(disposed, ['now']);
    assert.equal(stack.adopt(null, true), null);

    const originalWarn = console.warn;
    let warned = 0;
    console.warn = () => {
        warned += 1;
    };
    try {
        stack.adopt(() => {
            throw new Error('late failure');
        }, true);
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(warned, 1);

    stack.run();
    assert.deepEqual(disposed, ['now', 'later']);
});

// ---- context/connect.ts: ContextErrorReporter --------------------------------

test('ContextErrorReporter reports a start failure once, until reset()', () => {
    const errors = [];
    const events = [];
    const context = new ProjectMContext({ canvas: makeCanvas('errors'), onError: (detail) => errors.push(detail) });
    context.on('error', (detail) => events.push(detail));
    const reporter = new ContextErrorReporter(context);

    const failure = new Error('init failed');
    reporter.report(failure, 2);
    reporter.report(failure);
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0], { code: 2, message: 'init failed', error: failure });
    // The listener and onError get their own copies.
    assert.notEqual(events[0], errors[0]);
    assert.deepEqual(events[0], errors[0]);

    reporter.report('a string');
    assert.equal(errors[1].code, -1);
    assert.equal(errors[1].message, 'a string');

    reporter.reset();
    reporter.report(failure);
    assert.equal(errors.length, 3);
});

test('ContextErrorReporter does not deduplicate runtime errors, and passes engine details through', () => {
    const errors = [];
    const context = new ProjectMContext({ canvas: makeCanvas('runtime'), onError: (detail) => errors.push(detail) });
    const reporter = new ContextErrorReporter(context);

    reporter.reportRuntime('worker lost its context');
    reporter.reportRuntime('worker lost its context');
    assert.equal(errors.length, 2);
    assert.equal(errors[0].code, -1);
    assert.ok(errors[0].error instanceof Error);
    assert.notEqual(errors[0].error, errors[1].error);

    const detail = { code: 7, message: 'preset did not compile' };
    reporter.reportDetail(detail);
    assert.equal(errors[2], detail);
});

// ---- context/recovery.ts -----------------------------------------------------

test('recoverEngine is -1 before start(), and recordLoaded notes the preset for replay', async () => {
    const context = new ProjectMContext({ canvas: makeCanvas('recovery') });
    assert.equal(await recoverEngine(context), -1);
    assert.equal(await context.recoverContext(), -1);

    const loaded = { vfsPath: '/presets/a.milk', filename: 'a.milk' };
    assert.equal(recordLoaded(context, loaded), loaded);
});

// ---- projectm-context.ts -----------------------------------------------------

test('loadPresetUrl / loadPresetFile need a started context', async () => {
    const context = new ProjectMContext({ canvas: makeCanvas('not-started') });
    await assert.rejects(() => context.loadPresetUrl('https://example.invalid/a.milk'), /not started/);
    await assert.rejects(() => context.loadPresetFile({ name: 'a.milk' }), /not started/);
});

test('loadPresetFile writes through the transport and records the preset', async () => {
    const context = new ProjectMContext({ canvas: makeCanvas('file'), documentRef: makeDocument() });
    const written = [];
    context.transport = {
        writePreset: (vfsPath, bytes, mode) => written.push({ vfsPath, length: bytes.length, mode }),
    };
    const file = {
        name: 'my preset.milk',
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('[preset00]').buffer),
        text: () => Promise.resolve('[preset00]'),
    };
    // The page's preset display reads the global window (updatePresetDisplay()).
    const originalWindow = globalThis.window;
    const loadedEvents = [];
    globalThis.window = { dispatchEvent: (event) => loadedEvents.push(event.type) };
    try {
        const result = await context.loadPresetFile(file);
        assert.equal(result.filename, 'my preset.milk');
        assert.equal(written.length, 1);
        assert.equal(written[0].vfsPath, result.vfsPath);
        assert.equal(written[0].length, '[preset00]'.length);
        assert.equal(globalThis.window.currentPresetPath, result.vfsPath);
    } finally {
        globalThis.window = originalWindow;
    }
});

test('createProjectMContext constructs and starts, and rejects what start() rejects', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { crossOriginIsolated: false };
    globalThis.document = makeDocument();
    try {
        await assert.rejects(
            () => createProjectMContext({ canvas: makeCanvas('factory'), requireCrossOriginIsolation: true }),
            /Cross-origin isolation/
        );
    } finally {
        hideInitError();
        globalThis.window = originalWindow;
        delete globalThis.document;
    }
});
