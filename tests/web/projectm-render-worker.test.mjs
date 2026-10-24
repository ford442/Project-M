// Unit tests for html/projectm-render-worker.js — the worker half of the
// OffscreenCanvas render-worker wire protocol — and for the protocol itself.
// Run with: node --test tests/web/projectm-render-worker.test.mjs
//
// The worker is a *classic* (non-module) Worker script: it assigns to a bare
// `self`, reads the Emscripten factory `importScripts()` defines as
// `self.createModule`, and has no exports. Importing it under Node's ESM loader
// therefore cannot drive it —
// which is why it had no tests. `node:vm` can: evaluating the source in a
// context whose global carries `self`, `importScripts`, `performance` and
// `setInterval` reproduces the classic-worker scope closely enough to exercise
// the real message handler, with no production refactor and no browser.
//
// The last test in this file is the other half of the same problem: the two
// implementations agree on a wire format written down only in
// projectm-render-worker-types.ts, so a message type renamed on one side is a
// silent runtime failure. That test reads all three files and fails when they
// drift apart.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const WORKER_PATH = fileURLToPath(new URL('../../html/projectm-render-worker.js', import.meta.url));
const HOST_PATH = fileURLToPath(new URL('../../html/projectm-render-worker-host.js', import.meta.url));
const TYPES_PATH = fileURLToPath(new URL('../../html/projectm-render-worker-types.ts', import.meta.url));

const WORKER_SOURCE = readFileSync(WORKER_PATH, 'utf8');

// The bundler-scope variant evaluates a *wrapped* copy of the same source. It
// has to be attributed to a different filename, or V8 coverage folds two texts
// with different line offsets into one report entry for the real worker and its
// numbers become fiction. This path is under tests/, which
// scripts/test_web_embed.sh excludes from coverage entirely.
const BUNDLER_SCOPE_PATH = fileURLToPath(
    new URL('./projectm-render-worker.bundler-scope.js', import.meta.url),
);

// Non-zero heap offsets, as in tests/web/projectm-pcm-ring.test.mjs: the
// descriptor reader treats a zero data pointer as "not allocated yet".
const HEADER_PTR = 16;
const DATA_PTR = 32;

/**
 * A module exposing the WASM PCM ring exports over a fake heap.
 *
 * @param {object} [options]
 * @param {number} [options.capacityFrames]
 * @param {boolean} [options.shared] Back the heap with a SharedArrayBuffer,
 *   as a cross-origin-isolated page does.
 */
function fakeRingModule({ capacityFrames = 4, shared = true } = {}) {
    const byteLength = DATA_PTR + capacityFrames * 2 * 4;
    const memory = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const ccalls = [];
    /** @type {Array<[number, number]>} */
    const startRenders = [];
    /** @type {unknown[][]} create_host_with_config()'s arguments, per call. */
    const creates = [];
    let lastInitError = 0;
    // Models the C++ registry's active host: create_host_with_config() makes the
    // new engine (handle 1) active, set_active_host() switches.
    let activeHost = 0;
    const module = {
        HEAPF32: new Float32Array(memory),
        _get_active_host: () => activeHost,
        _get_pcm_ring_header_ptr: () => HEADER_PTR,
        _get_pcm_ring_data_ptr: () => DATA_PTR,
        _get_pcm_ring_capacity_frames: () => capacityFrames,
        _get_pcm_ring_index_modulus: () => capacityFrames * 4,
        // The worker registers the transferred canvas here and runs init()
        // itself, because the engine resolves "#mcanvas" through
        // specialHTMLTargets when there is no document.
        specialHTMLTargets: /** @type {Record<string, unknown>} */ ({}),
        _init: () => 0,
        _start_render: (w, h) => startRenders.push([w, h]),
        // Presence marks a bundle that has the export; the worker calls it
        // through ccall (it takes strings).
        _create_host_with_config: () => { throw new Error('call create_host_with_config through ccall'); },
        _get_last_init_error: () => lastInitError,
        ccall: (/** @type {string} */ name, /** @type {unknown} */ _returnType, /** @type {unknown} */ _argTypes, /** @type {unknown[]} */ args) => {
            if (name === 'create_host_with_config') {
                // Models the C++ export: the config is stored on the new host,
                // then init() builds the engine; 0 handle on failure.
                creates.push([...args]); // built in the vm realm: copy before deepEqual
                const status = module._init();
                lastInitError = status;
                if (status === 0) activeHost = 1;
                return status === 0 ? 1 : 0;
            }
            if (name === 'set_active_host') activeHost = Number(args[0]);
            ccalls.push({ name, args });
            return `${name}-result`;
        },
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, capacityFrames * 2),
        memory,
        ccalls,
        creates,
        startRenders,
    };
    return module;
}

/**
 * Evaluates the worker script in a fake classic-worker global scope.
 *
 * @param {object} [options]
 * @param {((config: Record<string, unknown>) => Promise<any>) | null} [options.createModule]
 *   What `importScripts()` should define. null leaves it undefined.
 * @param {Error | null} [options.importScriptsError]
 * @param {boolean} [options.offscreenCanvas] Whether the scope has OffscreenCanvas.
 * @param {boolean} [options.sharedArrayBuffer]
 * @param {boolean} [options.bundlerScope] Evaluate the source wrapped in a
 *   strict-mode function scope, the way a bundler that treats the file as a
 *   module or an IIFE does. Top-level declarations stop being globals there.
 */
function loadWorker({
    createModule = null,
    importScriptsError = null,
    offscreenCanvas = true,
    sharedArrayBuffer = true,
    bundlerScope = false,
} = {}) {
    /** @type {any[]} */
    const posted = [];
    /** @type {string[]} */
    const importedScripts = [];
    /** @type {Array<() => void>} */
    const intervals = [];

    const self = {
        onmessage: null,
        // Spread into an object from this realm: messages built inside the vm
        // context carry that context's Object.prototype, which deepEqual reads
        // as a different type.
        postMessage: (message) => posted.push({ ...message }),
    };

    const sandbox = {
        self,
        console,
        // Injected from this realm so `instanceof SharedArrayBuffer` and the
        // Atomics the worker uses match the buffers the test creates.
        SharedArrayBuffer: sharedArrayBuffer ? SharedArrayBuffer : undefined,
        Atomics,
        Int32Array,
        Float32Array,
        performance,
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        // Real timers: captureFrame() polls with them while the frame renders.
        setTimeout,
        clearInterval: () => {},
        OffscreenCanvas: offscreenCanvas ? class {} : undefined,
        importScripts: (src) => {
            importedScripts.push(src);
            if (importScriptsError) throw importScriptsError;
            // Onto `self`, because that is where importScripts() puts it: in a
            // worker `self` IS the global scope. Assigning it as a bare sandbox
            // global instead would only work through the equivalence that
            // bundlers break — see getCreateModule() in the worker.
            if (createModule) self.createModule = createModule;
        },
    };
    if (!sharedArrayBuffer) delete sandbox.SharedArrayBuffer;
    if (!offscreenCanvas) delete sandbox.OffscreenCanvas;

    vm.createContext(sandbox);
    const source = bundlerScope
        ? `(function(){"use strict";\n${WORKER_SOURCE}\n})();`
        : WORKER_SOURCE;
    vm.runInContext(source, sandbox, {
        filename: bundlerScope ? BUNDLER_SCOPE_PATH : WORKER_PATH,
    });

    return {
        posted,
        importedScripts,
        /** The worker's global scope, where the engine's EM_JS callbacks land. */
        scope: self,
        /** Fires the interval callback the worker registered for stats. */
        tickStats: () => intervals.forEach((fn) => fn()),
        /** @param {any} data */
        async send(data) {
            self.onmessage({ data });
            // init() is async; let its awaits settle before asserting.
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
}

/** The init message the host posts (see setupRenderWorker()). */
function initMessage(overrides = {}) {
    return {
        type: 'init',
        canvas: {},
        scriptSrc: 'https://projectm.test/pm/projectm-v.036-thread.js',
        width: 1280,
        height: 720,
        // resolveWasmContextConfig()'s defaults: contextAlpha + premultipliedAlpha.
        contextConfig: { flags: 48, powerPreference: 2, fboPrecision: 0 },
        ...overrides,
    };
}

test('init reports unsupported when the worker scope has no OffscreenCanvas', async () => {
    const worker = loadWorker({ offscreenCanvas: false });
    await worker.send(initMessage());
    assert.deepEqual(worker.posted, [{
        type: 'unsupported',
        reason: 'OffscreenCanvas or importScripts unavailable in worker',
    }]);
});

test('init reports unsupported when the WASM glue fails to load', async () => {
    const worker = loadWorker({ importScriptsError: new Error('404') });
    await worker.send(initMessage());
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'unsupported');
    assert.match(worker.posted[0].reason, /failed to load https:\/\/projectm\.test\/pm\/projectm-v\.036-thread\.js/);
});

test('init reports unsupported when the glue defines no createModule', async () => {
    const worker = loadWorker({ createModule: null });
    await worker.send(initMessage());
    assert.deepEqual(worker.posted, [{
        type: 'unsupported',
        reason: 'createModule not defined after importScripts',
    }]);
});

test('the worker still finds its factory when a bundler wraps it in a scope', async () => {
    // Regression test for the whole worker render topology under npm consumers.
    //
    // The worker is loaded as `new Worker(new URL('./projectm-render-worker.js',
    // import.meta.url))`, and Vite (and any bundler with the same pattern
    // support) re-processes that file into its own scope. A top-level
    // `var createModule` is the worker global in a classic worker but a plain
    // local once wrapped, so importScripts() could never fill it: init() bailed
    // with "createModule not defined after importScripts", and a minifier that
    // could prove that then dead-code-eliminated the preset and ccall handlers.
    // Reading `self.createModule` survives the wrapping.
    const module = fakeRingModule();
    const worker = loadWorker({ bundlerScope: true, createModule: async () => module });
    await worker.send(initMessage());

    assert.deepEqual(
        worker.posted.filter((message) => message.type === 'unsupported'),
        [],
        'the worker reported unsupported inside a bundler scope',
    );
    assert.ok(
        worker.posted.some((message) => message.type === 'ready'),
        'the worker never reported ready inside a bundler scope',
    );
});

test('init reports an error when the module factory rejects', async () => {
    const worker = loadWorker({ createModule: async () => { throw new Error('out of memory'); } });
    await worker.send(initMessage());
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'error');
    assert.match(worker.posted[0].message, /module init failed: Error: out of memory/);
});

test('init boots the module, applies the options, publishes the ring, and reports ready', async () => {
    const module = fakeRingModule();
    /** @type {number[]} */
    const targetFps = [];
    /** @type {number[]} */
    const governor = [];
    /** @type {Array<[number, number]>} */
    const mesh = [];
    module._set_target_fps = (fps) => targetFps.push(fps);
    module._set_quality_governor = (on) => governor.push(on);
    module._set_mesh = (x, y) => mesh.push([x, y]);

    /** @type {Record<string, unknown> | null} */
    let factoryConfig = null;
    const worker = loadWorker({
        createModule: async (config) => { factoryConfig = config; return module; },
    });

    const canvas = {};
    await worker.send(initMessage({ canvas, targetFps: 45, governor: false, meshQuality: 'low' }));

    assert.deepEqual(worker.importedScripts, ['https://projectm.test/pm/projectm-v.036-thread.js']);
    // The transferred OffscreenCanvas is what the module renders into.
    assert.equal(factoryConfig.canvas, canvas);
    assert.deepEqual(module.startRenders, [[1280, 720]]);
    assert.deepEqual(targetFps, [45]);
    assert.deepEqual(governor, [0], 'governor:false must reach the module as 0, not be skipped');
    assert.deepEqual(mesh, [[64, 48]]);

    const types = worker.posted.map((m) => m.type);
    assert.deepEqual(types, ['pcm-ring', 'ready'], 'the ring is published before ready');
    const descriptor = worker.posted[0].descriptor;
    assert.equal(descriptor.memory, module.memory);
    assert.equal(descriptor.headerPtr, HEADER_PTR);
    assert.equal(descriptor.dataPtr, DATA_PTR);
    assert.equal(descriptor.capacityFrames, 4);
    assert.equal(descriptor.indexModulus, 16);
});

test('init applies the render-path switches, then creates the engine with the context config', async () => {
    const module = fakeRingModule();
    /** @type {string[]} */
    const order = [];
    // Models the C++ side: set_render_path_overrides() sets the environment the
    // engine reads, get_render_path_overrides() reads it back as a mask.
    let overrideMask = 0;
    module._set_render_path_overrides = (blur, copy, perPixel) => {
        order.push('set_render_path_overrides');
        overrideMask = (blur ? 1 : 0) | (copy ? 2 : 0) | (perPixel ? 4 : 0);
    };
    module._get_render_path_overrides = () => overrideMask;
    const init = module._init;
    module._init = () => { order.push('init'); return init(); };

    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({
        // antialias + contextAlpha + premultipliedAlpha, RGBA32F.
        contextConfig: { flags: 1 | 16 | 32, powerPreference: 2, fboPrecision: 1 },
        // What resolveRenderPathOverrides('?blurPath=copy') produces on the page.
        renderPathOverrides: { blurCopyPath: true, copyShaderPath: false, perPixelForceCpu: false },
    }));

    // The render paths are fixed before the first preset; the context
    // attributes are an argument of the create call that makes the context.
    assert.deepEqual(order, ['set_render_path_overrides', 'init']);
    assert.deepEqual(module.creates, [['#mcanvas', '', 49, 2, 1]]);
    assert.deepEqual(module.ccalls, [], 'no separate set_context_config step');

    // Read back through the stats tick: the switch reached the worker's module.
    worker.posted.length = 0;
    worker.tickStats();
    assert.equal(worker.posted[0].renderPathOverrides, 1);
});

test('init without render-path switches leaves the module defaults alone', async () => {
    const module = fakeRingModule();
    let called = false;
    module._set_render_path_overrides = () => { called = true; };
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    assert.equal(called, false);
    assert.deepEqual(module.ccalls, []);
    assert.deepEqual(module.creates, [['#mcanvas', '', 48, 2, 0]]);
    assert.equal(worker.posted.at(-1).type, 'ready');
});

test('a bundle without create_host_with_config is unsupported, so the host renders on the main thread', async () => {
    const module = fakeRingModule();
    delete module._create_host_with_config;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'unsupported');
    assert.match(worker.posted[0].reason, /create_host_with_config/);
    assert.deepEqual(module.creates, []);
    assert.deepEqual(module.startRenders, []);
});

test('init registers the transferred canvas under the engine canvas selector', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    const canvas = { id: 'offscreen' };
    await worker.send(initMessage({ canvas }));

    // This is how the engine finds its drawing surface with no document around:
    // emscripten_webgl_create_context("#mcanvas") resolves through
    // specialHTMLTargets first.
    assert.equal(module.specialHTMLTargets['#mcanvas'], canvas);
});

test('init reports unsupported on a bundle that does not export specialHTMLTargets', async () => {
    const module = fakeRingModule();
    delete module.specialHTMLTargets;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'unsupported');
    assert.match(worker.posted[0].reason, /specialHTMLTargets/);
});

test('a failed engine creation is reported with its init code instead of trapping in start_render', async () => {
    const module = fakeRingModule();
    module._init = () => 8; // failIfMajorPerformanceCaveat refused a software context
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ contextConfig: { flags: 48 | 64, powerPreference: 2, fboPrecision: 0 } }));

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'error');
    assert.equal(worker.posted[0].code, 8);
    assert.match(worker.posted[0].message, /engine creation failed in the render worker \(init code 8\)/);
    // start_render() on an engine with no GL context traps on a null function
    // pointer, which surfaces as an unattributable RuntimeError.
    assert.deepEqual(module.startRenders, []);
});

test('the mesh quality option maps anything but "low" to the full grid', async () => {
    const module = fakeRingModule();
    /** @type {Array<[number, number]>} */
    const mesh = [];
    module._set_mesh = (x, y) => mesh.push([x, y]);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ meshQuality: 'high' }));
    assert.deepEqual(mesh, [[80, 60]]);
});

test('a module heap that cannot be shared publishes no ring, leaving the host on postMessage', async () => {
    const module = fakeRingModule({ shared: false });
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    assert.deepEqual(worker.posted.map((m) => m.type), ['ready']);
});

test('a module without the ring exports publishes no ring', async () => {
    const module = fakeRingModule();
    delete module._get_pcm_ring_data_ptr;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    assert.deepEqual(worker.posted.map((m) => m.type), ['ready']);
});

test('the ring is allocated on demand when the engine has not built it yet', async () => {
    const module = fakeRingModule();
    let allocated = false;
    let initCalls = 0;
    module._get_pcm_ring_data_ptr = () => (allocated ? DATA_PTR : 0);
    module._pcm_ring_init = () => { initCalls += 1; allocated = true; };

    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    assert.ok(initCalls >= 1, 'the worker should have asked the engine to allocate the ring');
    assert.deepEqual(worker.posted.map((m) => m.type), ['pcm-ring', 'ready']);
});

test('resize forwards the new size to the module', async () => {
    const module = fakeRingModule();
    /** @type {Array<[number, number]>} */
    const sizes = [];
    module._set_window_size = (w, h) => sizes.push([w, h]);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'resize', width: 800, height: 600 });
    assert.deepEqual(sizes, [[800, 600]]);
});

test('resize before the module exists is ignored rather than throwing', async () => {
    const worker = loadWorker({ createModule: null });
    await worker.send({ type: 'resize', width: 800, height: 600 });
    assert.deepEqual(worker.posted, []);
});

test('an unknown message type is ignored', async () => {
    const worker = loadWorker({ createModule: null });
    await worker.send({ type: 'nonsense' });
    assert.deepEqual(worker.posted, []);
});

test('posted stereo PCM is written into the module ring and the write index published', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'pcm', buffer: new Float32Array([1, 2, 3, 4]), channels: 2 });

    assert.deepEqual([...module.data], [1, 2, 3, 4, 0, 0, 0, 0]);
    assert.equal(Atomics.load(module.header, 0), 2);
});

test('posted mono PCM is duplicated into both channels', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'pcm', buffer: new Float32Array([7, 8]), channels: 1 });

    assert.deepEqual([...module.data], [7, 7, 8, 8, 0, 0, 0, 0]);
    assert.equal(Atomics.load(module.header, 0), 2);
});

test('the ring wraps and the write index advances modulo indexModulus', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    // Three frames into a four-frame ring, then three more: the last two wrap
    // over slots 0 and 1, and the index (6) stays below the modulus (16).
    await worker.send({ type: 'pcm', buffer: new Float32Array([1, 1, 2, 2, 3, 3]), channels: 2 });
    await worker.send({ type: 'pcm', buffer: new Float32Array([4, 4, 5, 5, 6, 6]), channels: 2 });

    assert.deepEqual([...module.data], [5, 5, 6, 6, 3, 3, 4, 4]);
    assert.equal(Atomics.load(module.header, 0), 6);

    // The index counts frames modulo indexModulus (16), not modulo the ring
    // capacity, so it keeps climbing past a full lap before wrapping.
    for (const expected of [10, 14, 2]) {
        await worker.send({ type: 'pcm', buffer: new Float32Array([9, 9, 9, 9, 9, 9, 9, 9]), channels: 2 });
        assert.equal(Atomics.load(module.header, 0), expected);
    }
});

test('a chunk larger than the ring keeps the newest frames', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    // Six stereo frames into a four-frame ring: frames 1 and 2 are dropped.
    await worker.send({
        type: 'pcm',
        buffer: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]),
        channels: 2,
    });

    assert.deepEqual([...module.data], [3, 3, 4, 4, 5, 5, 6, 6]);
    assert.equal(Atomics.load(module.header, 0), 4);
});

test('an empty or absent PCM buffer is a no-op', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'pcm', channels: 2 });
    await worker.send({ type: 'pcm', buffer: new Float32Array([]), channels: 2 });

    assert.deepEqual([...module.data], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(Atomics.load(module.header, 0), 0);
});

test('a ccall carrying a requestId is answered with ccall-result', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    await worker.send({
        type: 'ccall', name: 'set_beat_sensitivity', returnType: null,
        argTypes: ['number'], args: [1.5], requestId: 7,
    });

    assert.deepEqual(module.ccalls, [{ name: 'set_beat_sensitivity', args: [1.5] }]);
    assert.deepEqual(worker.posted, [{
        type: 'ccall-result', requestId: 7, result: 'set_beat_sensitivity-result',
    }]);
});

test('a fire-and-forget ccall posts nothing back', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    await worker.send({ type: 'ccall', name: 'next_preset', returnType: null, argTypes: [], args: [] });

    assert.deepEqual(module.ccalls, [{ name: 'next_preset', args: [] }]);
    assert.deepEqual(worker.posted, []);
});

test('a throwing ccall with a requestId is answered with ccall-rejected', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;
    module.ccall = () => { throw new Error('bad arg'); };

    await worker.send({ type: 'ccall', name: 'boom', returnType: null, argTypes: [], args: [], requestId: 3 });

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'ccall-rejected');
    assert.equal(worker.posted[0].requestId, 3);
    assert.match(worker.posted[0].message, /ccall boom failed: Error: bad arg/);
});

test('a throwing fire-and-forget ccall is still reported as an error', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;
    module.ccall = () => { throw new Error('bad arg'); };

    await worker.send({ type: 'ccall', name: 'boom', returnType: null, argTypes: [], args: [] });

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'error');
    assert.match(worker.posted[0].message, /ccall boom failed: Error: bad arg/);
});

test('a ccall before the module exists is dropped', async () => {
    const worker = loadWorker({ createModule: null });
    await worker.send({ type: 'ccall', name: 'x', returnType: null, argTypes: [], args: [], requestId: 1 });
    assert.deepEqual(worker.posted, []);
});

test('the stats tick reports fps and the render-quality state', async () => {
    const module = fakeRingModule();
    module._dual_fbo_get_format = () => 1;
    module._get_quality_tier = () => 2;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    worker.tickStats();
    worker.tickStats();

    assert.equal(worker.posted.length, 2);
    // The first tick has no previous frame time to measure against.
    assert.equal(worker.posted[0].fps, 0);
    assert.equal(worker.posted[0].type, 'stats');
    assert.ok(worker.posted[1].fps > 0, 'the second tick should report a rate');
    for (const stats of worker.posted) {
        assert.equal(stats.fboFormat, 1);
        assert.equal(stats.qualityTier, 2);
    }
});

test('the stats tick carries the PCM ring counters the engine published', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    Atomics.store(module.header, 0, 9); // written
    Atomics.store(module.header, 2, 7); // drained by the engine
    Atomics.store(module.header, 3, 1); // overruns
    worker.tickStats();

    const ring = { ...worker.posted[0].pcmRing };
    assert.equal(typeof ring.sampledAt, 'number');
    delete ring.sampledAt;
    assert.deepEqual(ring, { writeIndex: 9, readIndex: 7, overruns: 1, capacityFrames: 4, indexModulus: 16 });
});

test('stats omit the PCM ring when the bundle has none', async () => {
    const module = fakeRingModule();
    delete module._get_pcm_ring_data_ptr;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;
    worker.tickStats();
    assert.equal('pcmRing' in worker.posted[0], false);
});

test('stats fall back to -1 when the bundle lacks the quality exports', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    worker.tickStats();
    assert.equal(worker.posted[0].fboFormat, -1);
    assert.equal(worker.posted[0].qualityTier, -1);
    assert.equal(worker.posted[0].renderPathOverrides, -1);
});

// ---- Flash limiter and frame capture (#286) -------------------------------------
//
// The limiter's switch travels in the init message (so the first frame is already
// limited) and later as set-flash-limit; a capture is read in the worker, inside
// the frame that drew it, and its pixels posted back.

/**
 * Adds the present-pass exports to a fakeRingModule(), with a capture buffer per
 * engine: a capture becomes ready after `framesUntilReady` polls (the render loop
 * drawing the frame), or at once on _render_frame().
 *
 * @param {ReturnType<typeof fakeRingModule>} module
 * @param {{ framesUntilReady?: number, width?: number, height?: number }} [options]
 */
function withPresentExports(module, { framesUntilReady = 2, width = 2, height = 1 } = {}) {
    /** @type {Array<[string, number, unknown]>} [export, active engine, value] */
    const presentCalls = [];
    /** @type {Map<number, { status: number, polls: number }>} */
    const captures = new Map();
    const heap = new Uint8Array(64);
    const PTR = 8;
    const host = () => module._get_active_host();
    const capture = () => captures.get(host()) ?? { status: 0, polls: 0 };
    const markReady = () => {
        // Each engine's pixels carry its handle, so a mixed-up read shows.
        heap.fill(host() * 10, PTR, PTR + width * height * 4);
        captures.set(host(), { status: 3, polls: 0 });
    };
    Object.assign(module, {
        HEAPU8: heap,
        presentCalls,
        _set_flash_limit_enabled: (v) => presentCalls.push(['enabled', host(), v]),
        _set_flash_limit_threshold: (v) => presentCalls.push(['threshold', host(), v]),
        _capture_frame_request: () => { captures.set(host(), { status: 1, polls: 0 }); return 1; },
        _render_frame: () => { if (capture().status === 1) markReady(); },
        _capture_frame_resolve: () => {
            const c = capture();
            if (c.status === 1 && ++c.polls >= framesUntilReady) markReady();
            return capture().status;
        },
        _capture_frame_width: () => width,
        _capture_frame_height: () => height,
        _capture_frame_data_ptr: () => PTR,
        _capture_frame_index: () => 41,
        _capture_frame_release: () => captures.set(host(), { status: 0, polls: 0 }),
    });
    return module;
}

/** Resolves once the worker posted a message of `type`. */
async function waitForPost(worker, type) {
    for (let i = 0; i < 200; i++) {
        const found = worker.posted.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the worker never posted '${type}'`);
}

test('init applies the flash limiter, threshold first, before the engine renders its first frame', async () => {
    const module = withPresentExports(fakeRingModule());
    let renderingStarted = false;
    const startRender = module._start_render;
    module._start_render = (w, h) => { renderingStarted = true; startRender(w, h); };
    const setEnabled = module._set_flash_limit_enabled;
    module._set_flash_limit_enabled = (v) => {
        assert.equal(renderingStarted, false, 'the limiter must be on before start_render()');
        setEnabled(v);
    };
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ flashLimit: { enabled: true, threshold: 0.04 } }));

    assert.deepEqual(module.presentCalls.map((call) => [...call]), [['threshold', 1, 0.04], ['enabled', 1, 1]]);
    assert.ok(worker.posted.some((message) => message.type === 'ready'));
});

test('init without a flash limit leaves the engine default alone', async () => {
    const module = withPresentExports(fakeRingModule());
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    assert.deepEqual(module.presentCalls, []);
});

test('set-flash-limit reaches the engine the message names', async () => {
    const module = withPresentExports(fakeRingModule());
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'set-flash-limit', enabled: true, threshold: 0.1, host: 2 });
    await worker.send({ type: 'set-flash-limit', enabled: false });
    assert.deepEqual(module.presentCalls.map((call) => [...call]), [
        ['threshold', 2, 0.1], ['enabled', 2, 1],
        // No threshold: only the switch, on the worker's own engine.
        ['enabled', 1, 0],
    ]);
});

test('capture-frame waits for the frame, then posts its pixels as a transferable buffer', async () => {
    const module = withPresentExports(fakeRingModule(), { framesUntilReady: 3 });
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    await worker.send({ type: 'capture-frame', requestId: 7, host: 1 });
    const reply = await waitForPost(worker, 'frame-captured');
    assert.equal(reply.requestId, 7);
    assert.equal(reply.error, undefined);
    assert.equal(reply.width, 2);
    assert.equal(reply.height, 1);
    assert.equal(reply.frameIndex, 41);
    assert.ok(reply.pixels instanceof ArrayBuffer || Object.prototype.toString.call(reply.pixels) === '[object ArrayBuffer]');
    assert.deepEqual([...new Uint8Array(reply.pixels)], new Array(8).fill(10));
});

test('capture-frame with renderFrame renders the frame itself and reads it at once', async () => {
    const module = withPresentExports(fakeRingModule(), { framesUntilReady: 1000 });
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'capture-frame', requestId: 1, renderFrame: true, timeoutMs: 50 });
    const reply = await waitForPost(worker, 'frame-captured');
    assert.equal(reply.error, undefined);
    assert.equal(reply.width, 2);
});

test('capture-frame reads the engine it names, even when another one is active meanwhile', async () => {
    const module = withPresentExports(fakeRingModule(), { framesUntilReady: 2 });
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'capture-frame', requestId: 3, host: 2 });
    // The worker's own engine is selected between polls, as a sibling message would.
    await worker.send({ type: 'set-flash-limit', enabled: true });
    const reply = await waitForPost(worker, 'frame-captured');
    assert.deepEqual([...new Uint8Array(reply.pixels)], new Array(8).fill(20), 'engine 2\'s pixels');
});

test('capture-frame answers with an error instead of hanging', async () => {
    // A bundle without the export.
    const old = loadWorker({ createModule: async () => fakeRingModule() });
    await old.send(initMessage());
    await old.send({ type: 'capture-frame', requestId: 4 });
    const refused = await waitForPost(old, 'frame-captured');
    assert.equal(refused.requestId, 4);
    assert.match(refused.error, /predates frame capture/);

    // A frame that never comes.
    const module = withPresentExports(fakeRingModule(), { framesUntilReady: 1e9 });
    const stalled = loadWorker({ createModule: async () => module });
    await stalled.send(initMessage());
    await stalled.send({ type: 'capture-frame', requestId: 5, timeoutMs: 20 });
    const timedOut = await waitForPost(stalled, 'frame-captured');
    assert.match(timedOut.error, /no frame was rendered within 20 ms/);
});

test('both implementations cover every message type declared in the wire protocol', () => {
    const typesSource = readFileSync(TYPES_PATH, 'utf8');
    const hostSource = readFileSync(HOST_PATH, 'utf8');

    /** Interface names in a `export type X = A | B | ...;` union. */
    const unionMembers = (unionName) => {
        const match = new RegExp(`export type ${unionName} =([^;]+);`).exec(typesSource);
        assert.ok(match, `${unionName} should be declared in projectm-render-worker-types.ts`);
        return match[1].split('|').map((part) => part.trim()).filter(Boolean);
    };

    /** The `type: '...'` discriminant of a message interface. */
    const discriminant = (interfaceName) => {
        const match = new RegExp(`export interface ${interfaceName}(?: extends [\\w, ]+)? \\{[^}]*?type: '([^']+)'`, 's')
            .exec(typesSource);
        assert.ok(match, `${interfaceName} should declare a string literal 'type'`);
        return match[1];
    };

    const hostToWorker = unionMembers('RenderWorkerHostMessage').map(discriminant);
    const workerToHost = unionMembers('RenderWorkerMessage').map(discriminant);

    // Guards the parsing itself: a types file that stopped declaring unions
    // would otherwise make this test vacuously pass.
    assert.deepEqual(
        hostToWorker.slice().sort(),
        ['capture-frame', 'ccall', 'init', 'pcm', 'preset', 'recover-context', 'resize', 'set-flash-limit'],
    );
    assert.deepEqual(
        workerToHost.slice().sort(),
        [
            'ccall-rejected', 'ccall-result', 'context-lost', 'context-recovered', 'context-restored',
            'error', 'frame-captured', 'pcm-ring', 'perf-frames', 'perf-hud', 'ready', 'rhythm-event', 'stats',
            'unsupported',
        ],
    );

    for (const type of hostToWorker) {
        assert.ok(
            WORKER_SOURCE.includes(`case '${type}':`),
            `projectm-render-worker.js has no case for the '${type}' message`,
        );
        assert.ok(
            hostSource.includes(`type: '${type}'`),
            `projectm-render-worker-host.js never posts a '${type}' message`,
        );
    }

    for (const type of workerToHost) {
        assert.ok(
            hostSource.includes(`case '${type}':`),
            `projectm-render-worker-host.js has no case for the '${type}' message`,
        );
        assert.ok(
            WORKER_SOURCE.includes(`type: '${type}'`),
            `projectm-render-worker.js never posts a '${type}' message`,
        );
    }
});

// ---- Perf HUD relay ------------------------------------------------------------
//
// js_perf_report_frame() calls globalThis.pmOnPerfFrame, which in the worker is
// the worker's scope. Without the relay ?perfhud=1 showed nothing in the default
// topology.

test('perf frames reported in the worker reach the host in order, batched', async () => {
    const worker = loadWorker({ createModule: async () => fakeRingModule() });
    // init() starts the stats interval this test drives with tickStats().
    await worker.send(initMessage());
    worker.posted.length = 0;
    const frame = (totalMs) => ({ totalMs, gpuMs: -1, fps: 60 });

    // The first frame flushes at once; the next ones wait for the batch window.
    worker.scope.pmOnPerfFrame(frame(1));
    worker.scope.pmOnPerfFrame(frame(2));
    worker.scope.pmOnPerfFrame(frame(3));
    // Arrays built inside the vm carry its Array.prototype; Array.from() brings them into this realm.
    const totals = (message) => Array.from(message.frames, (f) => f.totalMs);
    assert.deepEqual(worker.posted.map((m) => m.type), ['perf-frames']);
    assert.deepEqual(totals(worker.posted[0]), [1]);
    assert.deepEqual({ ...worker.posted[0].frames[0] }, frame(1));

    // The stats interval drains a partial batch, so a stalled loop strands nothing.
    worker.tickStats();
    const batches = () => worker.posted.filter((m) => m.type === 'perf-frames');
    assert.equal(batches().length, 2);
    assert.deepEqual(totals(batches()[1]), [2, 3]);

    worker.tickStats();
    assert.equal(batches().length, 2, 'an empty batch is not posted');
});

test('the HUD toggle is relayed, and switching it off flushes what was measured', () => {
    const worker = loadWorker();
    worker.scope.pmSetPerfHudEnabled(true);
    worker.scope.pmOnPerfFrame({ totalMs: 1 });
    worker.scope.pmOnPerfFrame({ totalMs: 2 });
    worker.scope.pmSetPerfHudEnabled(false);

    assert.deepEqual(worker.posted.map((m) => m.type), ['perf-hud', 'perf-frames', 'perf-frames', 'perf-hud']);
    assert.equal(worker.posted[0].enabled, true);
    assert.deepEqual(Array.from(worker.posted[2].frames, (f) => f.totalMs), [2]);
    assert.equal(worker.posted[3].enabled, false);
});

// ---- Rhythm events -------------------------------------------------------------
//
// js_report_rhythm_event() calls globalThis.pmOnRhythmEvent, the worker's scope
// in this topology. Beats are relayed one by one, not batched: a batch would
// deliver every beat late.

test('rhythm events reported in the worker reach the host one by one', () => {
    const worker = loadWorker();
    const beat = { host: 7, beat: true, bar: false, section: false, bpm: 128, beatIndex: 41, barPhase: 0.25, sectionIndex: 2, confidence: 0.9 };
    worker.scope.pmOnRhythmEvent(beat);
    worker.scope.pmOnRhythmEvent({ ...beat, bar: true, beatIndex: 42, barPhase: 0 });

    assert.deepEqual(worker.posted.map((m) => m.type), ['rhythm-event', 'rhythm-event']);
    assert.deepEqual({ ...worker.posted[0].event }, beat);
    assert.equal(worker.posted[1].event.bar, true);
    assert.equal(worker.posted[1].event.beatIndex, 42);
});

// ---- Which engine ---------------------------------------------------------------
//
// The worker has one engine today. 'ready' names it, the host stamps that handle
// on every control message, and the worker selects it before acting — so a
// second engine in the worker would not depend on whichever was active last.

test('ready names the worker\'s engine, and a message for it costs no activation', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    assert.equal(worker.posted.find((m) => m.type === 'ready').host, 1);

    await worker.send({ type: 'ccall', name: 'next_preset', returnType: null, argTypes: [], args: [], host: 1 });
    assert.deepEqual(module.ccalls.map((call) => call.name), ['next_preset']);
});

test('a control message for another engine selects it before acting', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    await worker.send({ type: 'ccall', name: 'next_preset', returnType: null, argTypes: [], args: [], host: 2 });
    await worker.send({ type: 'ccall', name: 'set_preset_locked', returnType: null, argTypes: ['number'], args: [1] });
    assert.deepEqual(module.ccalls.map((call) => [call.name, [...call.args]]), [
        ['set_active_host', [2]], ['next_preset', []],
        // No host on the message: the worker's own engine, selected back.
        ['set_active_host', [1]], ['set_preset_locked', [1]],
    ]);
});

test('the worker\'s engine hooks take both bundle shapes and ignore another engine', async () => {
    const module = fakeRingModule();
    const sizes = [];
    module._set_window_size = (w, h) => sizes.push([w, h]);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ width: 800, height: 600 }));
    sizes.length = 0;
    worker.posted.length = 0;

    worker.scope.pmOnGovernorRenderScaleChange(2, 0.5); // another engine's tier
    assert.deepEqual(sizes, []);
    worker.scope.pmOnGovernorRenderScaleChange(1, 0.5); // 040: (host, scale)
    assert.deepEqual(sizes.at(-1), [400, 300]);
    worker.scope.pmOnGovernorRenderScaleChange(0.75); // before 040: (scale)
    assert.deepEqual(sizes.at(-1), [600, 450]);

    worker.scope.pmSetPerfHudEnabled(2, true);
    worker.scope.pmOnPerfFrame({ host: 2, totalMs: 9 });
    worker.scope.pmOnRhythmEvent({ host: 2, beat: true });
    assert.deepEqual(worker.posted, [], 'nothing of another engine\'s is relayed');
    worker.scope.pmSetPerfHudEnabled(1, true);
    assert.deepEqual(worker.posted.map((m) => [m.type, m.enabled]), [['perf-hud', true]]);
});

// ---- WebGL context loss ------------------------------------------------------
//
// The webglcontextlost/-restored events fire on the transferred OffscreenCanvas,
// so the worker is the only place they can be heard. It does the
// preventDefault() + pm_handle_context_loss() half itself and relays the rest.

/** A canvas that records listeners and lets a test fire the DOM events. */
function fakeEventCanvas(width = 640, height = 360) {
    /** @type {Record<string, Array<(event: any) => void>>} */
    const listeners = {};
    return {
        width,
        height,
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
        /** @returns {{ defaultPrevented: boolean }} */
        fire(type) {
            const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
            (listeners[type] || []).forEach((fn) => fn(event));
            return event;
        },
    };
}

/** @param {ReturnType<typeof fakeRingModule>} module */
function instrumentRecovery(module) {
    /** @type {string[]} */
    const calls = [];
    let initStatus = 0;
    module._pm_handle_context_loss = () => calls.push('pm_handle_context_loss');
    module._init = () => { calls.push('init'); return initStatus; };
    module._start_render = (w, h) => calls.push(`start_render ${w}x${h}`);
    return { calls, setInitStatus: (status) => { initStatus = status; } };
}

test('context loss: the worker prevents default, tears down the engine and tells the host', async () => {
    const module = fakeRingModule();
    const { calls } = instrumentRecovery(module);
    const worker = loadWorker({ createModule: async () => module });
    const canvas = fakeEventCanvas();
    await worker.send(initMessage({ canvas }));
    worker.posted.length = 0;
    calls.length = 0;

    const event = canvas.fire('webglcontextlost');

    assert.equal(event.defaultPrevented, true, 'without preventDefault the browser never restores the context');
    assert.deepEqual(calls, ['pm_handle_context_loss']);
    assert.deepEqual(worker.posted, [{ type: 'context-lost' }]);
});

test('context restore: the worker only notifies — the host drives the re-init', async () => {
    const module = fakeRingModule();
    const { calls } = instrumentRecovery(module);
    const worker = loadWorker({ createModule: async () => module });
    const canvas = fakeEventCanvas();
    await worker.send(initMessage({ canvas }));
    worker.posted.length = 0;
    calls.length = 0;

    canvas.fire('webglcontextrestored');

    assert.deepEqual(worker.posted, [{ type: 'context-restored' }]);
    assert.deepEqual(calls, [], 'recovery is requested by the host, not started by the worker');
});

test('recover-context re-inits, restarts rendering at the surface size and republishes the ring', async () => {
    const module = fakeRingModule();
    const { calls } = instrumentRecovery(module);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ canvas: fakeEventCanvas(800, 450) }));
    worker.posted.length = 0;
    calls.length = 0;

    await worker.send({ type: 'recover-context' });

    assert.deepEqual(calls, ['init', 'start_render 800x450']);
    assert.deepEqual(worker.posted.map((m) => m.type), ['pcm-ring', 'context-recovered']);
    assert.equal(worker.posted[1].status, 0);
});

test('recover-context while the context is still lost reports code 5 and builds nothing', async () => {
    const module = fakeRingModule();
    const { calls, setInitStatus } = instrumentRecovery(module);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ canvas: fakeEventCanvas() }));
    worker.posted.length = 0;
    calls.length = 0;
    setInitStatus(5);

    await worker.send({ type: 'recover-context' });

    assert.deepEqual(calls, ['init'], 'no start_render on a context that is still lost');
    assert.deepEqual(worker.posted, [{ type: 'context-recovered', status: 5 }]);
});

test('recover-context before the module booted answers -1 instead of throwing', async () => {
    const worker = loadWorker({ createModule: async () => fakeRingModule() });
    await worker.send({ type: 'recover-context' });
    assert.deepEqual(worker.posted, [{ type: 'context-recovered', status: -1 }]);
});

test('an init() that throws during recovery is reported and answered -1', async () => {
    const module = fakeRingModule();
    instrumentRecovery(module);
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage({ canvas: fakeEventCanvas() }));
    worker.posted.length = 0;
    module._init = () => { throw new Error('boom'); };

    await worker.send({ type: 'recover-context' });

    assert.equal(worker.posted[0].type, 'error');
    assert.match(worker.posted[0].message, /context recovery failed: Error: boom/);
    assert.deepEqual(worker.posted[1], { type: 'context-recovered', status: -1 });
});
