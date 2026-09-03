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
// side without that: the pure PCM ring writer, the support/enabled guards,
// and setupRenderWorker()'s message dispatch and ccall bridging.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isRenderWorkerEnabled,
    isRenderWorkerSupported,
    createPcmRing,
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

test('createPcmRing returns null without cross-origin isolation', () => {
    const prevCOI = globalThis.crossOriginIsolated;
    globalThis.crossOriginIsolated = false;
    assert.equal(createPcmRing(), null);
    globalThis.crossOriginIsolated = prevCOI;
});

test('createPcmRing.write interleaves mono to stereo and publishes the write index via Atomics', () => {
    const prevCOI = globalThis.crossOriginIsolated;
    globalThis.crossOriginIsolated = true;

    const ring = createPcmRing(8); // capacityPairs = 8
    assert.ok(ring);
    const header = new Int32Array(ring.sab, 0, 1);
    const data = new Float32Array(ring.sab, 4, 8 * 2);

    ring.write(new Float32Array([1, 2, 3]), 1); // mono -> 3 stereo pairs
    assert.equal(Atomics.load(header, 0), 3);
    assert.deepEqual(Array.from(data.subarray(0, 6)), [1, 1, 2, 2, 3, 3]);

    globalThis.crossOriginIsolated = prevCOI;
});

test('createPcmRing.write wraps around ring capacity and keeps a monotonic write index', () => {
    const prevCOI = globalThis.crossOriginIsolated;
    globalThis.crossOriginIsolated = true;

    const ring = createPcmRing(4); // capacityPairs = 4, 8 floats of storage
    const header = new Int32Array(ring.sab, 0, 1);
    const data = new Float32Array(ring.sab, 4, 4 * 2);

    // Stereo input already interleaved: 3 pairs, fits.
    ring.write(new Float32Array([1, 1, 2, 2, 3, 3]), 2);
    assert.equal(Atomics.load(header, 0), 3);

    // 3 more pairs (global pair indices 3,4,5): only 1 ring slot free before
    // wraparound (capacity 4, next slot = 3 % 4 = 3), so this write must
    // split across the end and the start of the ring, overwriting pair 0
    // and pair 1 (the oldest data) but leaving pair 2 alone.
    ring.write(new Float32Array([4, 4, 5, 5, 6, 6]), 2);
    assert.equal(Atomics.load(header, 0), 6, 'write index keeps counting past capacity');
    // Ring now holds the last 4 pairs written (2,3,4,5) at slots (2,3,0,1)
    // respectively: slot0=pair4, slot1=pair5, slot2=pair2 (untouched), slot3=pair3.
    assert.deepEqual(Array.from(data), [5, 5, 6, 6, 3, 3, 4, 4]);

    globalThis.crossOriginIsolated = prevCOI;
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
    assert.equal(msg.pcm, null, 'no SAB ring without cross-origin isolation');
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
