// Unit tests for html/projectm-render-worker-host.js — the main-thread half
// of the OffscreenCanvas render-worker wire protocol
// (projectm-render-worker-types.ts). The worker half
// (projectm-render-worker.js) is a *classic* (non-module) Worker script — it
// assigns to the bare `self` global and expects `importScripts()` to define a
// global `createModule`, both of which only behave like that under a real
// browser Worker/classic-script global scope. Importing it under Node's ESM
// loader changes `var` semantics enough (module-scoped instead of a
// self/globalThis property) that the init() handshake can't be driven the
// same way a browser would; see AGENTS.md's Testing Instructions for the
// tracked follow-up. This file covers everything reachable from the host
// side without that: the support/enabled guards, setupRenderWorker()'s message
// dispatch and ccall bridging, and the PCM handoff. The ring writer itself is
// no longer defined here — the ring belongs to the WASM module now, and the
// worker posts its descriptor to the host — so it is covered by
// tests/web/projectm-pcm-ring.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isRenderWorkerEnabled,
    isRenderWorkerSupported,
    setupRenderWorker,
} from '../../html/projectm-render-worker-host.js';

class FakeWorker {
    constructor(url) {
        this.url = url;
        this.posted = [];
        this.onmessage = null;
        this.onerror = null;
    }
    postMessage(msg, transfer) {
        this.posted.push({ msg, transfer });
    }
    /** Test helper: simulate a message arriving from the worker. */
    emit(data) {
        if (this.onmessage) this.onmessage({ data });
    }
}

function installMockWorkerEnv() {
    globalThis.Worker = FakeWorker;
    globalThis.OffscreenCanvas = class {};
}

function clearMockWorkerEnv() {
    delete globalThis.Worker;
    delete globalThis.OffscreenCanvas;
}

function makeCanvas({ offscreen = {}, throwOnTransfer = false } = {}) {
    return {
        transferControlToOffscreen() {
            if (throwOnTransfer) throw new Error('transfer failed');
            return offscreen;
        },
    };
}

test('isRenderWorkerEnabled reads the renderWorker query param first', () => {
    assert.equal(isRenderWorkerEnabled({ search: '?renderWorker=1', storage: null }), true);
    assert.equal(isRenderWorkerEnabled({ search: '?renderWorker=0', storage: null }), false);
    assert.equal(isRenderWorkerEnabled({ search: '?renderWorker=nope', storage: null }), false);
});

test('isRenderWorkerEnabled falls back to storage when no query param is present', () => {
    const storage = { getItem: (k) => (k === 'renderWorker' ? '1' : null) };
    assert.equal(isRenderWorkerEnabled({ search: '', storage }), true);
    assert.equal(isRenderWorkerEnabled({ search: '', storage: null }), false);
});

test('isRenderWorkerSupported requires transferControlToOffscreen, Worker, and OffscreenCanvas', () => {
    clearMockWorkerEnv();
    assert.equal(isRenderWorkerSupported(makeCanvas()), false, 'no Worker/OffscreenCanvas globals yet');

    installMockWorkerEnv();
    assert.equal(isRenderWorkerSupported(makeCanvas()), true);
    assert.equal(isRenderWorkerSupported(null), false);
    assert.equal(isRenderWorkerSupported({}), false, 'canvas without transferControlToOffscreen');
    clearMockWorkerEnv();
});

test('setupRenderWorker returns null and calls onUnsupported when the platform lacks support', () => {
    clearMockWorkerEnv();
    let reason = null;
    const handle = setupRenderWorker({
        canvas: makeCanvas(),
        onUnsupported: (r) => { reason = r; },
    });
    assert.equal(handle, null);
    assert.match(reason, /unavailable/);
});

test('setupRenderWorker returns null when transferControlToOffscreen throws', () => {
    installMockWorkerEnv();
    let reason = null;
    const handle = setupRenderWorker({
        canvas: makeCanvas({ throwOnTransfer: true }),
        onUnsupported: (r) => { reason = r; },
    });
    assert.equal(handle, null);
    assert.match(reason, /transferControlToOffscreen failed/);
    clearMockWorkerEnv();
});

test('setupRenderWorker posts an init message transferring the offscreen canvas', () => {
    installMockWorkerEnv();
    const prevCOI = globalThis.crossOriginIsolated;
    globalThis.crossOriginIsolated = false; // no SAB ring for this test

    const offscreen = { marker: 'offscreen' };
    const handle = setupRenderWorker({
        canvas: makeCanvas({ offscreen }),
        scriptSrc: 'projectm.js',
        width: 640,
        height: 480,
        targetFps: 30,
        governor: true,
        meshQuality: 'low',
    });

    assert.ok(handle);
    const worker = handle.worker;
    assert.equal(worker.posted.length, 1);
    const { msg, transfer } = worker.posted[0];
    assert.equal(msg.type, 'init');
    assert.equal(msg.canvas, offscreen);
    assert.equal(msg.scriptSrc, 'projectm.js');
    assert.equal(msg.width, 640);
    assert.equal(msg.height, 480);
    assert.equal(msg.targetFps, 30);
    assert.equal(msg.governor, true);
    assert.equal(msg.meshQuality, 'low');
    assert.equal(msg.pcm, undefined, 'the host no longer allocates a ring; the worker owns it');
    assert.deepEqual(transfer, [offscreen]);

    globalThis.crossOriginIsolated = prevCOI;
    clearMockWorkerEnv();
});

test('setupRenderWorker dispatches ready/unsupported/error/stats messages from the worker', () => {
    installMockWorkerEnv();
    const events = { ready: 0, unsupported: null, error: null, stats: null };
    const handle = setupRenderWorker({
        canvas: makeCanvas(),
        onReady: () => { events.ready += 1; },
        onUnsupported: (r) => { events.unsupported = r; },
        onError: (m) => { events.error = m; },
        onStats: (s) => { events.stats = s; },
    });

    handle.worker.emit({ type: 'ready' });
    handle.worker.emit({ type: 'unsupported', reason: 'no webgl2' });
    handle.worker.emit({ type: 'error', message: 'boom' });
    handle.worker.emit({ type: 'stats', fps: 59.9, fboFormat: 1, qualityTier: 2 });

    assert.equal(events.ready, 1);
    assert.equal(events.unsupported, 'no webgl2');
    assert.equal(events.error, 'boom');
    assert.deepEqual(events.stats, { type: 'stats', fps: 59.9, fboFormat: 1, qualityTier: 2 });

    // worker.onerror (a real error event, not a protocol message) also
    // surfaces through onError.
    events.error = null;
    handle.worker.onerror({ message: 'worker crashed' });
    assert.equal(events.error, 'worker crashed');

    clearMockWorkerEnv();
});

test('setupRenderWorker.ccall resolves its promise from a matching ccall-result message', async () => {
    installMockWorkerEnv();
    const handle = setupRenderWorker({ canvas: makeCanvas() });

    const pending = handle.ccall('get_fps', 'number', [], []);
    assert.equal(handle.worker.posted.length, 2, 'init + ccall messages posted');
    const ccallMsg = handle.worker.posted[1].msg;
    assert.equal(ccallMsg.type, 'ccall');
    assert.equal(ccallMsg.name, 'get_fps');
    assert.equal(typeof ccallMsg.requestId, 'number');

    handle.worker.emit({ type: 'ccall-result', requestId: ccallMsg.requestId, result: 59.9 });
    assert.equal(await pending, 59.9);

    clearMockWorkerEnv();
});

test('setupRenderWorker.ccallVoid fires and forgets: no requestId, no pending promise', () => {
    installMockWorkerEnv();
    const handle = setupRenderWorker({ canvas: makeCanvas() });

    handle.ccallVoid('set_preset', ['string'], ['foo.milk']);
    const msg = handle.worker.posted[1].msg;
    assert.equal(msg.type, 'ccall');
    assert.equal(msg.name, 'set_preset');
    assert.equal(msg.requestId, undefined);

    // An unmatched ccall-result (e.g. a stray/duplicate reply) must not throw.
    assert.doesNotThrow(() => handle.worker.emit({ type: 'ccall-result', requestId: 999, result: null }));

    clearMockWorkerEnv();
});

test('setupRenderWorker.postResize and postPcm post the expected messages', () => {
    installMockWorkerEnv();
    const handle = setupRenderWorker({ canvas: makeCanvas() });

    handle.postResize(320, 240);
    assert.deepEqual(handle.worker.posted[1].msg, { type: 'resize', width: 320, height: 240 });

    const buf = new Float32Array([1, 2, 3, 4]);
    handle.postPcm(buf, 2);
    const { msg, transfer } = handle.worker.posted[2];
    assert.equal(msg.type, 'pcm');
    assert.equal(msg.buffer, buf);
    assert.equal(msg.channels, 2);
    assert.deepEqual(transfer, [buf.buffer]);

    clearMockWorkerEnv();
});

test('feedPcm posts a copy while the worker has not shared its ring', () => {
    installMockWorkerEnv();
    const handle = setupRenderWorker({ canvas: makeCanvas() });

    assert.equal(handle.getPcmRing(), null, 'no ring until the worker publishes one');

    const buf = new Float32Array([1, 2, 3, 4]);
    handle.feedPcm(buf, 2);
    const { msg, transfer } = handle.worker.posted[1];
    assert.equal(msg.type, 'pcm');
    assert.equal(msg.channels, 2);
    assert.notEqual(msg.buffer, buf, 'the caller keeps its buffer; a copy is transferred');
    assert.deepEqual(Array.from(msg.buffer), [1, 2, 3, 4]);
    assert.deepEqual(transfer, [msg.buffer.buffer]);
    assert.equal(buf.length, 4, "the caller's buffer is not detached");

    clearMockWorkerEnv();
});

test('a pcm-ring message switches feedPcm to writing the module ring directly', () => {
    installMockWorkerEnv();
    const handle = setupRenderWorker({ canvas: makeCanvas() });

    // Stand in for the worker module's heap: header at 0, ring data at 16.
    const capacityFrames = 4;
    const memory = new ArrayBuffer(16 + capacityFrames * 2 * 4);
    handle.worker.emit({
        type: 'pcm-ring',
        descriptor: {
            memory,
            headerPtr: 0,
            dataPtr: 16,
            capacityFrames,
            indexModulus: capacityFrames * 1024,
        },
    });

    const ring = handle.getPcmRing();
    assert.ok(ring, 'the descriptor is mapped into a writer');
    assert.equal(ring.capacityFrames, capacityFrames);

    const postedBefore = handle.worker.posted.length;
    handle.feedPcm(new Float32Array([0.5, -0.5]), 1); // mono -> 2 stereo frames
    assert.equal(handle.worker.posted.length, postedBefore, 'nothing is posted once the ring is shared');

    const header = new Int32Array(memory, 0, 4);
    const data = new Float32Array(memory, 16, capacityFrames * 2);
    assert.equal(Atomics.load(header, 0), 2, 'the write index is published');
    assert.deepEqual(Array.from(data.subarray(0, 4)), [0.5, 0.5, -0.5, -0.5]);

    clearMockWorkerEnv();
});

test('a malformed pcm-ring descriptor surfaces through onError and leaves the ring unset', () => {
    installMockWorkerEnv();
    let error = null;
    const handle = setupRenderWorker({
        canvas: makeCanvas(),
        onError: (m) => { error = m; },
    });

    handle.worker.emit({
        type: 'pcm-ring',
        descriptor: {
            memory: new ArrayBuffer(8),
            headerPtr: 0,
            dataPtr: 4,
            capacityFrames: 1024, // far larger than the buffer
            indexModulus: 1024 * 1024,
        },
    });

    assert.equal(handle.getPcmRing(), null);
    assert.match(error, /PCM ring map failed/);

    clearMockWorkerEnv();
});
