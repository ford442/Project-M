// Unit tests for html/projectm-render-transport.js — the one interface over
// the two render topologies.
//
// What these are really checking is that the same call, issued the same way,
// arrives at the engine correctly whichever side of postMessage it is on. The
// marshaling is generated (WASM_API_SIGNATURES in
// html/generated/projectm-wasm-api.js), so the interesting failures are the
// ones where the two transports disagree — a boolean that reaches the WASM
// boundary as `true` in one topology and `1` in the other, say.
//
// Run with: node --test tests/web/projectm-render-transport.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    canUseRenderWorker,
    createModuleTransport,
    createWorkerTransport,
    installTransportPcmWriter,
    selectRenderTopology,
} from '../../html/projectm-render-transport.js';

/**
 * A module recording every call that reaches the WASM boundary, with a PCM
 * ring shaped like the real one (see tests/web/projectm-pcm-ring.test.mjs).
 */
function fakeModule({ ring = true, capacityFrames = 4 } = {}) {
    const HEADER_PTR = 16;
    const DATA_PTR = 32;
    const memory = new ArrayBuffer(DATA_PTR + capacityFrames * 2 * 4);
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const calls = [];
    const record = (name) => (...args) => {
        calls.push({ name, args });
        return 0;
    };

    const module = {
        calls,
        HEAPF32: new Float32Array(memory),
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, capacityFrames * 2),
        _switch_preset: record('switch_preset'),
        _set_preset_locked: record('set_preset_locked'),
        _set_transparency_mode: record('set_transparency_mode'),
        _set_transparency_threshold: record('set_transparency_threshold'),
        _set_window_size: record('set_window_size'),
        _set_aspect_correction: record('set_aspect_correction'),
        _get_quality_tier: () => 2,
        _destruct: record('destruct'),
        _malloc: () => 0,
        _free: () => {},
        ccall: (name, _returnType, _argTypes, args) => {
            calls.push({ name, args });
            return `${name}-result`;
        },
        FS: {
            written: /** @type {Array<[string, Uint8Array]>} */ ([]),
            writeFile(path, bytes) { module.FS.written.push([path, bytes]); },
        },
    };

    if (ring) {
        module._get_pcm_ring_header_ptr = () => HEADER_PTR;
        module._get_pcm_ring_data_ptr = () => DATA_PTR;
        module._get_pcm_ring_capacity_frames = () => capacityFrames;
        module._get_pcm_ring_index_modulus = () => capacityFrames * 4;
    }
    return module;
}

/** A render-worker handle recording what the host would have posted. */
function fakeHandle() {
    const posted = [];
    return {
        posted,
        worker: { terminated: false, terminate() { this.terminated = true; } },
        getPcmRing: () => null,
        feedPcm: (buffer, channels) => posted.push({ kind: 'pcm', buffer, channels }),
        postResize: (width, height) => posted.push({ kind: 'resize', width, height }),
        postPcm: () => {},
        postPreset: (vfsPath, bytes, mode) => posted.push({ kind: 'preset', vfsPath, bytes, mode }),
        ccall: (name, returnType, argTypes, args) => {
            posted.push({ kind: 'ccall', name, returnType, argTypes, args });
            return Promise.resolve(`${name}-result`);
        },
        ccallVoid: (name, argTypes, args) => {
            posted.push({ kind: 'ccallVoid', name, argTypes, args });
        },
    };
}

test('both factories reject a missing engine rather than returning a half-dead transport', () => {
    assert.throws(() => createModuleTransport(null), /requires a module/);
    assert.throws(() => createWorkerTransport(null), /requires a render worker handle/);
});

test('the module transport reports its topology and exposes the module', () => {
    const module = fakeModule();
    const transport = createModuleTransport(module);
    assert.equal(transport.topology, 'main');
    assert.equal(transport.module, module);
    assert.equal(transport.workerHandle, null);
});

test('the worker transport reports its topology and exposes no module', () => {
    const handle = fakeHandle();
    const transport = createWorkerTransport(handle);
    assert.equal(transport.topology, 'worker');
    assert.equal(transport.module, null);
    assert.equal(transport.workerHandle, handle);
});

test('an unknown call name fails the same way in both topologies', async () => {
    const main = createModuleTransport(fakeModule());
    const worker = createWorkerTransport(fakeHandle());

    assert.throws(() => main.callVoid('noSuchCall'), /Unknown projectM API call/);
    assert.throws(() => worker.callVoid('noSuchCall'), /Unknown projectM API call/);
    await assert.rejects(() => main.call('noSuchCall'), /Unknown projectM API call/);
    assert.throws(() => worker.call('noSuchCall'), /Unknown projectM API call/);
});

test('the module transport dispatches through the generated wrappers', () => {
    const module = fakeModule();
    const transport = createModuleTransport(module);

    transport.callVoid('switchPreset');
    transport.callVoid('setPresetLocked', true);
    transport.callVoid('setTransparencyThreshold', 0.05);

    assert.deepEqual(module.calls, [
        { name: 'switch_preset', args: [] },
        // The generated wrapper coerces the boolean; the WASM boundary sees 1.
        { name: 'set_preset_locked', args: [1] },
        { name: 'set_transparency_threshold', args: [0.05] },
    ]);
});

test('the worker transport marshals the same calls from the generated signatures', () => {
    const handle = fakeHandle();
    const transport = createWorkerTransport(handle);

    transport.callVoid('switchPreset');
    transport.callVoid('setPresetLocked', true);
    transport.callVoid('setTransparencyThreshold', 0.05);

    assert.deepEqual(handle.posted, [
        { kind: 'ccallVoid', name: 'switch_preset', argTypes: [], args: [] },
        // Same 1, marshaled from paramTypes rather than hand-written here.
        { kind: 'ccallVoid', name: 'set_preset_locked', argTypes: ['number'], args: [1] },
        { kind: 'ccallVoid', name: 'set_transparency_threshold', argTypes: ['number'], args: [0.05] },
    ]);
});

test('a boolean argument reaches the WASM boundary as 0/1 in both topologies', () => {
    const module = fakeModule();
    createModuleTransport(module).callVoid('setPresetLocked', false);
    const handle = fakeHandle();
    createWorkerTransport(handle).callVoid('setPresetLocked', false);

    assert.deepEqual(module.calls[0].args, [0]);
    assert.deepEqual(handle.posted[0].args, [0]);
});

test('a string argument is marshaled as a string, not a pointer', () => {
    const handle = fakeHandle();
    createWorkerTransport(handle).callVoid('loadPresetFile', '/presets/x.milk');
    assert.deepEqual(handle.posted[0], {
        kind: 'ccallVoid',
        name: 'load_preset_file',
        argTypes: ['string'],
        args: ['/presets/x.milk'],
    });
});

test('call() resolves with the return value on both sides', async () => {
    const module = fakeModule();
    assert.equal(await createModuleTransport(module).call('getQualityTier'), 2);

    const handle = fakeHandle();
    assert.equal(await createWorkerTransport(handle).call('getQualityTier'), 'get_quality_tier-result');
    assert.deepEqual(handle.posted[0], {
        kind: 'ccall',
        name: 'get_quality_tier',
        returnType: 'number',
        argTypes: [],
        args: [],
    });
});

test('supports() is authoritative on the main thread and optimistic in the worker', () => {
    const module = fakeModule();
    delete module._set_aspect_correction;
    const main = createModuleTransport(module);
    assert.equal(main.supports('switchPreset'), true);
    assert.equal(main.supports('setAspectCorrection'), false);

    // Nothing to interrogate across postMessage — a missing export surfaces
    // later, as a ccall error.
    assert.equal(createWorkerTransport(fakeHandle()).supports('setAspectCorrection'), true);
});

test('resize goes to the engine on the main thread and to the worker otherwise', () => {
    const module = fakeModule();
    createModuleTransport(module).resize(800, 600);
    assert.deepEqual(module.calls, [{ name: 'set_window_size', args: [800, 600] }]);

    const handle = fakeHandle();
    createWorkerTransport(handle).resize(800, 600);
    assert.deepEqual(handle.posted, [{ kind: 'resize', width: 800, height: 600 }]);
});

test('resize is a no-op on a bundle that predates set_window_size', () => {
    const module = fakeModule();
    delete module._set_window_size;
    createModuleTransport(module).resize(800, 600);
    assert.deepEqual(module.calls, []);
});

test('feedPcm writes the module ring directly on the main thread', () => {
    const module = fakeModule();
    createModuleTransport(module).feedPcm(Float32Array.from([0.5, -0.5]), 2);

    assert.equal(module.header[0], 1, 'one stereo frame written');
    assert.deepEqual(Array.from(module.data.slice(0, 2)), [0.5, -0.5]);
});

test('feedPcm falls back to the marshaling path when the bundle has no ring', () => {
    const module = fakeModule({ ring: false });
    let fed = null;
    module._projectm_pcm_add_float_wrapper = (...args) => { fed = args; };
    createModuleTransport(module).feedPcm(Float32Array.from([0.5, -0.5, 0.25, -0.25]), 2);

    assert.ok(fed, 'the pre-ring path fed the engine');
    assert.equal(fed[2], 2, 'two frames per channel');
});

test('feedPcm hands the chunk to the handle in the worker topology', () => {
    const handle = fakeHandle();
    const buffer = Float32Array.from([0.5, -0.5]);
    createWorkerTransport(handle).feedPcm(buffer, 2);
    assert.deepEqual(handle.posted, [{ kind: 'pcm', buffer, channels: 2 }]);
});

test('writePreset writes the VFS then loads, in whichever mode was asked for', () => {
    const module = fakeModule();
    const transport = createModuleTransport(module);
    const bytes = Uint8Array.from([1, 2, 3]);

    transport.writePreset('/presets/a.milk', bytes);
    transport.writePreset('/presets/b.milk', bytes, 'load-hard');
    transport.writePreset('/presets/c.milk', bytes, 'add');

    assert.deepEqual(module.FS.written.map(([path]) => path), [
        '/presets/a.milk', '/presets/b.milk', '/presets/c.milk',
    ]);
    assert.deepEqual(module.calls.map((call) => call.name), [
        'load_preset_file', 'load_preset_file_hard', 'add_preset_file',
    ]);
});

test('writePreset refuses a module with no filesystem instead of silently dropping it', () => {
    const module = fakeModule();
    delete module.FS;
    assert.throws(
        () => createModuleTransport(module).writePreset('/presets/a.milk', Uint8Array.of(1)),
        /Module.FS not available/,
    );
});

test('writePreset crosses to the worker as a preset message', () => {
    const handle = fakeHandle();
    const bytes = Uint8Array.from([1, 2, 3]);
    createWorkerTransport(handle).writePreset('/presets/a.milk', bytes, 'add');
    assert.deepEqual(handle.posted, [
        { kind: 'preset', vfsPath: '/presets/a.milk', bytes, mode: 'add' },
    ]);
});

test('destroy tears down the module on the main thread and the worker otherwise', () => {
    const module = fakeModule();
    createModuleTransport(module).destroy();
    assert.deepEqual(module.calls, [{ name: 'destruct', args: [] }]);

    const handle = fakeHandle();
    createWorkerTransport(handle).destroy();
    assert.equal(handle.worker.terminated, true);
});

test('installTransportPcmWriter points the baked worklet handler at the transport', () => {
    const handle = fakeHandle();
    const remove = installTransportPcmWriter(createWorkerTransport(handle));

    const buffer = Float32Array.from([0.25, 0.5]);
    globalThis.projectMWritePcmRing(buffer);
    assert.deepEqual(handle.posted, [{ kind: 'pcm', buffer, channels: 2 }]);

    remove();
    assert.equal(globalThis.projectMWritePcmRing, undefined);
});

test('canUseRenderWorker requires cross-origin isolation as well as the APIs', () => {
    const canvas = { transferControlToOffscreen() { return {}; } };
    globalThis.Worker = class {};
    globalThis.OffscreenCanvas = class {};
    try {
        assert.equal(canUseRenderWorker({ canvas, crossOriginIsolated: true }), true);
        // No SharedArrayBuffer means no shared module heap: the ring would
        // degrade to a postMessage per audio callback.
        assert.equal(canUseRenderWorker({ canvas, crossOriginIsolated: false }), false);
        assert.equal(canUseRenderWorker({ canvas: null, crossOriginIsolated: true }), false);
    } finally {
        delete globalThis.Worker;
        delete globalThis.OffscreenCanvas;
    }
});

test('selectRenderTopology returns null without starting anything when the worker is not wanted', async () => {
    assert.equal(await selectRenderTopology({ canvas: {}, preferWorker: false }), null);
});

test('selectRenderTopology falls back, with a reason, when the platform cannot host a worker', async () => {
    const reasons = [];
    const transport = await selectRenderTopology({
        canvas: null,
        preferWorker: true,
        onFallback: (reason) => reasons.push(reason),
    });
    assert.equal(transport, null);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /OffscreenCanvas, Worker, or cross-origin isolation unavailable/);
});
