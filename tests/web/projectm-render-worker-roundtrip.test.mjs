// Round-trip tests for the render-worker wire protocol.
//
// tests/web/projectm-render-worker-host.test.mjs and
// tests/web/projectm-render-worker.test.mjs each drive one half against a mock
// of the other, which is exactly the shape of test that cannot see a protocol
// disagreement: both halves can be internally consistent and still not talk to
// each other. The drift test at the end of the worker suite catches a renamed
// message *type*; it cannot catch a renamed or reordered field inside one.
//
// So this file connects the two real implementations. The host half is the
// real setupRenderWorker(); the worker half is the real
// projectm-render-worker.js evaluated in a classic-worker scope via node:vm
// (the same trick the worker suite uses — it is a non-module script that
// assigns to a bare `self`). A Worker stand-in wires their postMessage calls
// to each other, so every assertion here is about a message that actually made
// the trip.
//
// Run with: node --test tests/web/projectm-render-worker-roundtrip.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { setupRenderWorker } from '../../html/projectm-render-worker-host.js';
import { createWorkerTransport } from '../../html/projectm-render-transport.js';

const WORKER_PATH = fileURLToPath(new URL('../../html/projectm-render-worker.js', import.meta.url));
const WORKER_SOURCE = readFileSync(WORKER_PATH, 'utf8');

const HEADER_PTR = 16;
const DATA_PTR = 32;
const CAPACITY_FRAMES = 8;

/** The engine, as the worker sees it after importScripts() + createModule(). */
function engineModule({ shared = true } = {}) {
    const byteLength = DATA_PTR + CAPACITY_FRAMES * 2 * 4;
    const memory = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const ccalls = [];
    /** @type {Array<[string, Uint8Array]>} */
    const written = [];
    return {
        HEAPF32: new Float32Array(memory),
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, CAPACITY_FRAMES * 2),
        ccalls,
        written,
        sizes: /** @type {Array<[number, number]>} */ ([]),
        _get_pcm_ring_header_ptr: () => HEADER_PTR,
        _get_pcm_ring_data_ptr: () => DATA_PTR,
        _get_pcm_ring_capacity_frames: () => CAPACITY_FRAMES,
        _get_pcm_ring_index_modulus: () => CAPACITY_FRAMES * 4,
        specialHTMLTargets: /** @type {Record<string, unknown>} */ ({}),
        _init: () => 0,
        _start_render: () => {},
        _get_quality_tier: () => 1,
        _dual_fbo_get_format: () => 0,
        _get_governor_render_scale: () => 1,
        get _set_window_size() {
            return (w, h) => this.sizes.push([w, h]);
        },
        FS: { writeFile: (path, bytes) => written.push([path, bytes]) },
        ccall(name, _returnType, _argTypes, args) {
            ccalls.push({ name, args });
            return `${name}-ok`;
        },
    };
}

/**
 * A Worker stand-in whose postMessage lands in a real worker scope, and whose
 * scope's postMessage lands back on the host's onmessage. Message delivery is
 * asynchronous in both directions, as it is in a browser.
 */
function connectedWorker(module) {
    /** @type {any} */
    const host = { onmessage: null, onerror: null };
    /** @type {Array<() => void>} */
    const intervals = [];
    /** @type {Array<Promise<void>>} */
    const inFlight = [];

    const workerSelf = {
        onmessage: null,
        postMessage: (message) => {
            // Structured clone drops the prototype but keeps the fields; a
            // plain spread is close enough and keeps deepEqual honest about
            // which realm the object came from.
            const data = { ...message };
            inFlight.push(Promise.resolve().then(() => host.onmessage?.({ data })));
        },
    };

    const sandbox = {
        self: workerSelf,
        console,
        SharedArrayBuffer,
        ArrayBuffer,
        Atomics,
        Int32Array,
        Float32Array,
        Uint8Array,
        performance,
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        clearInterval: () => {},
        OffscreenCanvas: class {},
        // Onto `self`: in a worker that IS the global, and it is where the
        // worker reads the factory from (see getCreateModule() there).
        importScripts: () => { workerSelf.createModule = async () => module; },
    };
    vm.createContext(sandbox);
    vm.runInContext(WORKER_SOURCE, sandbox, { filename: WORKER_PATH });

    host.postMessage = (message, _transfer) => {
        const data = { ...message };
        inFlight.push(Promise.resolve().then(() => workerSelf.onmessage?.({ data })));
    };
    host.terminate = () => { host.terminated = true; };
    /** The worker's own global, for hooks the engine calls on it directly. */
    host.scope = workerSelf;
    host.tickStats = () => intervals.forEach((fn) => fn());
    host.settle = async () => {
        // Both directions are promise-tailed; a few turns drain init()'s awaits
        // and any reply it triggers.
        for (let i = 0; i < 8; i += 1) {
            await Promise.all(inFlight.splice(0));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    return host;
}

/**
 * Boots the real host half against the real worker half and waits for 'ready'.
 *
 * @param {object} [options]
 * @param {boolean} [options.shared] Whether the engine's heap can be shared.
 */
async function connect({ shared = true } = {}) {
    const module = engineModule({ shared });
    /** @type {any} */
    let worker;
    const previousWorker = globalThis.Worker;
    const previousOffscreen = globalThis.OffscreenCanvas;
    globalThis.Worker = class {
        constructor() {
            worker = connectedWorker(module);
            return worker;
        }
    };
    globalThis.OffscreenCanvas = class {};

    const events = { ready: 0, errors: [], stats: [], fallbacks: [] };
    let handle;
    try {
        handle = setupRenderWorker({
            canvas: { transferControlToOffscreen: () => ({}) },
            scriptSrc: 'https://projectm.test/pm/projectm-v.036-thread.js',
            width: 1280,
            height: 720,
            targetFps: 60,
            governor: true,
            meshQuality: 'high',
            onReady: () => { events.ready += 1; },
            onError: (message) => events.errors.push(message),
            onStats: (stats) => events.stats.push(stats),
            onUnsupported: (reason) => events.fallbacks.push(reason),
        });
    } finally {
        globalThis.Worker = previousWorker;
        globalThis.OffscreenCanvas = previousOffscreen;
        if (previousWorker === undefined) delete globalThis.Worker;
        if (previousOffscreen === undefined) delete globalThis.OffscreenCanvas;
    }

    await worker.settle();
    return { handle, module, worker, events, transport: createWorkerTransport(handle) };
}

test('the init handshake completes end to end', async () => {
    const { events, module } = await connect();

    assert.equal(events.ready, 1, 'the host saw ready');
    assert.deepEqual(events.fallbacks, []);
    assert.deepEqual(events.errors, []);
    // The worker sized its own surface from the init message, which is the
    // half of resize the host cannot do once it has transferred the canvas.
    assert.deepEqual(module.sizes.at(-1), [1280, 720]);
});

test('a shareable engine heap reaches the host as a usable ring writer', async () => {
    const { handle, module } = await connect({ shared: true });

    const ring = handle.getPcmRing();
    assert.ok(ring, 'the host mapped the descriptor the worker posted');
    assert.equal(ring.capacityFrames, CAPACITY_FRAMES);

    // Writing through the host's mapping must land in the worker module's own
    // heap — that is the entire claim the descriptor makes.
    handle.feedPcm(Float32Array.from([0.5, -0.5]), 2);
    assert.deepEqual(Array.from(module.data.slice(0, 2)), [0.5, -0.5]);
    assert.equal(module.header[0], 1);
});

test('without a shareable heap the same PCM still arrives, over postMessage', async () => {
    const { handle, module, worker } = await connect({ shared: false });

    assert.equal(handle.getPcmRing(), null, 'no descriptor: a plain ArrayBuffer cannot be shared');

    handle.feedPcm(Float32Array.from([0.25, -0.25]), 2);
    await worker.settle();

    assert.deepEqual(Array.from(module.data.slice(0, 2)), [0.25, -0.25]);
    assert.equal(module.header[0], 1, 'the worker wrote it into the same ring on arrival');
});

test('mono PCM is duplicated to both channels whichever transport carried it', async () => {
    const shared = await connect({ shared: true });
    shared.handle.feedPcm(Float32Array.from([0.75]), 1);
    assert.deepEqual(Array.from(shared.module.data.slice(0, 2)), [0.75, 0.75]);

    const posted = await connect({ shared: false });
    posted.handle.feedPcm(Float32Array.from([0.75]), 1);
    await posted.worker.settle();
    assert.deepEqual(Array.from(posted.module.data.slice(0, 2)), [0.75, 0.75]);
});

test('a transport ccall reaches the engine and its result comes back', async () => {
    const { transport, module, worker } = await connect();

    const pending = transport.call('getTransparencyMode');
    await worker.settle();
    assert.equal(await pending, 'get_transparency_mode-ok');
    assert.deepEqual(module.ccalls.at(-1), { name: 'get_transparency_mode', args: [] });
});

test('a fire-and-forget transport call reaches the engine with coerced arguments', async () => {
    const { transport, module, worker } = await connect();

    transport.callVoid('setPresetLocked', true);
    await worker.settle();

    assert.deepEqual(module.ccalls.at(-1), { name: 'set_preset_locked', args: [1] });
});

test('an engine call that throws is reported to the host rather than lost', async () => {
    const { transport, module, worker, events } = await connect();
    module.ccall = () => { throw new Error('boom'); };

    transport.callVoid('switchPreset');
    await worker.settle();

    assert.equal(events.errors.length, 1);
    assert.match(events.errors[0], /ccall switch_preset failed.*boom/);
});

test('a preset crosses as bytes and is written into the worker module filesystem', async () => {
    const { transport, module, worker } = await connect();

    transport.writePreset('/presets/round.milk', Uint8Array.from([109, 105, 108, 107]));
    await worker.settle();

    assert.equal(module.written.length, 1);
    const [path, bytes] = module.written[0];
    assert.equal(path, '/presets/round.milk');
    assert.deepEqual(Array.from(bytes), [109, 105, 108, 107]);
    // The worker builds this argument array inside its own realm, so compare
    // the contents rather than the (deliberately foreign) array identity.
    const call = module.ccalls.at(-1);
    assert.equal(call.name, 'load_preset_file');
    assert.deepEqual(Array.from(call.args), ['/presets/round.milk']);
});

test('each preset mode maps to its own engine call', async () => {
    const { transport, module, worker } = await connect();
    const bytes = Uint8Array.of(1);

    transport.writePreset('/presets/a.milk', bytes, 'load-hard');
    transport.writePreset('/presets/b.milk', bytes, 'add');
    await worker.settle();

    assert.deepEqual(module.ccalls.map((call) => call.name), [
        'load_preset_file_hard', 'add_preset_file',
    ]);
});

test('a preset write that the filesystem rejects surfaces as an error, not a silent miss', async () => {
    const { transport, module, worker, events } = await connect();
    module.FS.writeFile = () => { throw new Error('no space'); };

    transport.writePreset('/presets/a.milk', Uint8Array.of(1));
    await worker.settle();

    assert.equal(events.errors.length, 1);
    assert.match(events.errors[0], /preset write failed for \/presets\/a\.milk.*no space/);
    assert.deepEqual(module.ccalls, [], 'and the load was not attempted against a path with no file');
});

test('a resize crosses as the layout size and the worker applies it to its own surface', async () => {
    const { transport, module, worker } = await connect();

    transport.resize(640, 480);
    await worker.settle();

    assert.deepEqual(module.sizes.at(-1), [640, 480]);
});

test('a governor render-scale change resizes the worker surface without a host round trip', async () => {
    const { transport, module, worker, events } = await connect();

    transport.resize(1000, 500);
    await worker.settle();
    assert.deepEqual(module.sizes.at(-1), [1000, 500]);

    // WasmPerfGovernor.cpp calls this on globalThis, which inside a worker is
    // the worker scope — the hook that the src/wasm/ globalThis migration made
    // reachable off the main thread, and that governor v2 needs to apply its
    // internal render scale here.
    assert.equal(typeof worker.scope.pmOnGovernorRenderScaleChange, 'function');
    worker.scope.pmOnGovernorRenderScaleChange(0.5);

    assert.deepEqual(module.sizes.at(-1), [500, 250], 'backing store stepped down by the tier');

    // And the host is not involved: the layout size it sent is unchanged, so a
    // later resize still means layout pixels, not already-scaled ones.
    transport.resize(1000, 500);
    await worker.settle();
    assert.deepEqual(module.sizes.at(-1), [500, 250], 'the scale still applies to the new layout size');

    worker.tickStats();
    await worker.settle();
    assert.equal(events.stats.at(-1).renderScale, 0.5, 'and the host is told the effective scale');
});

test('stats come back to the host carrying the render scale', async () => {
    const { events, worker } = await connect();

    worker.tickStats();
    await worker.settle();

    assert.equal(events.stats.length, 1);
    const stats = events.stats[0];
    assert.equal(stats.type, 'stats');
    assert.equal(stats.qualityTier, 1);
    assert.equal(stats.fboFormat, 0);
    assert.equal(stats.renderScale, 1);
    assert.equal(typeof stats.fps, 'number');
});
