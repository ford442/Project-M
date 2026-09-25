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

// ProjectMContext wires the one router module, projectm-audio-source-router.js,
// as `this.audioRouter` and surfaces it through getAudioSourceStatus() /
// setAudioSource().

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

// ---- WebGL context config (#128 / #84 / #179 A5) --------------------------

test('ProjectMContext stores forwarded context-attribute options', () => {
    const canvas = makeCanvas('ctx-cfg');
    const context = new ProjectMContext({
        canvas,
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
        fboPrecision: 'high',
        depth: false,
    });
    assert.equal(context.options.antialias, true);
    assert.equal(context.options.preserveDrawingBuffer, true);
    assert.equal(context.options.powerPreference, 'low-power');
    assert.equal(context.options.fboPrecision, 'high');
    assert.equal(context.options.depth, false);
});

test('start() calls set_context_config before create_host with mapped args', async () => {
    const canvas = makeCanvas('ctx-cfg-order');
    const calls = [];
    // create_host returns 0 so start() throws right after these two ccalls,
    // before any audio/DOM/timer setup — keeps the test hermetic (no leaked
    // handles that would hang `node --test`).
    const module = {
        ccall: (name, _ret, _argt, args) => {
            calls.push([name, args]);
            return name === 'create_host' ? 0 : undefined;
        },
    };
    const errors = [];
    const context = new ProjectMContext({
        canvas,
        sharedModule: module,
        requireCrossOriginIsolation: false, // skip the COI early-throw
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
        fboPrecision: 'high',
        onError: (d) => errors.push(d),
    });

    await assert.rejects(() => context.start(), /create_host/);

    assert.deepEqual(calls.map((c) => c[0]), ['set_context_config', 'create_host']);
    // Args: antialias, preserveDrawingBuffer, depth, stencil, alpha, power, fbo.
    // depth/stencil default off (#246).
    assert.deepEqual(calls[0][1], [1, 1, 0, 0, 1, 1, 1]);
    assert.equal(errors[0]?.code, 4);
});

test('start() hands the page\'s render-path switches to the module before create_host', async () => {
    const canvas = makeCanvas('ctx-render-paths');
    const calls = [];
    const module = {
        ccall: (name) => {
            calls.push([name]);
            return name === 'create_host' ? 0 : undefined;
        },
        _set_render_path_overrides: (...args) => calls.push(['set_render_path_overrides', args]),
    };
    const context = new ProjectMContext({
        canvas,
        sharedModule: module,
        requireCrossOriginIsolation: false,
        // Only location is read from it before create_host() fails.
        windowRef: /** @type {any} */ ({ location: { search: '?blurPath=copy&perPixelEval=cpu' } }),
        onError: () => {},
    });

    await assert.rejects(() => context.start(), /create_host/);

    assert.deepEqual(calls.map((c) => c[0]), ['set_context_config', 'set_render_path_overrides', 'create_host']);
    assert.deepEqual(calls[1][1], [1, 0, 1]);
});

test('an explicit renderPathOverrides option wins over the page URL', async () => {
    const canvas = makeCanvas('ctx-render-paths-explicit');
    /** @type {number[][]} */
    const overrides = [];
    const module = {
        ccall: (name) => (name === 'create_host' ? 0 : undefined),
        _set_render_path_overrides: (...args) => overrides.push(args),
    };
    const context = new ProjectMContext({
        canvas,
        sharedModule: module,
        requireCrossOriginIsolation: false,
        windowRef: /** @type {any} */ ({ location: { search: '?blurPath=copy' } }),
        renderPathOverrides: { blurCopyPath: false, copyShaderPath: true, perPixelForceCpu: false },
        onError: () => {},
    });

    await assert.rejects(() => context.start(), /create_host/);
    assert.deepEqual(overrides, [[0, 1, 0]]);
});

// ---- Multi-instance host handle (#168 Phase B) ----------------------------

test('single-instance control ops do not call set_active_host', () => {
    const canvas = makeCanvas('single-lock');
    const context = new ProjectMContext({ canvas });
    const calls = [];
    context.module = {
        ccall: (name) => calls.push(name),
        _set_preset_locked: () => calls.push('_set_preset_locked'),
    };
    // hostHandle defaults to 0 (process default host) — only one engine, so no
    // set_active_host is needed.
    assert.equal(context.hostHandle, 0);
    context.setLocked(false);
    assert.deepEqual(calls, ['_set_preset_locked']);
});

test('multi-instance setLocked activates its host before the engine op', () => {
    const canvas = makeCanvas('multi-lock');
    const context = new ProjectMContext({ canvas });
    const calls = [];
    context.module = {
        ccall: (name, _ret, _argt, args) => calls.push(['ccall', name, args]),
        _set_preset_locked: (v) => calls.push(['_set_preset_locked', v]),
    };
    context.hostHandle = 42;
    context.setLocked(true);
    assert.deepEqual(calls, [
        ['ccall', 'set_active_host', [42]],
        ['_set_preset_locked', 1],
    ]);
});

test('multi-instance nextPreset activates its host before the engine op', () => {
    const canvas = makeCanvas('multi-next');
    const context = new ProjectMContext({ canvas });
    const calls = [];
    context.module = {
        ccall: (name, _ret, _argt, args) => calls.push(['ccall', name, args]),
        _switch_preset: () => calls.push(['_switch_preset']),
    };
    context.hostHandle = 5;
    context.nextPreset();
    assert.deepEqual(calls, [
        ['ccall', 'set_active_host', [5]],
        ['_switch_preset'],
    ]);
});

test('multi-instance destroy() frees just its host, not the shared Module', () => {
    const canvas = makeCanvas('multi-destroy');
    const context = new ProjectMContext({ canvas });
    const calls = [];
    context.module = {
        ccall: (name, _ret, _argt, args) => calls.push(['ccall', name, args]),
        _destruct: () => calls.push(['_destruct']),
    };
    context.hostHandle = 9;
    context.ownsModule = false; // shares a Module booted elsewhere
    context.ready = true;

    context.destroy();

    // destroy_host(9) is called; the shared Module's _destruct is NOT (its owner
    // tears the Module down).
    assert.deepEqual(calls, [['ccall', 'destroy_host', [9]]]);
    assert.equal(context.hostHandle, 0);
    assert.equal(context.module, null);
});

test('single-instance destroy() tears down the owned Module via _destruct', () => {
    const canvas = makeCanvas('single-destroy');
    const context = new ProjectMContext({ canvas });
    const calls = [];
    context.module = {
        ccall: (name) => calls.push(['ccall', name]),
        _destruct: () => calls.push(['_destruct']),
    };
    // Defaults: hostHandle 0, ownsModule true.
    context.ready = true;

    context.destroy();

    assert.deepEqual(calls, [['_destruct']]);
    assert.equal(context.module, null);
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


test('recoverContext() reports -1 before start and otherwise rebuilds through the transport at the canvas size', async () => {
    const canvas = makeCanvas('recover-canvas');
    canvas.width = 1024;
    canvas.height = 576;
    const context = new ProjectMContext({ canvas });

    assert.equal(await context.recoverContext(), -1, 'no transport, nothing to rebuild');

    /** @type {Array<[number | undefined, number | undefined]>} */
    const recovered = [];
    context.transport = /** @type {any} */ ({
        recoverContext: async (width, height) => { recovered.push([width, height]); return 5; },
    });
    assert.equal(await context.recoverContext(), 5, 'the init() status reaches the caller unchanged');
    assert.deepEqual(recovered, [[1024, 576]]);
});
