// Unit tests for html/projectm-frame-capture.js and ProjectMContext#captureFrame()
// on the main-thread topology. Run with:
//   node --test tests/web/projectm-frame-capture.test.mjs
//
// The engine side (src/wasm/WasmPresent.cpp) keeps one capture buffer per host
// and reads the frame inside render_frame(). What these tests hold the JS side
// to: a capture waits for the frame without stalling (one poll per tick), takes
// it at once when the caller rendered it, copies the pixels out of the heap,
// and — the case two canvases on one Module depend on — every export it calls
// lands on its own engine, so a sibling capturing at the same time cannot read
// or overwrite its frame.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectMContext } from '../../html/projectm-context.js';
import { CAPTURE_STATUS, captureFrameFromModule, supportsFrameCapture } from '../../html/projectm-frame-capture.js';
import { createModuleTransport } from '../../html/projectm-render-transport.js';

/**
 * A Module modelling the C++ capture exports: a capture buffer per host at its
 * own heap address, sized to that host's canvas, filled when the render loop
 * (or render_frame()) draws the requested frame. Which host an export acts on
 * is whatever set_active_host() selected last, as in WasmHost.cpp.
 *
 * @param {Record<number, [number, number]>} canvasSizes Drawing-buffer size per host handle.
 * @param {{ manualPresent?: boolean }} [options] Manual present: a drawn frame is
 *   pending (fence) until the next poll, unless resolved with wait.
 */
function fakeCaptureModule(canvasSizes, { manualPresent = false } = {}) {
    const heap = new Uint8Array(1 << 16);
    /** @type {Map<number, { status: number, index: number }>} */
    const captures = new Map();
    const baseOf = (host) => 1024 + host * 8192;
    let active = 0;
    let renderedFrames = 0;
    const capture = () => captures.get(active) ?? { status: CAPTURE_STATUS.idle, index: 0 };
    /** Draws a frame for `host`: pixels are the host handle, so a mixed-up read shows. */
    const draw = (host) => {
        const c = captures.get(host);
        if (!c || c.status !== CAPTURE_STATUS.requested) return;
        const [w, h] = canvasSizes[host];
        heap.fill(host, baseOf(host), baseOf(host) + w * h * 4);
        c.index = ++renderedFrames;
        c.status = manualPresent ? CAPTURE_STATUS.pending : CAPTURE_STATUS.ready;
    };
    const module = {
        HEAPU8: heap,
        /** @type {string[]} */
        log: [],
        ccall(name, _ret, _types, args) {
            if (name === 'set_active_host') active = Number(args[0]);
        },
        _get_active_host: () => active,
        _capture_frame_request() {
            module.log.push(`request:${active}`);
            captures.set(active, { status: CAPTURE_STATUS.requested, index: 0 });
            return 1;
        },
        _render_frame() {
            module.log.push(`render:${active}`);
            draw(active);
        },
        _capture_frame_resolve(wait) {
            const c = capture();
            if (c.status === CAPTURE_STATUS.pending && (wait || manualPresent)) {
                // A fence signals by the next poll; wait takes it at once.
                c.status = CAPTURE_STATUS.ready;
            }
            return c.status;
        },
        _capture_frame_width: () => canvasSizes[active][0],
        _capture_frame_height: () => canvasSizes[active][1],
        _capture_frame_data_ptr: () => (capture().status === CAPTURE_STATUS.ready ? baseOf(active) : 0),
        _capture_frame_index: () => capture().index,
        _capture_frame_release() {
            captures.set(active, { status: CAPTURE_STATUS.idle, index: 0 });
            heap.fill(0, baseOf(active), baseOf(active) + 4096);
        },
        /** The shared main loop: draws every host with a capture outstanding. */
        renderLoopTick() {
            for (const host of captures.keys()) draw(host);
        },
    };
    return module;
}

test('supportsFrameCapture tells a bundle with the export from one without', () => {
    assert.equal(supportsFrameCapture(fakeCaptureModule({ 0: [1, 1] })), true);
    assert.equal(supportsFrameCapture({}), false);
    assert.equal(supportsFrameCapture(null), false);
});

test('a live capture waits for the render loop to draw the frame, then copies it out', async () => {
    const module = fakeCaptureModule({ 0: [3, 2] });
    let ticks = 0;
    const frame = await captureFrameFromModule(module, {
        tick: async () => {
            ticks += 1;
            if (ticks === 2) module.renderLoopTick();
        },
    });
    assert.equal(ticks, 2, 'polled once per tick until the frame was drawn');
    assert.equal(frame.width, 3);
    assert.equal(frame.height, 2);
    assert.equal(frame.frameIndex, 1);
    assert.ok(frame.data instanceof Uint8ClampedArray);
    assert.equal(frame.data.length, 3 * 2 * 4);
    assert.deepEqual([...frame.data], new Array(24).fill(0));
    assert.equal(frame.data.buffer === module.HEAPU8.buffer, false, 'a copy, not a view of the heap');
    assert.ok(!module.log.includes('render:0'), 'a live capture never renders a frame itself');
});

test('renderFrame renders the frame itself and takes it without waiting a tick', async () => {
    const module = fakeCaptureModule({ 5: [2, 2] }, { manualPresent: true });
    module.ccall('set_active_host', null, ['number'], [5]);
    const frame = await captureFrameFromModule(module, {
        renderFrame: true,
        tick: async () => assert.fail('an offline capture must not wait for the render loop'),
    });
    assert.deepEqual(module.log, ['request:5', 'render:5']);
    assert.deepEqual([...frame.data], new Array(16).fill(5));
});

test('a manual-present capture is picked up once its read has finished', async () => {
    const module = fakeCaptureModule({ 0: [1, 1] }, { manualPresent: true });
    let ticks = 0;
    const frame = await captureFrameFromModule(module, {
        tick: async () => {
            ticks += 1;
            module.renderLoopTick();
        },
    });
    assert.equal(frame.width, 1);
    assert.ok(ticks >= 1);
});

test('a capture that never arrives times out and releases the request', async () => {
    const module = fakeCaptureModule({ 0: [1, 1] });
    let clock = 0;
    await assert.rejects(
        captureFrameFromModule(module, { timeoutMs: 30, now: () => clock, tick: async () => { clock += 10; } }),
        /no frame was rendered within 30 ms/,
    );
    assert.equal(module._capture_frame_resolve(0), CAPTURE_STATUS.idle);
});

test('a failed or refused capture rejects instead of hanging', async () => {
    const failed = fakeCaptureModule({ 0: [1, 1] });
    failed._capture_frame_resolve = () => CAPTURE_STATUS.failed;
    await assert.rejects(captureFrameFromModule(failed, { tick: async () => {} }), /could not be read \(status 4\)/);

    const noContext = fakeCaptureModule({ 0: [1, 1] });
    noContext._capture_frame_request = () => 0;
    await assert.rejects(captureFrameFromModule(noContext), /no WebGL context/);

    await assert.rejects(captureFrameFromModule({}), /predates frame capture/);
});

test('two contexts on one Module capture at the same time, each its own canvas and pixels', async () => {
    const module = fakeCaptureModule({ 1: [4, 3], 2: [2, 2] });
    const makeContext = (host, id) => {
        const context = new ProjectMContext({ canvas: { tagName: 'CANVAS', id, style: {}, width: 0, height: 0, parentElement: null } });
        context.module = /** @type {any} */ (module);
        context.hostHandle = host;
        context.transport = createModuleTransport(module, { host });
        return context;
    };
    const a = makeContext(1, 'capture-a');
    const b = makeContext(2, 'capture-b');

    // Both requests are outstanding before either frame is drawn, and the
    // loop renders the two engines in turn, leaving the other one active.
    const pendingA = a.captureFrame({ timeoutMs: 1000 });
    const pendingB = b.captureFrame({ timeoutMs: 1000 });
    const loop = setInterval(() => {
        module.renderLoopTick();
        module.ccall('set_active_host', null, ['number'], [2]);
    }, 2);
    try {
        const [frameA, frameB] = await Promise.all([pendingA, pendingB]);
        assert.deepEqual([frameA.width, frameA.height, frameA.data.length], [4, 3, 48]);
        assert.deepEqual([frameB.width, frameB.height, frameB.data.length], [2, 2, 16]);
        assert.ok(frameA.data.every((value) => value === 1), 'A got B\'s pixels');
        assert.ok(frameB.data.every((value) => value === 2), 'B got A\'s pixels');
    } finally {
        clearInterval(loop);
    }
});

test('captureFrame() before start() rejects', async () => {
    const context = new ProjectMContext({ canvas: { tagName: 'CANVAS', id: 'capture-early', style: {}, width: 0, height: 0, parentElement: null } });
    await assert.rejects(context.captureFrame(), /has not started/);
});

test('setFlashLimit and getFlashLimitStats go through the context\'s own engine', async () => {
    /** @type {Array<[string, number, unknown]>} */
    const calls = [];
    let active = 0;
    const module = {
        ccall: (name, _r, _t, args) => { if (name === 'set_active_host') active = Number(args[0]); },
        _get_active_host: () => active,
        _set_flash_limit_enabled: (v) => calls.push(['enabled', active, v]),
        _set_flash_limit_threshold: (v) => calls.push(['threshold', active, v]),
        _get_flash_limit_enabled: () => 1,
        _get_flash_limit_threshold: () => 0.06,
        _get_flash_limit_clamped_frames: () => active * 100,
    };
    const context = new ProjectMContext({ canvas: { tagName: 'CANVAS', id: 'flash-ctx', style: {}, width: 0, height: 0, parentElement: null } });
    assert.equal(await context.getFlashLimitStats(), null, 'nothing before start()');
    context.setFlashLimit(true); // no transport yet: a no-op, not a throw

    context.transport = createModuleTransport(module, { host: 4 });
    context.setFlashLimit(true, 0.03);
    context.setFlashLimit(false);
    assert.deepEqual(calls, [['threshold', 4, 0.03], ['enabled', 4, 1], ['enabled', 4, 0]]);
    assert.deepEqual(await context.getFlashLimitStats(), { enabled: true, threshold: 0.06, clampedFrames: 400 });

    // A bundle that predates the limiter.
    const old = new ProjectMContext({ canvas: { tagName: 'CANVAS', id: 'flash-old', style: {}, width: 0, height: 0, parentElement: null } });
    old.transport = createModuleTransport({ ccall() {}, _get_active_host: () => 0 }, { host: 0 });
    old.setFlashLimit(true);
    assert.equal(await old.getFlashLimitStats(), null);
});
