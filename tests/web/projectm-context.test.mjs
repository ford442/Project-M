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
