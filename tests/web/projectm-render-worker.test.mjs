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
    return {
        HEAPF32: new Float32Array(memory),
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
        ccall: (name, _returnType, _argTypes, args) => { ccalls.push({ name, args }); return `${name}-result`; },
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, capacityFrames * 2),
        memory,
        ccalls,
        startRenders,
    };
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

test('a non-zero init() status is reported instead of trapping in start_render', async () => {
    const module = fakeRingModule();
    module._init = () => 2;
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());

    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'error');
    assert.match(worker.posted[0].message, /init\(\) failed in the render worker \(code 2\)/);
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

test('a throwing ccall is reported as an error, not left hanging silently', async () => {
    const module = fakeRingModule();
    module.ccall = () => { throw new Error('bad arg'); };
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    await worker.send({ type: 'ccall', name: 'boom', returnType: null, argTypes: [], args: [], requestId: 3 });

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

test('stats fall back to -1 when the bundle lacks the quality exports', async () => {
    const module = fakeRingModule();
    const worker = loadWorker({ createModule: async () => module });
    await worker.send(initMessage());
    worker.posted.length = 0;

    worker.tickStats();
    assert.equal(worker.posted[0].fboFormat, -1);
    assert.equal(worker.posted[0].qualityTier, -1);
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
        const match = new RegExp(`export interface ${interfaceName} \\{[^}]*?type: '([^']+)'`, 's')
            .exec(typesSource);
        assert.ok(match, `${interfaceName} should declare a string literal 'type'`);
        return match[1];
    };

    const hostToWorker = unionMembers('RenderWorkerHostMessage').map(discriminant);
    const workerToHost = unionMembers('RenderWorkerMessage').map(discriminant);

    // Guards the parsing itself: a types file that stopped declaring unions
    // would otherwise make this test vacuously pass.
    assert.deepEqual(hostToWorker.slice().sort(), ['ccall', 'init', 'pcm', 'preset', 'resize']);
    assert.deepEqual(
        workerToHost.slice().sort(),
        ['ccall-result', 'error', 'pcm-ring', 'ready', 'stats', 'unsupported'],
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
