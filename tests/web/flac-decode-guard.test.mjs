import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clampAudioChannelCount,
    installAudioWorkletChannelGuard,
    installWorkerFlacDecodeGuard,
    isFlacMagic,
    stripId3Prefix,
} from '../../html/flac-player/decode-guard.js';

test('stripId3Prefix leaves fLaC streams untouched', () => {
    const raw = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 1, 2, 3]).buffer;
    assert.equal(isFlacMagic(raw), true);
    assert.equal(stripId3Prefix(raw), raw);
});

test('stripId3Prefix removes an ID3v2 header', () => {
    const payload = new Uint8Array(20);
    payload.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4]);
    payload.set([0x66, 0x4c, 0x61, 0x43], 14);
    const stripped = stripId3Prefix(payload.buffer);
    assert.equal(isFlacMagic(stripped), true);
});

test('clampAudioChannelCount rejects 0', () => {
    assert.equal(clampAudioChannelCount(0), 2);
    assert.equal(clampAudioChannelCount(undefined), 2);
    assert.equal(clampAudioChannelCount(1), 1);
    assert.equal(clampAudioChannelCount(99), 32);
});

test('AudioWorkletNode guard rewrites a 0-channel output count', () => {
    const calls = [];
    function FakeAudioWorkletNode(context, name, options) {
        calls.push({ context, name, options });
    }
    FakeAudioWorkletNode.prototype = {};
    const windowRef = { AudioWorkletNode: FakeAudioWorkletNode };
    const undo = installAudioWorkletChannelGuard(windowRef);
    // eslint-disable-next-line new-cap
    windowRef.AudioWorkletNode({}, 'flac-processor', { outputChannelCount: [0] });
    assert.deepEqual(calls[0].options.outputChannelCount, [2]);
    undo();
});

test('worker decode guard strips ID3 before transfer', () => {
    const posted = [];
    function FakeWorker() {}
    FakeWorker.prototype.postMessage = function (message, transfer) {
        posted.push({ message, transfer });
    };
    const windowRef = { Worker: FakeWorker };
    const undo = installWorkerFlacDecodeGuard(windowRef);
    const payload = new Uint8Array(20);
    payload.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4]);
    payload.set([0x66, 0x4c, 0x61, 0x43], 14);
    FakeWorker.prototype.postMessage({
        type: 'decode',
        data: { arrayBuffer: payload.buffer },
    }, [payload.buffer]);
    assert.equal(isFlacMagic(posted[0].message.data.arrayBuffer), true);
    undo();
});
