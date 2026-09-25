// Unit tests for html/projectm-context-loss.js — WebGL context-loss recovery.
// Run with: node --test tests/web/projectm-context-loss.test.mjs
//
// The module talks to a RenderTransport and never to the Emscripten Module, so
// a fake transport is the whole engine here. What these pin down is that the
// two topologies recover through the same transport call: on the main thread
// the DOM events are heard on the canvas, in the render worker (which owns the
// context after transferControlToOffscreen) they arrive through
// transport.onContextEvent() and the worker does the engine teardown itself.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { setupContextLossRecovery } from '../../html/projectm-context-loss.js';
import { FakeElement, createFakeDocument } from './helpers/fake-dom.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {'main' | 'worker'} topology
 * @param {{ status?: number, supported?: boolean }} [options]
 */
function fakeTransport(topology, { status = 0, supported = true } = {}) {
    /** @type {Array<unknown[]>} */
    const calls = [];
    /** @type {Array<(event: 'lost' | 'restored') => void>} */
    let listeners = [];
    const transport = {
        topology,
        calls,
        status,
        module: null,
        workerHandle: null,
        supports: (name) => { calls.push(['supports', name]); return supported; },
        callVoid: (...args) => { calls.push(['callVoid', ...args]); },
        recoverContext: async (...args) => { calls.push(['recoverContext', ...args]); return transport.status; },
        onContextEvent(listener) {
            listeners.push(listener);
            return () => { listeners = listeners.filter((l) => l !== listener); };
        },
        /** Test helper: what the worker relays. */
        emit: (event) => [...listeners].forEach((listener) => listener(event)),
        get listenerCount() { return listeners.length; },
    };
    return transport;
}

function fakeCanvas(width = 640, height = 360) {
    const canvas = new FakeElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

/** A DOM event object with the one method the module must call. */
function domEvent() {
    return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function setup(target, { canvas = fakeCanvas(), windowRef = {} } = {}) {
    const { document, elementsById } = createFakeDocument();
    const dispose = setupContextLossRecovery(target, { canvas, documentRef: document, windowRef });
    return {
        canvas,
        windowRef,
        dispose,
        overlay: () => elementsById.get('pm-context-lost'),
        overlayVisible: () => elementsById.get('pm-context-lost').classList.contains('visible'),
    };
}

// Recovery logs through console.warn/error by design; keep the test output clean.
test.beforeEach(() => {
    test.mock.method(console, 'warn', () => {});
    test.mock.method(console, 'error', () => {});
});
test.afterEach(() => test.mock.restoreAll());

// ---- main thread ------------------------------------------------------------

test('main thread: a lost context is prevented, torn down through the transport and announced', () => {
    const transport = fakeTransport('main');
    const page = setup(transport);
    assert.equal(page.overlayVisible(), false, 'the overlay exists but stays hidden until a loss');

    const event = domEvent();
    page.canvas.dispatch('webglcontextlost', event);

    assert.equal(event.defaultPrevented, true, 'without preventDefault the browser never restores the context');
    assert.deepEqual(transport.calls, [['supports', 'pmHandleContextLoss'], ['callVoid', 'pmHandleContextLoss']]);
    assert.equal(page.overlayVisible(), true);
});

test('main thread: a bundle without pm_handle_context_loss still shows the overlay and recovers', async () => {
    const transport = fakeTransport('main', { supported: false });
    const page = setup(transport);

    page.canvas.dispatch('webglcontextlost', domEvent());
    assert.equal(transport.calls.some((call) => call[0] === 'callVoid'), false);
    assert.equal(page.overlayVisible(), true);

    page.canvas.dispatch('webglcontextrestored');
    await flush();
    assert.equal(page.overlayVisible(), false);
});

test('main thread: a restored context is recovered at the canvas size and the last preset is reloaded', async () => {
    const transport = fakeTransport('main');
    const page = setup(transport, { canvas: fakeCanvas(1280, 720), windowRef: { currentPresetPath: '/presets/a.milk' } });

    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;
    page.canvas.dispatch('webglcontextrestored');
    await flush();

    assert.deepEqual(transport.calls, [
        ['recoverContext', 1280, 720],
        ['callVoid', 'loadPresetFile', '/presets/a.milk'],
    ]);
    assert.equal(page.overlayVisible(), false);
});

test('recovery without a remembered preset does not try to load one', async () => {
    const transport = fakeTransport('main');
    const page = setup(transport);
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.canvas.dispatch('webglcontextrestored');
    await flush();

    assert.deepEqual(transport.calls.map((call) => call[0]), ['recoverContext']);
});

test('a tap before the browser restores the context leaves the overlay up and retries on restore', async () => {
    const transport = fakeTransport('main', { status: 5 });
    const page = setup(transport, { windowRef: { currentPresetPath: '/presets/a.milk' } });
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.overlay().dispatch('click');
    await flush();
    assert.deepEqual(transport.calls.map((call) => call[0]), ['recoverContext']);
    assert.equal(page.overlayVisible(), true, 'init() refused with 5: the context is still lost');

    transport.status = 0;
    page.canvas.dispatch('webglcontextrestored');
    await flush();
    assert.equal(page.overlayVisible(), false);
    assert.deepEqual(
        transport.calls.map((call) => call[0]),
        ['recoverContext', 'recoverContext', 'callVoid'],
        'the preset is reloaded once, after the recovery that worked',
    );
});

test('a real init failure keeps the overlay up and does not reload a preset', async () => {
    const transport = fakeTransport('main', { status: 3 });
    const page = setup(transport, { windowRef: { currentPresetPath: '/presets/a.milk' } });
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.canvas.dispatch('webglcontextrestored');
    await flush();

    assert.equal(page.overlayVisible(), true);
    assert.deepEqual(transport.calls.map((call) => call[0]), ['recoverContext']);
});

test('a tap on the overlay of an engine that never lost its context does nothing', async () => {
    // The overlay element is shared by every context on the page. init() on a
    // healthy engine would tear down a working one.
    const transport = fakeTransport('main');
    const page = setup(transport);

    page.overlay().dispatch('click');
    await flush();

    assert.deepEqual(transport.calls, []);
});

test('overlapping restore triggers recover once', async () => {
    const transport = fakeTransport('main');
    const page = setup(transport);
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.canvas.dispatch('webglcontextrestored');
    page.overlay().dispatch('click');
    await flush();

    assert.equal(transport.calls.filter((call) => call[0] === 'recoverContext').length, 1);
});

// ---- render worker ----------------------------------------------------------

test('worker: the canvas is not listened to — the worker relays the events through the transport', () => {
    const transport = fakeTransport('worker');
    const page = setup(transport);

    assert.equal(page.canvas.listenerCount('webglcontextlost'), 0, 'the canvas was transferred; nothing fires on it');
    assert.equal(page.canvas.listenerCount('webglcontextrestored'), 0);
    assert.equal(transport.listenerCount, 1);
});

test('worker: a relayed loss shows the overlay and leaves the teardown to the worker', () => {
    const transport = fakeTransport('worker');
    const page = setup(transport);

    transport.emit('lost');

    assert.equal(page.overlayVisible(), true);
    assert.deepEqual(transport.calls, [], 'the worker already ran pm_handle_context_loss(); doing it twice is wrong');
});

test('worker: a relayed restore asks the transport to recover, then reloads the preset over the same transport', async () => {
    const transport = fakeTransport('worker');
    const page = setup(transport, { windowRef: { currentPresetPath: '/presets/w.milk' } });
    transport.emit('lost');

    transport.emit('restored');
    await flush();

    assert.deepEqual(transport.calls, [
        // The worker knows its own surface size; the host passes the canvas's
        // stale one and the transport ignores it.
        ['recoverContext', 640, 360],
        ['callVoid', 'loadPresetFile', '/presets/w.milk'],
    ]);
    assert.equal(page.overlayVisible(), false);
});

test('worker: a tap before the restore notification asks for recovery and stays up on code 5', async () => {
    const transport = fakeTransport('worker', { status: 5 });
    const page = setup(transport);
    transport.emit('lost');

    page.overlay().dispatch('click');
    await flush();

    assert.deepEqual(transport.calls.map((call) => call[0]), ['recoverContext']);
    assert.equal(page.overlayVisible(), true);
});

// ---- ProjectMContext as the target ------------------------------------------

test('a context target recovers through its own recoverContext(), which activates its host', async () => {
    const transport = fakeTransport('main');
    const recovered = [];
    const context = {
        transport,
        recoverContext: async () => { recovered.push('context'); return 0; },
    };
    const page = setup(context, { windowRef: { currentPresetPath: '/presets/c.milk' } });
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.canvas.dispatch('webglcontextrestored');
    await flush();

    assert.deepEqual(recovered, ['context']);
    assert.equal(transport.calls.some((call) => call[0] === 'recoverContext'), false, 'not bypassed');
    assert.deepEqual(transport.calls, [['callVoid', 'loadPresetFile', '/presets/c.milk']]);
});

test('a context that has no transport yet has nothing to recover', () => {
    const page = setup({ transport: null });
    assert.equal(page.canvas.listenerCount('webglcontextlost'), 0);
    assert.doesNotThrow(page.dispose);
});

// ---- teardown ---------------------------------------------------------------

test('dispose removes every listener and silences a recovery that was already in flight', async () => {
    const transport = fakeTransport('main');
    const page = setup(transport);
    page.canvas.dispatch('webglcontextlost', domEvent());
    transport.calls.length = 0;

    page.canvas.dispatch('webglcontextrestored');
    page.dispose();
    await flush();

    assert.equal(page.canvas.listenerCount('webglcontextlost'), 0);
    assert.equal(page.canvas.listenerCount('webglcontextrestored'), 0);
    assert.equal(page.overlay().listenerCount('click'), 0);
    assert.deepEqual(transport.calls.map((call) => call[0]), ['recoverContext']);
    assert.equal(page.overlayVisible(), true, 'a destroyed context must not go on to reload presets or hide the overlay');

    // Idempotent, like the disposers it sits with.
    assert.doesNotThrow(page.dispose);
});

test('dispose unsubscribes from the worker transport', () => {
    const transport = fakeTransport('worker');
    const page = setup(transport);
    page.dispose();
    assert.equal(transport.listenerCount, 0);
});

test('recovery still runs, silently, where there is no document', async () => {
    const transport = fakeTransport('main');
    const canvas = fakeCanvas();
    setupContextLossRecovery(transport, { canvas, documentRef: null, windowRef: null });

    canvas.dispatch('webglcontextlost', domEvent());
    canvas.dispatch('webglcontextrestored');
    await flush();

    assert.deepEqual(transport.calls.map((call) => call[0]), ['supports', 'callVoid', 'recoverContext']);
});

// ---- the gate ---------------------------------------------------------------

test('the module reaches the engine only through the transport (no raw Module access)', () => {
    const source = readFileSync(new URL('../../html/projectm-context-loss.js', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
    assert.doesNotMatch(source, /Module\._[A-Za-z]|Module\.ccall|\.module\b/);
    assert.doesNotMatch(source, /generated\/projectm-wasm-api/);
});
