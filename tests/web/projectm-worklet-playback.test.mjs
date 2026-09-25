import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ensureWorkletReady,
    installWorkletPlaybackSafetyNet,
    loadWavBytesIntoWorklet,
} from '../../html/projectm-worklet-playback.js';
import {
    createAudioSourceRouter,
    registerHostAudioSourceRouter,
    setHostAudioSourceRouter,
    unregisterHostAudioSourceRouter,
} from '../../html/projectm-audio-source-router.js';

function installMockAudioEnv({
    workletNode = null,
    addModuleImpl,
    createNodeImpl,
} = {}) {
    const ctx = {
        state: 'running',
        resume: async () => {
            ctx.state = 'running';
        },
        audioWorklet: {
            addModule: addModuleImpl || (async () => {}),
        },
    };
    globalThis.projectMAudioContext_Global_Cpp = ctx;
    globalThis.projectMWorkletNode_Global_Cpp = workletNode;

    class FakeAudioWorkletNode {
        constructor() {
            this.port = { onmessage: null, postMessage() {} };
            this.connect = () => {};
        }
    }
    globalThis.AudioWorkletNode = createNodeImpl || FakeAudioWorkletNode;
    return ctx;
}

function clearMockAudioEnv() {
    delete globalThis.projectMAudioContext_Global_Cpp;
    delete globalThis.projectMWorkletNode_Global_Cpp;
    delete globalThis.AudioWorkletNode;
    delete globalThis.__projectMWorkletSafetyNetInstalled;
    delete globalThis.projectMLoadSongIntoWorklet;
    delete globalThis.projectMSongLoadState;
    delete globalThis.projectMLastSongPath;
    delete globalThis.projectMWorkletReady;
    delete globalThis.Module;
    setHostAudioSourceRouter(null);
}

test('ensureWorkletReady returns true when worklet already exists', async () => {
    clearMockAudioEnv();
    installMockAudioEnv({ workletNode: { port: {} } });
    assert.equal(await ensureWorkletReady({ timeoutMs: 200, pollMs: 10 }), true);
    clearMockAudioEnv();
});

test('ensureWorkletReady repairs missing worklet node when AudioContext exists', async () => {
    clearMockAudioEnv();
    let addModuleCalls = 0;
    installMockAudioEnv({
        workletNode: null,
        addModuleImpl: async () => {
            addModuleCalls += 1;
        },
    });

    assert.equal(await ensureWorkletReady({ timeoutMs: 1000, pollMs: 10 }), true);
    assert.equal(addModuleCalls, 1);
    assert.ok(globalThis.projectMWorkletNode_Global_Cpp);
    clearMockAudioEnv();
});

test('ensureWorkletReady returns false when AudioContext never appears', async () => {
    clearMockAudioEnv();
    assert.equal(await ensureWorkletReady({ timeoutMs: 80, pollMs: 20 }), false);
    clearMockAudioEnv();
});

// ---- Router notification (the worklet path reads the router the host registered)

/** A decodable stub context: enough for loadWavBytesIntoWorklet(). */
function installDecodingAudioEnv() {
    const posted = [];
    const workletNode = { port: { postMessage: (message) => posted.push(message) } };
    const ctx = installMockAudioEnv({ workletNode });
    ctx.decodeAudioData = async () => ({
        duration: 1,
        sampleRate: 48000,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(4),
    });
    return { ctx, posted };
}

test('the worklet path notifies the router the host actually registered', async () => {
    clearMockAudioEnv();
    const { posted } = installDecodingAudioEnv();
    // Registers itself in the hand-written registry, exactly as ProjectMContext's does.
    const router = createAudioSourceRouter({ autoSwitchOnFeed: true });
    assert.equal(router.getActiveSource(), 'none');

    const ok = await loadWavBytesIntoWorklet(new Uint8Array([1, 2, 3, 4]), false, true);

    assert.equal(ok, true);
    // notifyWorkletFeed() promoted the router: it never fired while this module
    // read a second, generated registry that nothing wrote to.
    assert.equal(router.getActiveSource(), 'worklet');
    assert.equal(posted[0]?.type, 'loadWavData');
    router.destroy();
    clearMockAudioEnv();
});

test('the worklet path calls notifyWorkletFeed on a registered router exactly once per load', async () => {
    clearMockAudioEnv();
    installDecodingAudioEnv();
    let notified = 0;
    const router = /** @type {any} */ ({ notifyWorkletFeed: () => { notified += 1; } });
    registerHostAudioSourceRouter(router);

    await loadWavBytesIntoWorklet(new Uint8Array([1, 2, 3, 4]));

    assert.equal(notified, 1);
    unregisterHostAudioSourceRouter(router);
    clearMockAudioEnv();
});

test('the worklet path works with no router registered', async () => {
    clearMockAudioEnv();
    installDecodingAudioEnv();
    assert.equal(await loadWavBytesIntoWorklet(new Uint8Array([1, 2, 3, 4])), true);
    clearMockAudioEnv();
});

// ---- Repair path -----------------------------------------------------------

test('repair loads the processor from a URL resolved against the module, not the page', async () => {
    clearMockAudioEnv();
    const urls = [];
    installMockAudioEnv({ addModuleImpl: async (url) => { urls.push(url); } });

    assert.equal(await ensureWorkletReady({ timeoutMs: 1000, pollMs: 10 }), true);

    assert.equal(urls.length, 1);
    const expected = new URL('../../html/projectm_audio_processor.js', import.meta.url).href;
    assert.equal(urls[0], expected, 'an absolute URL beside the module, so a bundle in node_modules does not ask the page');
    clearMockAudioEnv();
});

test('repair waits for the engine\'s in-flight setup instead of racing it', async () => {
    clearMockAudioEnv();
    let addModuleCalls = 0;
    installMockAudioEnv({ addModuleImpl: async () => { addModuleCalls += 1; } });
    /** @type {(node: unknown) => void} */
    let engineReady = () => {};
    globalThis.projectMWorkletReady = new Promise((resolve) => { engineReady = resolve; });

    const pending = ensureWorkletReady({ timeoutMs: 2000, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(addModuleCalls, 0, 'no second addModule() while the engine\'s is pending');

    const engineNode = { port: { postMessage() {} } };
    globalThis.projectMWorkletNode_Global_Cpp = engineNode;
    engineReady(engineNode);

    assert.equal(await pending, true);
    assert.equal(addModuleCalls, 0);
    assert.equal(globalThis.projectMWorkletNode_Global_Cpp, engineNode, 'the engine\'s node is not replaced');
    clearMockAudioEnv();
});

test('repair takes over once the engine\'s setup has failed', async () => {
    clearMockAudioEnv();
    let addModuleCalls = 0;
    installMockAudioEnv({ addModuleImpl: async () => { addModuleCalls += 1; } });
    /** @type {(error: Error) => void} */
    let engineFailed = () => {};
    globalThis.projectMWorkletReady = new Promise((_, reject) => { engineFailed = reject; });

    const pending = ensureWorkletReady({ timeoutMs: 2000, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(addModuleCalls, 0);

    // The engine's catch block clears the node, then rejects.
    globalThis.projectMWorkletNode_Global_Cpp = null;
    engineFailed(new Error('addModule failed'));

    assert.equal(await pending, true);
    assert.equal(addModuleCalls, 1, 'exactly one setup ran after the engine\'s attempt settled');
    assert.ok(globalThis.projectMWorkletNode_Global_Cpp);
    clearMockAudioEnv();
});

test('repair gives up, without starting a second setup, when the engine\'s never settles', async () => {
    clearMockAudioEnv();
    let addModuleCalls = 0;
    installMockAudioEnv({ addModuleImpl: async () => { addModuleCalls += 1; } });
    globalThis.projectMWorkletReady = new Promise(() => {});

    assert.equal(await ensureWorkletReady({ timeoutMs: 120, pollMs: 10 }), false);
    assert.equal(addModuleCalls, 0);
    assert.equal(globalThis.projectMWorkletNode_Global_Cpp, null);
    clearMockAudioEnv();
});

test('a repaired node is published before the engine attaches its ingest', async () => {
    clearMockAudioEnv();
    installMockAudioEnv({});
    let seenByIngest = 'not called';
    globalThis.Module = {
        // WasmAudioBridge.cpp's js_install_worklet_pcm_handler reads the node
        // from this global and returns without installing anything if it is null.
        _attach_worklet_ingest: () => { seenByIngest = globalThis.projectMWorkletNode_Global_Cpp; },
    };

    assert.equal(await ensureWorkletReady({ timeoutMs: 1000, pollMs: 10 }), true);

    assert.notEqual(seenByIngest, 'not called');
    assert.ok(seenByIngest, 'the ingest must see the node, or the repaired worklet has no PCM handler');
    assert.equal(seenByIngest, globalThis.projectMWorkletNode_Global_Cpp);
    clearMockAudioEnv();
});

test('a repair that fails while attaching does not leave a half-wired node published', async () => {
    clearMockAudioEnv();
    installMockAudioEnv({});
    globalThis.Module = { _attach_worklet_ingest: () => { throw new Error('attach failed'); } };
    const originalError = console.error;
    console.error = () => {};
    try {
        assert.equal(await ensureWorkletReady({ timeoutMs: 60, pollMs: 10 }), false);
    } finally {
        console.error = originalError;
    }
    assert.equal(globalThis.projectMWorkletNode_Global_Cpp, null);
    clearMockAudioEnv();
});

// ---- Safety net lifecycle ---------------------------------------------------

function installFakeBroadcastChannel() {
    const original = globalThis.BroadcastChannel;
    /** @type {any[]} */
    const instances = [];
    class FakeBroadcastChannel {
        constructor(name) {
            this.name = name;
            this.closed = false;
            this.listeners = [];
            instances.push(this);
        }
        addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
        close() { this.closed = true; }
        emit(data) { for (const listener of this.listeners) listener({ data }); }
    }
    globalThis.BroadcastChannel = /** @type {any} */ (FakeBroadcastChannel);
    return {
        instances,
        restore() { globalThis.BroadcastChannel = original; },
    };
}

test('the safety net is shared, and its channel closes when the last holder releases', () => {
    clearMockAudioEnv();
    const fake = installFakeBroadcastChannel();
    try {
        const releaseA = installWorkletPlaybackSafetyNet();
        const releaseB = installWorkletPlaybackSafetyNet();
        assert.equal(fake.instances.length, 1, 'two contexts share one channel');
        assert.equal(fake.instances[0].name, 'file');
        assert.equal(typeof globalThis.projectMLoadSongIntoWorklet, 'function');

        releaseA();
        assert.equal(fake.instances[0].closed, false, 'context B still needs it');
        assert.equal(typeof globalThis.projectMLoadSongIntoWorklet, 'function');

        releaseB();
        assert.equal(fake.instances[0].closed, true, 'the channel no longer outlives its last context');
        assert.equal(globalThis.projectMLoadSongIntoWorklet, undefined);

        releaseB();
        releaseA();
        assert.equal(fake.instances.length, 1, 'releases are idempotent');
    } finally {
        fake.restore();
        clearMockAudioEnv();
    }
});

test('a fresh install after the last release opens a new channel', () => {
    clearMockAudioEnv();
    const fake = installFakeBroadcastChannel();
    try {
        installWorkletPlaybackSafetyNet()();
        const release = installWorkletPlaybackSafetyNet();
        assert.equal(fake.instances.length, 2);
        assert.equal(fake.instances[0].closed, true);
        assert.equal(fake.instances[1].closed, false);
        release();
    } finally {
        fake.restore();
        clearMockAudioEnv();
    }
});

test('releasing the safety net cancels a retry that is still waiting on its timer', async () => {
    clearMockAudioEnv();
    const fake = installFakeBroadcastChannel();
    const { posted } = installDecodingAudioEnv();
    globalThis.projectMLastSongPath = '/snd/never.wav';
    try {
        const release = installWorkletPlaybackSafetyNet();
        fake.instances[0].emit({ data: new Uint8Array([1, 2, 3, 4]) });
        release();
        await new Promise((resolve) => setTimeout(resolve, 520));
        assert.equal(posted.length, 0, 'the 400 ms retry must not fire after the net was torn down');
    } finally {
        fake.restore();
        clearMockAudioEnv();
    }
});

test('projectMLoadSongIntoWorklet returns the promise it used to drop, and a page hook is restored', async () => {
    clearMockAudioEnv();
    const fake = installFakeBroadcastChannel();
    const pageHook = () => 'page';
    // A ready worklet, so the load fails fast (no FS) instead of waiting out ensureWorkletReady().
    installMockAudioEnv({ workletNode: { port: { postMessage() {} } } });
    globalThis.projectMLoadSongIntoWorklet = pageHook;
    try {
        const release = installWorkletPlaybackSafetyNet();
        const result = globalThis.projectMLoadSongIntoWorklet('/snd/x.wav');
        assert.ok(result && typeof result.then === 'function', 'callers can await the load');
        assert.equal(await result, false, 'no FS in this environment: reported through the result, not a rejection');

        release();
        assert.equal(globalThis.projectMLoadSongIntoWorklet, pageHook);
    } finally {
        fake.restore();
        delete globalThis.projectMLoadSongIntoWorklet;
        clearMockAudioEnv();
    }
});
