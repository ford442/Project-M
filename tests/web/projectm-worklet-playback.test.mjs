import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureWorkletReady } from '../../html/projectm-worklet-playback.js';

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
