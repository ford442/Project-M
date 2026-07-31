import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectMContext } from '../../html/projectm-context.js';
import { hideInitError } from '../../html/projectm-init-errors.js';

function makeCanvas(id = '') {
    return {
        tagName: 'CANVAS',
        parentElement: null,
        id,
        style: {},
        width: 0,
        height: 0,
    };
}

test('ProjectMContext requires a canvas', () => {
    assert.throws(() => new ProjectMContext({}), /canvas/);
});

test('ProjectMContext stores canvas references', () => {
    const canvas = makeCanvas('existing-canvas');
    const context = new ProjectMContext({ canvas });
    assert.equal(context.canvas, canvas);
    assert.equal(context.ready, false);
});

test('ProjectMContext assigns a unique canvas id and primary selector when omitted', () => {
    const canvas = makeCanvas();
    const context = new ProjectMContext({ canvas });

    assert.ok(canvas.id, 'must assign a document-unique canvas id');
    assert.match(context.primaryCanvasSelector, /^#pm-main-canvas-/);
    assert.equal(context.primaryCanvasSelector, `#${canvas.id}`);
});

test('ProjectMContext start() reports COI failure via onError with code 4', async () => {
    const canvas = makeCanvas('coi-canvas');
    const errors = [];
    const originalWindow = globalThis.window;
    globalThis.window = { crossOriginIsolated: false };
    globalThis.document = {
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById: () => null,
        createElement: () => ({
            id: '',
            className: '',
            classList: { add() {}, remove() {}, contains: () => false },
            innerHTML: '',
            querySelector: () => null,
            appendChild() {},
            addEventListener() {},
        }),
    };

    const context = new ProjectMContext({
        canvas,
        requireCrossOriginIsolation: true,
        onError: (detail) => errors.push(detail),
    });

    try {
        await assert.rejects(() => context.start(), /Cross-origin isolation/);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 4);
        assert.match(errors[0].message, /Cross-origin isolation/);
        assert.ok(errors[0].error instanceof Error);
    } finally {
        hideInitError();
        globalThis.window = originalWindow;
        delete globalThis.document;
    }
});

test('ProjectMContext destroy() clears module state and rejects subsequent start()', async () => {
    const canvas = makeCanvas('destroy-canvas');
    let destructed = false;
    const context = new ProjectMContext({ canvas });
    context.module = { _destruct: () => { destructed = true; } };
    context.ready = true;

    context.destroy();

    assert.equal(context.destroyed, true);
    assert.equal(context.ready, false);
    assert.equal(context.module, null);
    assert.equal(destructed, true);

    await assert.rejects(() => context.start(), /destroyed/);
});

test('ProjectMContext exposes an AudioSourceRouter via audioSourceRouter', () => {
    const canvas = makeCanvas('router-canvas');
    const context = new ProjectMContext({ canvas });

    assert.ok(context.audioSourceRouter, 'audioSourceRouter must be set after construction');
    assert.equal(typeof context.audioSourceRouter.activate, 'function');
    assert.equal(typeof context.audioSourceRouter.shouldFeedExternal, 'function');
    assert.equal(typeof context.audioSourceRouter.reset, 'function');
});

test('ProjectMContext.activeAudioSource delegates to audioSourceRouter.activeSource', () => {
    const canvas = makeCanvas('active-source-canvas');
    const context = new ProjectMContext({ canvas });

    assert.equal(context.activeAudioSource, 'none', 'initial activeAudioSource must be "none"');

    context.audioSourceRouter.activate('external');
    assert.equal(context.activeAudioSource, 'external');

    context.audioSourceRouter.activate('element');
    assert.equal(context.activeAudioSource, 'element');
});

test('ProjectMContext destroy() resets audioSourceRouter to "none"', () => {
    const canvas = makeCanvas('reset-canvas');
    const context = new ProjectMContext({ canvas });

    context.audioSourceRouter.activate('external');
    assert.equal(context.activeAudioSource, 'external');

    context.destroy();
    assert.equal(context.activeAudioSource, 'none', 'destroy() must reset the router');
});

test('ProjectMContext dispatches pm-audio-source event when the router source changes', () => {
    const dispatched = [];
    const fakeWindow = {
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent(event) { dispatched.push({ type: event.type, detail: event.detail }); },
    };

    const canvas = makeCanvas('event-canvas');
    const context = new ProjectMContext({ canvas, windowRef: fakeWindow });

    context.audioSourceRouter.activate('external');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'pm-audio-source');
    assert.deepEqual(dispatched[0].detail, { source: 'external' });

    context.audioSourceRouter.activate('none');
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1].detail, { source: 'none' });
});

