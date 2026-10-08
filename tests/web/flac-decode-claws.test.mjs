// FLACs whose frame headers say "sample rate / sample size: from STREAMINFO"
// (codes 0000 / 000), e.g. songs/Claws of the Angel.flac. The FLAC player's
// worker decoder, @wasm-audio-decoders/flac, returns 0 samples for them (every
// frame LOST_SYNC), so html/flac-player/decode-guard.js rewrites the headers
// before decoding and falls back to Web Audio when the worker still fails.
//
// Fixtures (tests/web/fixtures/flac/): 0.25 s of 44.1 kHz stereo sine, encoded
// by ffmpeg with 4096-sample blocks, then every frame header rewritten to
// codes 0000 / 000 (CRC-8 and CRC-16 recomputed) and the PADDING block
// dropped. ffmpeg decodes both cleanly; the WASM decoder decodes neither.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FLACDecoder } from '@wasm-audio-decoders/flac';
import {
    audioBufferToDecodeResult,
    decodeWithWebAudio,
    installFlacPlayerDecodeGuard,
    installWorkerFlacDecodeGuard,
    isEmptyDecodeResult,
    normalizeFlacFrameHeaders,
    parseFlacFrameHeader,
    parseFlacStreamInfo,
    prepareFlacForDecode,
} from '../../html/flac-player/decode-guard.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/flac');

/** @param {string} name */
function loadFixture(name) {
    const bytes = readFileSync(join(fixtures, name));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** @param {ArrayBuffer} buffer */
function withId3v2Prefix(buffer) {
    const tagBody = 32;
    const out = new Uint8Array(10 + tagBody + buffer.byteLength);
    out.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, tagBody]);
    out.set(new Uint8Array(buffer), 10 + tagBody);
    return out.buffer;
}

/**
 * Decode the way the player's worker does, without the console noise the
 * decoder prints for each error.
 * @param {ArrayBuffer} buffer
 */
async function wasmDecode(buffer) {
    const decoder = new FLACDecoder();
    await decoder.ready;
    const originalError = console.error;
    console.error = () => {};
    try {
        return await decoder.decodeFile(new Uint8Array(buffer));
    } finally {
        console.error = originalError;
        decoder.free();
    }
}

/**
 * Stand-in for the bundle's decoder worker (bundle.4f00c4158ff714867bc6.js,
 * webpack chunk 948): `init` -> `ready`; `decode` -> `decoded` with
 * `{ sampleRate, channels, interleavedBuffer, duration, bitDepth,
 * samplesDecoded }`; a throw -> `error`.
 * @param {(buffer: ArrayBuffer) => Promise<any>} decode
 */
function makeFakeWorker(decode) {
    return class FakeWorker {
        constructor() {
            /** @type {any} */
            this._onmessage = null;
            /** @type {any[]} */
            this.posted = [];
        }

        get onmessage() {
            return this._onmessage;
        }

        set onmessage(handler) {
            this._onmessage = handler;
        }

        /** @param {any} message @param {any} [transfer] */
        postMessage(message, transfer) {
            this.posted.push({ message, transfer });
            if (message.type !== 'decode') {
                queueMicrotask(() => this._onmessage?.({ data: { id: message.id, type: 'ready' } }));
                return;
            }
            decode(message.data.arrayBuffer).then(
                (result) => this._onmessage?.({ data: { id: message.id, type: 'decoded', result } }),
                (error) => this._onmessage?.({ data: { id: message.id, type: 'error', error: error.message } })
            );
        }
    };
}

/**
 * What the bundle's worker computes from FLACDecoder.decodeFile — note it does
 * not forward `errors`.
 * @param {ArrayBuffer} buffer
 */
async function bundleWorkerDecode(buffer) {
    const decoded = await wasmDecode(buffer);
    const channels = decoded.channelData.length;
    const frames = decoded.samplesDecoded;
    const interleavedBuffer = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
        for (let i = 0; i < frames; i++) {
            interleavedBuffer[i * channels + c] = decoded.channelData[c][i];
        }
    }
    return {
        sampleRate: decoded.sampleRate,
        channels,
        interleavedBuffer,
        duration: frames / (decoded.sampleRate || 1),
        bitDepth: decoded.bitDepth,
        samplesDecoded: frames,
    };
}

/**
 * Post one `decode` through a guarded worker; resolve with the reply the
 * bundle's onmessage handler sees.
 * @param {any} windowRef
 * @param {ArrayBuffer} buffer
 */
function decodeThroughGuard(windowRef, buffer) {
    return new Promise((resolve) => {
        const worker = new windowRef.Worker('decoder.js');
        worker.onmessage = (/** @type {any} */ event) => resolve(event.data);
        worker.postMessage({ id: 7, type: 'decode', data: { arrayBuffer: buffer } }, [buffer]);
    });
}

test('STREAMINFO of the 24-bit fixture', () => {
    const info = parseFlacStreamInfo(loadFixture('streaminfo-coded-24bit.flac'));
    assert.deepEqual(info, {
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: 24,
        totalSamples: 11025,
        duration: 0.25,
        audioOffset: 92,
    });
    assert.equal(parseFlacStreamInfo(new Uint8Array([1, 2, 3, 4]).buffer), null);
    assert.equal(parseFlacStreamInfo(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80]).buffer), null);
});

test('fixture frame headers take rate and size from STREAMINFO', () => {
    const buffer = loadFixture('streaminfo-coded-24bit.flac');
    const bytes = new Uint8Array(buffer);
    const { audioOffset } = /** @type {any} */ (parseFlacStreamInfo(buffer));
    assert.deepEqual([...bytes.subarray(audioOffset, audioOffset + 4)], [0xff, 0xf8, 0xc0, 0x10]);
    assert.deepEqual(parseFlacFrameHeader(bytes, audioOffset), {
        length: 5,
        variable: false,
        number: 0,
        blockSize: 4096,
    });
});

test('the WASM decoder alone returns no audio for STREAMINFO-coded headers', async () => {
    const decoded = await wasmDecode(loadFixture('streaminfo-coded-24bit.flac'));
    assert.equal(decoded.samplesDecoded, 0);
    assert.ok(decoded.errors.length > 0);
    assert.match(decoded.errors[0].message, /LOST_SYNC/);
});

for (const [name, bitDepth] of [['streaminfo-coded-24bit.flac', 24], ['streaminfo-coded-16bit.flac', 16]]) {
    test(`normalized ${bitDepth}-bit fixture decodes with 0 errors`, async () => {
        const { buffer, framesRewritten } = normalizeFlacFrameHeaders(loadFixture(String(name)));
        assert.equal(framesRewritten, 3);
        const decoded = await wasmDecode(buffer);
        assert.equal(decoded.errors.length, 0);
        assert.equal(decoded.samplesDecoded, 11025);
        assert.equal(decoded.bitDepth, bitDepth);
        assert.equal(decoded.sampleRate, 44100);
        assert.equal(decoded.channelData.length, 2);
        // ffmpeg's sine source is 1/8 full scale: left 0.7/8, right 0.3/8.
        const peaks = decoded.channelData.map((data) => data.reduce((max, v) => Math.max(max, Math.abs(v)), 0));
        assert.ok(Math.abs(peaks[0] - 0.0875) < 0.002, `left peak ${peaks[0]}`);
        assert.ok(Math.abs(peaks[1] - 0.0375) < 0.002, `right peak ${peaks[1]}`);
    });
}

test('normalizing twice is a no-op', () => {
    const once = normalizeFlacFrameHeaders(loadFixture('streaminfo-coded-24bit.flac')).buffer;
    const copy = once.slice(0);
    const twice = normalizeFlacFrameHeaders(once);
    assert.equal(twice.framesRewritten, 0);
    assert.deepEqual(new Uint8Array(twice.buffer), new Uint8Array(copy));
});

test('ID3v2-prefixed FLAC is stripped and normalized', async () => {
    const prepared = prepareFlacForDecode(withId3v2Prefix(loadFixture('streaminfo-coded-24bit.flac')));
    const decoded = await wasmDecode(prepared);
    assert.equal(decoded.errors.length, 0);
    assert.equal(decoded.samplesDecoded, 11025);
});

test('a trailing ID3v1 tag still closes the last frame', async () => {
    const flac = new Uint8Array(loadFixture('streaminfo-coded-16bit.flac'));
    const tagged = new Uint8Array(flac.length + 128);
    tagged.set(flac);
    tagged.set([0x54, 0x41, 0x47], flac.length);
    const { buffer, framesRewritten } = normalizeFlacFrameHeaders(tagged.buffer);
    assert.equal(framesRewritten, 3);
    const decoded = await wasmDecode(buffer.slice(0, flac.length));
    assert.equal(decoded.errors.length, 0);
});

test('a truncated last frame is left alone', () => {
    const flac = loadFixture('streaminfo-coded-24bit.flac');
    assert.equal(normalizeFlacFrameHeaders(flac.slice(0, flac.byteLength - 10)).framesRewritten, 2);
});

test('streams without an explicit header code are not rewritten', () => {
    const flac = new Uint8Array(loadFixture('streaminfo-coded-24bit.flac'));
    // STREAMINFO sample rate 44100 -> 37800 (no frame-header code exists).
    const rate = 37800;
    flac[18] = rate >> 12;
    flac[19] = (rate >> 4) & 0xff;
    flac[20] = ((rate & 0x0f) << 4) | (flac[20] & 0x0f);
    assert.equal(parseFlacStreamInfo(flac.buffer)?.sampleRate, rate);
    assert.equal(normalizeFlacFrameHeaders(flac.buffer).framesRewritten, 0);
    assert.equal(normalizeFlacFrameHeaders(new ArrayBuffer(8)).framesRewritten, 0);
});

/**
 * A fixture after one normalization pass: explicit header codes, i.e. an
 * ordinary FLAC that the guard sends to the WASM worker first.
 * @param {string} name
 */
function ordinaryFlac(name) {
    return normalizeFlacFrameHeaders(loadFixture(name)).buffer;
}

/** @param {any} worker */
function postedDecodes(worker) {
    return worker.posted.filter((/** @type {any} */ p) => p.message.type === 'decode');
}

/**
 * Like decodeThroughGuard, but also hands back the worker instance.
 * @param {any} windowRef
 * @param {ArrayBuffer} buffer
 */
async function decodeWithWorker(windowRef, buffer) {
    const worker = new windowRef.Worker('decoder.js');
    const reply = await new Promise((resolve) => {
        worker.onmessage = (/** @type {any} */ event) => resolve(event.data);
        worker.postMessage({ id: 7, type: 'decode', data: { arrayBuffer: buffer } }, [buffer]);
    });
    return { worker, reply: /** @type {any} */ (reply) };
}

test('guarded worker without a native decoder: STREAMINFO-coded FLAC decodes through WASM with 0 errors', async () => {
    // Node has no OfflineAudioContext, so this is the rewritten-header WASM
    // path end to end, with the bundle worker's real decoder.
    const windowRef = { Worker: makeFakeWorker(bundleWorkerDecode) };
    /** @type {string[]} */
    const logs = [];
    const undo = installWorkerFlacDecodeGuard(windowRef, { log: (message) => logs.push(message) });
    const reply = await decodeThroughGuard(windowRef, loadFixture('streaminfo-coded-24bit.flac'));
    assert.equal(reply.type, 'decoded');
    assert.equal(reply.id, 7);
    assert.equal(reply.result.channels, 2);
    assert.equal(reply.result.sampleRate, 44100);
    assert.equal(reply.result.interleavedBuffer.length, 22050);
    assert.equal(reply.result.samplesDecoded, 11025, 'no frame lost to LOST_SYNC');
    assert.equal(reply.result.bitDepth, 24);
    assert.equal(reply.result.bitsPerSample, 24);
    assert.equal(reply.result.duration, 0.25);
    assert.deepEqual(logs, []);
    undo();
    assert.notEqual(windowRef.Worker.name, 'GuardedWorker');
});

for (const [name, bitDepth] of [['streaminfo-coded-16bit.flac', 16], ['streaminfo-coded-24bit.flac', 24]]) {
    test(`guarded worker: ${bitDepth}-bit ID3v2-prefixed FLAC decodes through WASM with 0 errors`, async () => {
        const windowRef = { Worker: makeFakeWorker(bundleWorkerDecode) };
        installWorkerFlacDecodeGuard(windowRef, { log: () => {} });
        const reply = await decodeThroughGuard(windowRef, withId3v2Prefix(loadFixture(String(name))));
        assert.equal(reply.type, 'decoded');
        assert.equal(reply.result.samplesDecoded, 11025);
        assert.equal(reply.result.bitDepth, bitDepth);
    });
}

test('guarded worker: rewritten streams try the native decoder first', async () => {
    const windowRef = { Worker: makeFakeWorker(bundleWorkerDecode) };
    /** @type {ArrayBuffer[]} */
    const nativeInputs = [];
    /** @type {string[]} */
    const logs = [];
    installWorkerFlacDecodeGuard(windowRef, {
        nativeDecode: async (buffer) => {
            nativeInputs.push(buffer);
            return bundleWorkerDecode(buffer);
        },
        log: (message) => logs.push(message),
    });
    const { worker, reply } = await decodeWithWorker(windowRef, loadFixture('streaminfo-coded-24bit.flac'));
    assert.equal(postedDecodes(worker).length, 0, 'the WASM worker is not asked');
    assert.equal(nativeInputs.length, 1);
    assert.equal(reply.type, 'decoded');
    assert.equal(reply.id, 7);
    assert.equal(reply.result.interleavedBuffer.length, 22050);
    assert.equal(reply.result.bitDepth, 24);
    assert.match(logs[0], /3 FLAC frame headers take rate\/size from STREAMINFO/);
});

test('guarded worker: when the native decoder fails, rewritten headers decode through WASM', async () => {
    const windowRef = { Worker: makeFakeWorker(bundleWorkerDecode) };
    let nativeCalls = 0;
    installWorkerFlacDecodeGuard(windowRef, {
        nativeDecode: async () => {
            nativeCalls++;
            throw new Error('EncodingError: Unable to decode audio data');
        },
        log: () => {},
    });
    const { worker, reply } = await decodeWithWorker(windowRef, loadFixture('streaminfo-coded-24bit.flac'));
    assert.equal(postedDecodes(worker).length, 1);
    assert.equal(postedDecodes(worker)[0].transfer, undefined, 'structured clone, not a transfer');
    assert.equal(nativeCalls, 1, 'the native decoder is not retried');
    assert.equal(reply.type, 'decoded');
    assert.equal(reply.result.samplesDecoded, 11025);
});

test('guarded worker: rewritten stream that neither decoder can play is an error reply', async () => {
    const windowRef = { Worker: makeFakeWorker(async () => ({ sampleRate: 0, channels: 0, interleavedBuffer: new Float32Array(0), duration: 0 })) };
    installWorkerFlacDecodeGuard(windowRef, {
        nativeDecode: async () => ({ sampleRate: 0, channels: 0, interleavedBuffer: new Float32Array(0), duration: 0 }),
        log: () => {},
    });
    const reply = await decodeThroughGuard(windowRef, loadFixture('streaminfo-coded-16bit.flac'));
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /decoder produced no audio; native decoder: native decoder already failed/);
});

test('guarded worker: an empty WASM result falls back to the native decoder', async () => {
    const windowRef = { Worker: makeFakeWorker(async () => ({ sampleRate: 0, channels: 0, interleavedBuffer: new Float32Array(0), duration: 0 })) };
    /** @type {ArrayBuffer[]} */
    const nativeInputs = [];
    installWorkerFlacDecodeGuard(windowRef, {
        nativeDecode: async (buffer) => {
            nativeInputs.push(buffer);
            return bundleWorkerDecode(buffer);
        },
        log: () => {},
    });
    const { worker, reply } = await decodeWithWorker(windowRef, ordinaryFlac('streaminfo-coded-24bit.flac'));
    assert.equal(postedDecodes(worker).length, 1, 'ordinary streams go to WASM first');
    assert.equal(nativeInputs.length, 1);
    assert.equal(parseFlacStreamInfo(nativeInputs[0])?.bitsPerSample, 24);
    assert.equal(reply.type, 'decoded');
    assert.equal(reply.result.channels, 2);
    assert.equal(reply.result.interleavedBuffer.length, 22050);
    assert.equal(reply.result.bitsPerSample, 24);
});

test('guarded worker: a worker error falls back, and a failed fallback stays an error', async () => {
    const failing = makeFakeWorker(async () => {
        throw new Error('wasm exploded');
    });
    const recovered = { Worker: failing };
    installWorkerFlacDecodeGuard(recovered, {
        nativeDecode: async () => ({ sampleRate: 44100, channels: 1, interleavedBuffer: new Float32Array(4), duration: 0 }),
        log: () => {},
    });
    const ok = await decodeThroughGuard(recovered, ordinaryFlac('streaminfo-coded-16bit.flac'));
    assert.equal(ok.type, 'decoded');
    assert.equal(ok.result.duration, 0.25, 'duration comes from STREAMINFO when the decoder leaves it out');
    assert.equal(ok.result.bitsPerSample, 16);

    const unrecoverable = { Worker: makeFakeWorker(async () => null) };
    installWorkerFlacDecodeGuard(unrecoverable, {
        nativeDecode: async () => {
            throw new Error('EncodingError');
        },
        log: () => {},
    });
    const failed = await decodeThroughGuard(unrecoverable, ordinaryFlac('streaminfo-coded-16bit.flac'));
    assert.equal(failed.type, 'error');
    assert.equal(failed.id, 7);
    assert.match(failed.error, /decoder produced no audio.*EncodingError/);

    const workerError = { Worker: failing };
    installWorkerFlacDecodeGuard(workerError, { log: () => {} });
    const noNative = await decodeThroughGuard(workerError, ordinaryFlac('streaminfo-coded-16bit.flac'));
    assert.equal(noNative.type, 'error');
    assert.match(noNative.error, /worker error: wasm exploded; native decoder: no native decoder/);
});

test('guarded worker: decoder errors prefer the native decoder but keep WASM audio if it fails', async () => {
    const partial = { sampleRate: 44100, channels: 2, interleavedBuffer: new Float32Array(22050), duration: 1, errors: [{ message: 'LOST_SYNC' }] };
    const windowA = { Worker: makeFakeWorker(async () => partial) };
    installWorkerFlacDecodeGuard(windowA, {
        nativeDecode: async () => ({ sampleRate: 44100, channels: 2, interleavedBuffer: new Float32Array(16), duration: 2 }),
        log: () => {},
    });
    const replaced = await decodeThroughGuard(windowA, ordinaryFlac('streaminfo-coded-16bit.flac'));
    assert.equal(replaced.result.interleavedBuffer.length, 16);

    const windowB = { Worker: makeFakeWorker(async () => partial) };
    installWorkerFlacDecodeGuard(windowB, {
        nativeDecode: async () => ({ sampleRate: 0, channels: 0, interleavedBuffer: new Float32Array(0), duration: 0 }),
        log: () => {},
    });
    const kept = await decodeThroughGuard(windowB, ordinaryFlac('streaminfo-coded-16bit.flac'));
    assert.equal(kept.type, 'decoded');
    assert.equal(kept.result.interleavedBuffer.length, 22050);
});

test('guarded worker: missing frames (the worker drops decoder errors) fall back too', async () => {
    // The bundle's worker reports a decode with failed frames as a success
    // with fewer samples than STREAMINFO promises.
    const windowRef = {
        Worker: makeFakeWorker(async (buffer) => {
            const full = await bundleWorkerDecode(buffer);
            const kept = 4096 * full.channels;
            return { ...full, interleavedBuffer: full.interleavedBuffer.slice(0, kept), samplesDecoded: 4096 };
        }),
    };
    /** @type {string[]} */
    const logs = [];
    installWorkerFlacDecodeGuard(windowRef, {
        nativeDecode: bundleWorkerDecode,
        log: (message) => logs.push(message),
    });
    const reply = await decodeThroughGuard(windowRef, ordinaryFlac('streaminfo-coded-24bit.flac'));
    assert.equal(reply.result.interleavedBuffer.length, 22050);
    assert.match(logs[0], /6929 of 11025 samples missing/);
});

test('guarded worker uses OfflineAudioContext as its default native decoder', async () => {
    let constructed = 0;
    class FakeOfflineAudioContext {
        constructor() {
            constructed++;
        }

        async decodeAudioData() {
            return {
                numberOfChannels: 2,
                length: 11025,
                sampleRate: 44100,
                getChannelData: () => new Float32Array(11025),
            };
        }
    }
    const windowRef = { Worker: makeFakeWorker(bundleWorkerDecode), OfflineAudioContext: FakeOfflineAudioContext };
    installWorkerFlacDecodeGuard(windowRef, { log: () => {} });
    const { worker, reply } = await decodeWithWorker(windowRef, loadFixture('streaminfo-coded-24bit.flac'));
    assert.equal(constructed, 1);
    assert.equal(postedDecodes(worker).length, 0);
    assert.equal(reply.result.interleavedBuffer.length, 22050);
    assert.equal(reply.result.bitDepth, 24);
});

test('guarded worker passes other messages and handlers through', async () => {
    const windowRef = { Worker: makeFakeWorker(async () => null) };
    const undo = installWorkerFlacDecodeGuard(windowRef);
    assert.equal(installWorkerFlacDecodeGuard(windowRef)(), undefined, 'second install is a no-op');
    const worker = new windowRef.Worker('decoder.js');
    assert.equal(worker.onmessage, null);
    worker.onmessage = null;
    const reply = await new Promise((resolve) => {
        worker.onmessage = (/** @type {any} */ event) => resolve(event.data);
        worker.postMessage({ id: 1, type: 'init' }, []);
    });
    assert.deepEqual(reply, { id: 1, type: 'ready' });
    assert.deepEqual(worker.posted[0].transfer, []);
    undo();
    assert.equal(installWorkerFlacDecodeGuard({})(), undefined);
});

test('decodeWithWebAudio decodes at the STREAMINFO rate and interleaves', async () => {
    /** @type {any[]} */
    const contexts = [];
    class FakeOfflineAudioContext {
        /** @param {number} channels @param {number} length @param {number} sampleRate */
        constructor(channels, length, sampleRate) {
            contexts.push({ channels, length, sampleRate });
            this.sampleRate = sampleRate;
        }

        /** @param {ArrayBuffer} buffer */
        async decodeAudioData(buffer) {
            assert.ok(buffer.byteLength > 0);
            const left = new Float32Array([0.1, 0.2]);
            const right = new Float32Array([-0.1, -0.2]);
            return {
                numberOfChannels: 2,
                length: 2,
                sampleRate: this.sampleRate,
                getChannelData: (/** @type {number} */ c) => (c === 0 ? left : right),
            };
        }
    }
    const result = await decodeWithWebAudio(loadFixture('streaminfo-coded-24bit.flac'), {
        OfflineAudioContext: FakeOfflineAudioContext,
    });
    assert.deepEqual(contexts, [{ channels: 2, length: 1, sampleRate: 44100 }]);
    assert.deepEqual([...result.interleavedBuffer].map((v) => Math.round(v * 10) / 10), [0.1, -0.1, 0.2, -0.2]);
    assert.equal(result.bitsPerSample, 24);
    assert.equal(result.duration, 2 / 44100);
    await assert.rejects(decodeWithWebAudio(new ArrayBuffer(4), {}), /OfflineAudioContext unavailable/);
});

test('audioBufferToDecodeResult defaults to 16-bit without STREAMINFO; empty results are detected', () => {
    const result = audioBufferToDecodeResult({
        numberOfChannels: 1,
        length: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array([0.5]),
    });
    assert.equal(result.bitsPerSample, 16);
    assert.equal(isEmptyDecodeResult(result), false);
    assert.equal(isEmptyDecodeResult(null), true);
    assert.equal(isEmptyDecodeResult({ ...result, channels: 0 }), true);
    assert.equal(isEmptyDecodeResult({ ...result, interleavedBuffer: new Float32Array(0) }), true);
});

test('installFlacPlayerDecodeGuard installs and removes both guards', () => {
    function FakeAudioWorkletNode() {}
    FakeAudioWorkletNode.prototype = {};
    const windowRef = { Worker: makeFakeWorker(async () => null), AudioWorkletNode: FakeAudioWorkletNode };
    const OriginalWorker = windowRef.Worker;
    const undo = installFlacPlayerDecodeGuard(windowRef, { log: () => {} });
    assert.notEqual(windowRef.Worker, OriginalWorker);
    assert.notEqual(windowRef.AudioWorkletNode, FakeAudioWorkletNode);
    undo();
    assert.equal(windowRef.Worker, OriginalWorker);
    assert.equal(windowRef.AudioWorkletNode, FakeAudioWorkletNode);
});
