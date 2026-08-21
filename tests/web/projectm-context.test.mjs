import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectMContext } from '../../html/projectm-context.js';
import { createAudioSourceRouter } from '../../html/projectm-audio-source-router.js';
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

// The four tests below previously asserted the API of html/projectm-audio-router.js
// (`activate()` / `shouldFeedExternal()` / `reset()`, exposed as
// `context.audioSourceRouter`). That module was superseded by
// projectm-audio-source-router.js and now has no importers; ProjectMContext
// wires the replacement as `this.audioRouter` and surfaces it through
// getAudioSourceStatus() / setAudioSource(). These were never re-pointed, and
// were masked because projectm-context.js threw at import time.

test('ProjectMContext has no audio router before start()', () => {
    const canvas = makeCanvas('router-canvas');
    const context = new ProjectMContext({ canvas });

    // The router is constructed in start(), once a module exists to drive.
    assert.equal(context.audioRouter, null);
    assert.equal(context.getAudioSourceStatus(), null);
});

test('ProjectMContext adopts an injected audioRouter', () => {
    const canvas = makeCanvas('injected-router-canvas');
    const router = createAudioSourceRouter({ initialSource: 'external' });
    const context = new ProjectMContext({ canvas, audioRouter: router });

    assert.equal(context.audioRouter, router);
    assert.equal(context.getAudioSourceStatus()?.activeSource, 'external');
});

test('ProjectMContext.setAudioSource delegates to the router', () => {
    const canvas = makeCanvas('active-source-canvas');
    const router = createAudioSourceRouter({});
    const context = new ProjectMContext({ canvas, audioRouter: router });

    assert.equal(context.getAudioSourceStatus()?.activeSource, 'none');

    context.setAudioSource('external');
    assert.equal(context.getAudioSourceStatus()?.activeSource, 'external');
    assert.equal(router.getActiveSource(), 'external');

    context.setAudioSource('element');
    assert.equal(context.getAudioSourceStatus()?.activeSource, 'element');
});

test('ProjectMContext destroy() tears the router down', () => {
    const canvas = makeCanvas('reset-canvas');
    const router = createAudioSourceRouter({});
    const context = new ProjectMContext({ canvas, audioRouter: router });

    context.setAudioSource('external');
    assert.equal(context.getAudioSourceStatus()?.activeSource, 'external');

    // Regression guard: destroy() used to call `this.audioSourceRouter.reset()`
    // on an always-undefined field and threw TypeError before reaching the end.
    context.destroy();
    assert.equal(context.audioRouter, null);
    assert.equal(context.getAudioSourceStatus(), null);
});

test('ProjectMContext reports router status changes through onStatusChange', () => {
    const seen = [];
    const canvas = makeCanvas('event-canvas');
    const router = createAudioSourceRouter({
        onStatusChange: (status) => seen.push(status.activeSource),
    });
    const context = new ProjectMContext({ canvas, audioRouter: router });

    context.setAudioSource('external');
    context.setAudioSource('none');

    // projectm-element.js re-publishes this as the `pm-audio-source` lifecycle event.
    assert.deepEqual(seen, ['external', 'none']);
});

