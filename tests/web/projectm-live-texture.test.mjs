// Live textures and host variables in the host layer (docs/LIVE_INPUT.md):
// html/projectm-live-texture.js (the per-engine registry and the main-thread
// heap writer), the transports' live-texture calls in both topologies, the
// ProjectMContext methods, and the ?liveTex=1 page source.
//
// The worker half (html/worker/live-texture.js) is covered in
// tests/web/projectm-render-worker.test.mjs, and the two halves together in
// tests/web/projectm-render-worker-roundtrip.test.mjs.
//
// Run with: node --test tests/web/projectm-live-texture.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_LIVE_TEXTURE_MAX_SIZE,
    LIVE_TEXTURE_MAX_SIZE,
    createFrameRasterizer,
    createLiveTextureWriter,
    createLiveTextures,
    fitLiveTextureSize,
    isLiveTextureName,
    pixelsOf,
    sourceSize,
} from '../../html/projectm-live-texture.js';
import { createModuleTransport, createWorkerTransport } from '../../html/projectm-render-transport.js';
import { ProjectMContextControls } from '../../html/context/controls.js';
import { resolveLiveTextureConfig, setupLiveTextureSource } from '../../html/projectm-live-texture-source.js';
import { wireLiveTexture } from '../../html/app-shell/engine.js';

// ---- the module's helpers --------------------------------------------------------------------

test('isLiveTextureName accepts sampler identifiers only', () => {
    assert.equal(isLiveTextureName('webcam'), true);
    assert.equal(isLiveTextureName('Cam_2'), true);
    assert.equal(isLiveTextureName('a'.repeat(64)), true);
    for (const name of ['', 'a'.repeat(65), 'web-cam', 'web cam', 'cam.png', null, 3]) {
        assert.equal(isLiveTextureName(name), false, String(name));
    }
});

test('sourceSize reads each kind of source, and null before it has a size', () => {
    assert.deepEqual(sourceSize(/** @type {any} */ ({ displayWidth: 640, displayHeight: 360, codedWidth: 656 })), {
        width: 640,
        height: 360,
    });
    assert.deepEqual(sourceSize(/** @type {any} */ ({ videoWidth: 1280, videoHeight: 720, width: 0, height: 0 })), {
        width: 1280,
        height: 720,
    });
    assert.deepEqual(sourceSize(/** @type {any} */ ({ naturalWidth: 10, naturalHeight: 20 })), { width: 10, height: 20 });
    assert.deepEqual(sourceSize(/** @type {any} */ ({ width: 3, height: 4 })), { width: 3, height: 4 });
    assert.equal(sourceSize(/** @type {any} */ ({ videoWidth: 0, videoHeight: 0 })), null, 'a video before its metadata');
});

test('fitLiveTextureSize keeps the aspect ratio inside the cap', () => {
    assert.deepEqual(fitLiveTextureSize({ width: 1920, height: 1080 }), { width: 1024, height: 576 });
    assert.deepEqual(fitLiveTextureSize({ width: 640, height: 480 }), { width: 640, height: 480 }, 'never upscaled');
    assert.deepEqual(fitLiveTextureSize({ width: 1080, height: 1920 }, 512), { width: 288, height: 512 });
    assert.deepEqual(fitLiveTextureSize({ width: 100000, height: 1 }, 1e9), { width: LIVE_TEXTURE_MAX_SIZE, height: 1 });
    assert.deepEqual(fitLiveTextureSize({ width: 2000, height: 1000 }, 0), { width: DEFAULT_LIVE_TEXTURE_MAX_SIZE, height: 512 });
});

test('pixelsOf passes pixels of exactly the slot size through, and nothing else', () => {
    const data = new Uint8Array(2 * 1 * 4);
    assert.equal(pixelsOf({ width: 2, height: 1, data }, { width: 2, height: 1 }), data);
    assert.equal(pixelsOf({ width: 2, height: 1, data }, { width: 1, height: 2 }), null);
    assert.equal(pixelsOf({ width: 2, height: 2, data }, { width: 2, height: 2 }), null, 'too few bytes');
    assert.equal(pixelsOf(/** @type {any} */ ({ videoWidth: 2, videoHeight: 1 }), { width: 2, height: 1 }), null);
});

/** A 2D canvas stand-in that records draws and reads back `fill`. */
function fakeCanvasFactory(fill = 5) {
    const made = [];
    const create = (width, height) => {
        const canvas = {
            width,
            height,
            draws: /** @type {unknown[][]} */ ([]),
            puts: 0,
            getContext: () => ({
                drawImage: (...args) => canvas.draws.push(args),
                putImageData: () => {
                    canvas.puts += 1;
                },
                getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(fill) }),
            }),
        };
        made.push(canvas);
        return canvas;
    };
    return { create, made };
}

test('the rasterizer draws a frame at the slot size on one reused canvas', () => {
    const { create, made } = fakeCanvasFactory(7);
    const rasterizer = createFrameRasterizer({ createCanvas: /** @type {any} */ (create) });
    const video = /** @type {any} */ ({ videoWidth: 1280, videoHeight: 720 });

    const first = rasterizer.rasterize(video, { width: 4, height: 2 });
    assert.equal(first.length, 32);
    assert.ok(first.every((value) => value === 7));
    rasterizer.rasterize(video, { width: 2, height: 2 });
    assert.equal(made.length, 1, 'one canvas, resized');
    assert.deepEqual(made[0].draws.map((args) => args.slice(1)), [
        [0, 0, 4, 2],
        [0, 0, 2, 2],
    ]);
    assert.equal(made[0].width, 2);
});

test('the rasterizer scales pixels of another size through a staging canvas', () => {
    const { create, made } = fakeCanvasFactory(1);
    const previous = globalThis.ImageData;
    globalThis.ImageData = class {
        constructor(data, width, height) {
            Object.assign(this, { data, width, height });
        }
    };
    try {
        const rasterizer = createFrameRasterizer({ createCanvas: /** @type {any} */ (create) });
        const out = rasterizer.rasterize({ width: 4, height: 4, data: new Uint8Array(64) }, { width: 2, height: 2 });
        assert.equal(out.length, 16);
        assert.equal(made.length, 2, 'the slot canvas and a staging canvas');
        assert.equal(made[1].puts, 1);
        assert.equal(made[0].draws[0][0], made[1], 'scaled from the staging canvas');
        assert.throws(
            () => rasterizer.rasterize({ width: 4, height: 4, data: new Uint8Array(3) }, { width: 2, height: 2 }),
            /3 bytes is not 4x4/
        );
    } finally {
        globalThis.ImageData = previous;
    }
});

test('the rasterizer without OffscreenCanvas says why', () => {
    const rasterizer = createFrameRasterizer();
    const previous = globalThis.OffscreenCanvas;
    delete globalThis.OffscreenCanvas;
    try {
        assert.throws(() => rasterizer.rasterize(/** @type {any} */ ({ videoWidth: 2, videoHeight: 2 }), { width: 2, height: 2 }), /OffscreenCanvas/);
    } finally {
        if (previous) globalThis.OffscreenCanvas = previous;
    }
});

// ---- the registry ----------------------------------------------------------------------------

/** A backend recording what the registry asked of the engine. */
function recordingBackend({ accept = true } = {}) {
    const calls = [];
    return {
        calls,
        registerSlot: async (name, width, height) => {
            calls.push(['register', name, width, height]);
            return accept;
        },
        unregisterSlot: async (name) => {
            calls.push(['unregister', name]);
            return true;
        },
        writeFrame: async (name, size) => {
            calls.push(['write', name, size.width, size.height]);
            return true;
        },
    };
}

const video = (width, height) => /** @type {any} */ ({ videoWidth: width, videoHeight: height });

test('a slot registered with a size keeps it: frames are scaled to fit', async () => {
    const backend = recordingBackend();
    const live = createLiveTextures(backend);
    assert.equal(await live.register('webcam', 320, 180), true);
    assert.equal(await live.update('webcam', video(1920, 1080)), true);
    assert.deepEqual(backend.calls, [
        ['register', 'webcam', 320, 180],
        ['write', 'webcam', 320, 180],
    ]);
    assert.deepEqual(live.size('WEBCAM'), { width: 320, height: 180 });
});

test('an unknown name is registered from its first frame and follows the source', async () => {
    const backend = recordingBackend();
    const live = createLiveTextures(backend);
    assert.equal(await live.update('webcam', video(1920, 1080)), true);
    assert.equal(await live.update('webcam', video(1920, 1080)), true);
    assert.equal(await live.update('webcam', video(640, 480), { maxSize: 320 }), true);
    assert.deepEqual(backend.calls, [
        ['register', 'webcam', 1024, 576],
        ['write', 'webcam', 1024, 576],
        ['write', 'webcam', 1024, 576],
        ['register', 'webcam', 320, 240],
        ['write', 'webcam', 320, 240],
    ]);
});

test('followSource turns a placeholder into the source size on the first frame', async () => {
    const backend = recordingBackend();
    const live = createLiveTextures(backend);
    await live.register('webcam', 1, 1, { followSource: true });
    await live.update('webcam', video(640, 360));
    assert.deepEqual(backend.calls.slice(1), [
        ['register', 'webcam', 640, 360],
        ['write', 'webcam', 640, 360],
    ]);
});

test('frames are dropped, not queued, while one is on its way', async () => {
    /** @type {() => void} */
    let release = () => {};
    const backend = recordingBackend();
    backend.writeFrame = () =>
        new Promise((resolve) => {
            release = () => resolve(true);
        });
    const live = createLiveTextures(backend);
    await live.register('webcam', 2, 2);
    const first = live.update('webcam', video(2, 2));
    await Promise.resolve();
    assert.equal(await live.update('webcam', video(2, 2)), false, 'the second frame is dropped');
    release();
    assert.equal(await first, true);
    backend.writeFrame = async () => true;
    assert.equal(await live.update('webcam', video(2, 2)), true, 'and the next one goes');
});

test('the registry refuses bad names, sizes and sources without asking the engine', async () => {
    const backend = recordingBackend();
    const live = createLiveTextures(backend);
    assert.equal(await live.register('web-cam', 2, 2), false);
    assert.equal(await live.register('webcam', 0, 2), false);
    assert.equal(await live.register('webcam', 2, LIVE_TEXTURE_MAX_SIZE + 1), false);
    assert.equal(await live.register('webcam', Number.NaN, 2), false);
    assert.equal(await live.update('web cam', video(2, 2)), false);
    assert.equal(await live.update('webcam', /** @type {any} */ (null)), false);
    assert.equal(await live.update('webcam', video(0, 0)), false, 'a video before its metadata');
    assert.equal(await live.unregister('web-cam'), false);
    assert.deepEqual(backend.calls, []);
    assert.equal(live.size('webcam'), null);
});

test('a slot the engine refuses is not recorded, and its frames go nowhere', async () => {
    const backend = recordingBackend({ accept: false });
    const live = createLiveTextures(backend);
    assert.equal(await live.register('noise_lq', 2, 2), false);
    assert.equal(await live.update('noise_lq', video(2, 2)), false);
    assert.equal(live.size('noise_lq'), null);
    assert.deepEqual(
        backend.calls.map((call) => call[0]),
        ['register', 'register']
    );
});

test('unregister forgets the slot, so the next frame registers it again', async () => {
    const backend = recordingBackend();
    const live = createLiveTextures(backend);
    await live.register('webcam', 2, 2);
    assert.equal(await live.unregister('webcam'), true);
    assert.equal(live.size('webcam'), null);
    await live.update('webcam', video(4, 4));
    assert.deepEqual(backend.calls.at(-2), ['register', 'webcam', 4, 4]);
});

// ---- the main-thread writer ------------------------------------------------------------------

/**
 * The engine as the generated wrappers see it: ccall-bound live-texture exports
 * over a byte heap, one slot of `bytes` at SLOT_PTR.
 */
function fakeEngine() {
    const SLOT_PTR = 16;
    const engine = {
        HEAPU8: new Uint8Array(64),
        slotBytes: 0,
        commits: /** @type {string[]} */ ([]),
        calls: /** @type {Array<[string, unknown[]]>} */ ([]),
        _texture_slot_register: () => 0,
        _eval_set: () => 0,
        _eval_clear: () => 0,
        ccall(name, _returnType, _argTypes, args) {
            engine.calls.push([name, args]);
            switch (name) {
                case 'texture_slot_register':
                    engine.slotBytes = Number(args[1]) * Number(args[2]) * 4;
                    return args[0] === 'noise_lq' ? 0 : 1;
                case 'texture_slot_buffer':
                    return args[1] === engine.slotBytes ? SLOT_PTR : 0;
                case 'texture_slot_commit':
                    engine.commits.push(String(args[0]));
                    return 1;
                case 'texture_slot_unregister':
                    return 1;
                case 'eval_set':
                    return args[0] === 'time' ? 0 : 1;
                case 'eval_clear':
                    return 1;
                default:
                    return 0;
            }
        },
    };
    return { engine, SLOT_PTR };
}

test('the main-thread writer copies the frame into the slot buffer and commits it', async () => {
    const { engine, SLOT_PTR } = fakeEngine();
    const live = createLiveTextures(createLiveTextureWriter(engine));
    assert.equal(await live.register('webcam', 2, 1), true);
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await live.update('webcam', { width: 2, height: 1, data }), true);
    assert.deepEqual([...engine.HEAPU8.slice(SLOT_PTR, SLOT_PTR + 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(engine.commits, ['webcam']);
    assert.equal(await live.unregister('webcam'), true);
});

test('the main-thread writer never writes when the engine has no buffer of that size', async () => {
    const { engine, SLOT_PTR } = fakeEngine();
    const writer = createLiveTextureWriter(engine);
    await writer.registerSlot('webcam', 2, 1);
    engine.slotBytes = 4; // resized behind the writer's back
    assert.equal(await writer.writeFrame('webcam', { width: 2, height: 1 }, { width: 2, height: 1, data: new Uint8Array(8).fill(9) }), false);
    assert.deepEqual([...engine.HEAPU8.slice(SLOT_PTR, SLOT_PTR + 8)], new Array(8).fill(0));
    assert.deepEqual(engine.commits, []);
    // Pixels of another size need a canvas to scale them, which Node has not.
    assert.throws(
        () => writer.writeFrame('webcam', { width: 2, height: 1 }, /** @type {any} */ ({ width: 1, height: 1, data: new Uint8Array(4) })),
        /OffscreenCanvas/
    );
});

// ---- the transports --------------------------------------------------------------------------

test('the module transport routes live textures through the heap writer', async () => {
    const { engine, SLOT_PTR } = fakeEngine();
    const transport = createModuleTransport(engine);
    assert.equal(await transport.registerTexture('webcam', 2, 1), true);
    assert.equal(await transport.registerTexture('noise_lq', 2, 1), false);
    assert.equal(await transport.updateTexture('webcam', { width: 2, height: 1, data: new Uint8Array(8).fill(3) }), true);
    assert.deepEqual([...engine.HEAPU8.slice(SLOT_PTR, SLOT_PTR + 8)], new Array(8).fill(3));
    assert.equal(await transport.unregisterTexture('webcam'), true);
});

/** A render-worker handle recording ccalls and texture frames. */
function fakeWorkerHandle() {
    const posted = [];
    return {
        posted,
        ccall: (name, returnType, argTypes, args) => {
            posted.push({ kind: 'ccall', name, args });
            return Promise.resolve(name === 'texture_slot_register' && args[0] === 'noise_lq' ? 0 : 1);
        },
        ccallVoid: () => {},
        postTextureFrame: (name, width, height, frame) => posted.push({ kind: 'frame', name, width, height, ...frame }),
    };
}

test('the worker transport registers by ccall and posts exact-size pixels as a transferred copy', async () => {
    const handle = fakeWorkerHandle();
    const transport = createWorkerTransport(/** @type {any} */ (handle), { createImageBitmap: null });
    assert.equal(await transport.registerTexture('webcam', 2, 1), true);
    assert.equal(await transport.registerTexture('noise_lq', 2, 1), false);
    const data = new Uint8Array(8).fill(4);
    assert.equal(await transport.updateTexture('webcam', { width: 2, height: 1, data }), true);
    const frame = handle.posted.find((entry) => entry.kind === 'frame');
    assert.equal(frame.width, 2);
    assert.ok(frame.pixels instanceof ArrayBuffer);
    assert.notEqual(frame.pixels, data.buffer, 'a copy: the caller keeps its buffer');
    assert.deepEqual([...new Uint8Array(frame.pixels)], new Array(8).fill(4));
    assert.equal(await transport.unregisterTexture('webcam'), true);
    assert.deepEqual(handle.posted.at(-1), { kind: 'ccall', name: 'texture_slot_unregister', args: ['webcam'] });
});

test('the worker transport scales other sources to the slot with createImageBitmap and transfers the bitmap', async () => {
    const handle = fakeWorkerHandle();
    const requests = [];
    const bitmap = { close() {} };
    const transport = createWorkerTransport(/** @type {any} */ (handle), {
        createImageBitmap: async (source, options) => {
            requests.push([source, options]);
            return /** @type {any} */ (bitmap);
        },
    });
    const source = video(1920, 1080);
    assert.equal(await transport.updateTexture('webcam', source), true);
    assert.deepEqual(requests, [[source, { resizeWidth: 1024, resizeHeight: 576, resizeQuality: 'low' }]]);
    const frame = handle.posted.find((entry) => entry.kind === 'frame');
    assert.equal(frame.bitmap, bitmap);
    assert.equal(frame.width, 1024);
    assert.equal(frame.height, 576);
});

test('a browser that rejects the resize options gets the frame at its own size', async () => {
    const handle = fakeWorkerHandle();
    const requests = [];
    const transport = createWorkerTransport(/** @type {any} */ (handle), {
        createImageBitmap: async (_source, options) => {
            requests.push(options);
            if (options) throw new TypeError('resizeWidth is not supported');
            return /** @type {any} */ ({ close() {} });
        },
    });
    assert.equal(await transport.updateTexture('webcam', video(8, 8)), true);
    assert.deepEqual(requests, [{ resizeWidth: 8, resizeHeight: 8, resizeQuality: 'low' }, undefined]);
});

test('the worker transport without createImageBitmap refuses non-pixel sources with a reason', async () => {
    const transport = createWorkerTransport(/** @type {any} */ (fakeWorkerHandle()), { createImageBitmap: null });
    await assert.rejects(() => transport.updateTexture('webcam', video(8, 8)), /createImageBitmap/);
});

test('a createImageBitmap failure that is not about options is not swallowed', async () => {
    const transport = createWorkerTransport(/** @type {any} */ (fakeWorkerHandle()), {
        createImageBitmap: async () => {
            throw new Error('the video is tainted');
        },
    });
    await assert.rejects(() => transport.updateTexture('webcam', video(8, 8)), /tainted/);
});

// ---- ProjectMContext -------------------------------------------------------------------------

test('the context methods reject before start() and on a bundle without live input', async () => {
    const context = new ProjectMContextControls();
    await assert.rejects(() => context.registerTexture('webcam', 1, 1), /has not started/);
    await assert.rejects(() => context.updateTexture('webcam', video(2, 2)), /has not started/);
    await assert.rejects(() => context.unregisterTexture('webcam'), /has not started/);
    await assert.rejects(() => context.setEvalVar('q1', 1), /has not started/);
    await assert.rejects(() => context.clearEvalVar('q1'), /has not started/);

    context.transport = /** @type {any} */ ({ supports: () => false });
    await assert.rejects(() => context.registerTexture('webcam', 1, 1), /predates live input \(textureSlotRegister\)/);
    await assert.rejects(() => context.setEvalVar('q1', 1), /predates live input \(evalSet\)/);
});

test('the context drives live textures and host variables through its transport', async () => {
    const { engine, SLOT_PTR } = fakeEngine();
    const context = new ProjectMContextControls();
    context.transport = createModuleTransport(engine);

    assert.equal(await context.registerTexture('webcam', 2, 1), true);
    assert.equal(await context.updateTexture('webcam', { width: 2, height: 1, data: new Uint8Array(8).fill(6) }), true);
    assert.deepEqual([...engine.HEAPU8.slice(SLOT_PTR, SLOT_PTR + 8)], new Array(8).fill(6));
    assert.equal(await context.unregisterTexture('webcam'), true);

    assert.equal(await context.setEvalVar('q1', 0.5), true);
    assert.equal(await context.setEvalVar('time', 1), false, 'the engine refuses read-only inputs');
    assert.equal(await context.setEvalVar('q1', Number.NaN), false);
    assert.equal(await context.clearEvalVar(), true);
    const evalCalls = engine.calls.filter(([name]) => name.startsWith('eval_'));
    assert.deepEqual(evalCalls, [
        ['eval_set', ['q1', 0.5]],
        ['eval_set', ['time', 1]],
        ['eval_clear', ['']],
    ]);
});

// ---- ?liveTex=1 ------------------------------------------------------------------------------

test('resolveLiveTextureConfig is off unless asked for, and sanitises what it is given', () => {
    assert.equal(resolveLiveTextureConfig(new URLSearchParams('')), null);
    assert.equal(resolveLiveTextureConfig(new URLSearchParams('liveTex=0')), null);
    assert.deepEqual(resolveLiveTextureConfig(new URLSearchParams('liveTex=1')), {
        name: 'webcam',
        src: 'camera',
        maxSize: DEFAULT_LIVE_TEXTURE_MAX_SIZE,
    });
    assert.deepEqual(
        resolveLiveTextureConfig(new URLSearchParams('liveTex=true&liveTexName=deck_b&liveTexSrc=/clips/a.mp4&liveTexSize=512')),
        { name: 'deck_b', src: '/clips/a.mp4', maxSize: 512 }
    );
    assert.equal(resolveLiveTextureConfig(new URLSearchParams('liveTex=1&liveTexName=bad-name')).name, 'webcam');
});

/** A document, a video element and a camera, recording what the source did with them. */
function fakePage({ camera = true, cameraError = null, rvfc = true } = {}) {
    const events = [];
    /** @type {Array<() => void>} */
    const frameCallbacks = [];
    const video = {
        videoWidth: 640,
        videoHeight: 360,
        style: {},
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            events.push(['removeAttribute', name]);
        },
        play: async () => {
            events.push(['play']);
        },
        pause: () => events.push(['pause']),
        remove: () => events.push(['remove']),
        ...(rvfc
            ? {
                  requestVideoFrameCallback(callback) {
                      frameCallbacks.push(callback);
                      return frameCallbacks.length;
                  },
                  cancelVideoFrameCallback: (id) => events.push(['cancel', id]),
              }
            : {}),
    };
    const track = { stop: () => events.push(['track.stop']) };
    const documentRef = {
        createElement: () => video,
        body: { appendChild: () => events.push(['append']) },
    };
    const navigatorRef = camera
        ? {
              mediaDevices: {
                  getUserMedia: async (constraints) => {
                      events.push(['getUserMedia', constraints.audio]);
                      if (cameraError) throw cameraError;
                      return { getTracks: () => [track] };
                  },
              },
          }
        : {};
    return { events, frameCallbacks, video, documentRef, navigatorRef };
}

/** A context recording the live-texture calls the source made. */
function recordingContext({ accept = true } = {}) {
    const calls = [];
    return {
        calls,
        registerTexture: async (...args) => {
            calls.push(['register', ...args]);
            return accept;
        },
        updateTexture: async (name, source, options) => {
            calls.push(['update', name, source.videoWidth, options]);
            return true;
        },
        unregisterTexture: async (name) => {
            calls.push(['unregister', name]);
            return true;
        },
    };
}

test('the camera source registers a placeholder first, then uploads once per video frame', async () => {
    const page = fakePage();
    const context = recordingContext();
    const statuses = [];
    const source = setupLiveTextureSource(context, { name: 'webcam', src: 'camera', maxSize: 512 }, {
        documentRef: /** @type {any} */ (page.documentRef),
        navigatorRef: /** @type {any} */ (page.navigatorRef),
        onStatus: (status) => statuses.push(status),
        log: '[test]',
    });
    assert.deepEqual(context.calls[0], ['register', 'webcam', 1, 1, { followSource: true }], 'registered before anything else');
    assert.equal(await source.registered, true);
    assert.equal(await source.ready, true);
    assert.deepEqual(statuses, ['streaming']);
    assert.ok(page.video.muted && page.video.playsInline);
    assert.deepEqual(page.events.slice(0, 3), [['append'], ['getUserMedia', false], ['play']]);

    page.frameCallbacks.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(context.calls[1], ['update', 'webcam', 640, { maxSize: 512 }]);
    assert.equal(page.frameCallbacks.length, 1, 'the next frame is asked for after the upload settles');

    source.dispose();
    source.dispose();
    assert.ok(page.events.some(([name]) => name === 'track.stop'), 'the camera is released');
    assert.ok(page.events.some(([name]) => name === 'remove'));
    assert.ok(page.events.some(([name]) => name === 'cancel'));
    assert.deepEqual(context.calls.at(-1), ['unregister', 'webcam']);
    assert.equal(context.calls.filter(([kind]) => kind === 'unregister').length, 1, 'dispose is idempotent');
});

test('a video-file source loops a muted, CORS-enabled video and falls back to animation frames', async () => {
    const page = fakePage({ rvfc: false });
    const frames = [];
    const windowRef = {
        requestAnimationFrame: (callback) => {
            frames.push(callback);
            return frames.length;
        },
        cancelAnimationFrame: () => {},
    };
    const context = recordingContext();
    const source = setupLiveTextureSource(context, { name: 'clip', src: '/clips/a.mp4', maxSize: 1024 }, {
        documentRef: /** @type {any} */ (page.documentRef),
        navigatorRef: /** @type {any} */ (page.navigatorRef),
        windowRef: /** @type {any} */ (windowRef),
        log: '[test]',
    });
    assert.equal(await source.ready, true);
    assert.equal(page.video.src, '/clips/a.mp4');
    assert.equal(page.video.loop, true);
    assert.equal(page.video.crossOrigin, 'anonymous');
    assert.equal(frames.length, 1);
    source.dispose();
});

test('a camera that is refused (or absent) reports failure and leaves the page as it was', async () => {
    const statuses = [];
    for (const page of [fakePage({ cameraError: new Error('NotAllowedError') }), fakePage({ camera: false })]) {
        const context = recordingContext();
        const source = setupLiveTextureSource(context, { name: 'webcam', src: 'camera', maxSize: 1024 }, {
            documentRef: /** @type {any} */ (page.documentRef),
            navigatorRef: /** @type {any} */ (page.navigatorRef),
            onStatus: (status) => statuses.push(status),
            log: '[test]',
        });
        assert.equal(await source.ready, false);
        assert.equal(page.frameCallbacks.length, 0, 'no frame loop without a source');
        source.dispose();
    }
    assert.deepEqual(statuses, ['failed', 'failed']);
});

test('a name the engine refuses never asks for the camera', async () => {
    const page = fakePage();
    const context = recordingContext({ accept: false });
    const source = setupLiveTextureSource(context, { name: 'main', src: 'camera', maxSize: 1024 }, {
        documentRef: /** @type {any} */ (page.documentRef),
        navigatorRef: /** @type {any} */ (page.navigatorRef),
        log: '[test]',
    });
    assert.equal(await source.registered, false);
    assert.equal(await source.ready, false);
    assert.ok(!page.events.some(([name]) => name === 'getUserMedia'));
    source.dispose();
});

test('a source disposed while the camera prompt is open releases the camera when it answers', async () => {
    const page = fakePage();
    /** @type {(stream: unknown) => void} */
    let answer = () => {};
    page.navigatorRef.mediaDevices.getUserMedia = () =>
        new Promise((resolve) => {
            answer = resolve;
        });
    const context = recordingContext();
    const source = setupLiveTextureSource(context, { name: 'webcam', src: 'camera', maxSize: 1024 }, {
        documentRef: /** @type {any} */ (page.documentRef),
        navigatorRef: /** @type {any} */ (page.navigatorRef),
        log: '[test]',
    });
    await source.registered;
    await new Promise((resolve) => setTimeout(resolve, 0));
    source.dispose();
    let stopped = 0;
    answer({ getTracks: () => [{ stop: () => (stopped += 1) }] });
    assert.equal(await source.ready, false);
    assert.equal(stopped, 1);
    assert.equal(page.frameCallbacks.length, 0);
});

test('wireLiveTexture does nothing without ?liveTex=1, and registers before resolving with it', async () => {
    const page = fakePage();
    const owned = [];
    const context = {
        ...recordingContext(),
        destroyed: false,
        own: (disposable) => {
            owned.push(disposable);
            return disposable;
        },
    };
    const deps = (query) =>
        /** @type {any} */ ({
            profile: { urlContextConfig: true },
            log: '[test]',
            documentRef: page.documentRef,
            windowRef: { navigator: page.navigatorRef },
            params: new URLSearchParams(query),
        });

    await wireLiveTexture(/** @type {any} */ (context), deps(''));
    assert.deepEqual(context.calls, []);

    await wireLiveTexture(/** @type {any} */ (context), deps('liveTex=1'));
    assert.deepEqual(context.calls[0], ['register', 'webcam', 1, 1, { followSource: true }]);
    assert.equal(owned.length, 1, 'the source is tied to the context');
    owned[0].dispose();
});
