// Hardening for the vendored FLAC player bundle (wasm-audio-decoders).
//
// The bundle decodes local/buffered files in a Worker running
// @wasm-audio-decoders/flac. That fails in three ways:
//   1. ID3-tagged payloads: the decoder never sees `fLaC` -> LOST_SYNC.
//   2. Valid FLACs whose frame headers say "sample rate / sample size: take
//      from STREAMINFO" (codes 0000 / 000), e.g. songs/Claws of the
//      Angel.flac. The decoder hands libFLAC bare frames, never STREAMINFO,
//      and every frame fails with LOST_SYNC: 0 samples, 0 channels. ffmpeg
//      and the browsers' native decoders play these files fine.
//   3. The 0-channel "success" then reaches AudioWorkletNode
//      (outputChannelCount: [0]) -> NotSupportedError, and the player shows
//      16-bit / 0:00 / "No audio loaded".
//
// The guard below runs before the bundle and does not require rebuilding it
// (see installWorkerFlacDecodeGuard for the decode order):
//   - strips an ID3v2 prefix;
//   - rewrites STREAMINFO-coded frame headers to explicit codes (recomputing
//     the header CRC-8 and frame CRC-16) so the WASM decoder can sync;
//   - falls back between the WASM decoder and the browser's own decoder
//     (OfflineAudioContext.decodeAudioData at the STREAMINFO rate);
//   - turns a decode nothing could recover into a worker error, so the player
//     reports it instead of building a 0-channel node;
//   - fills duration / bit depth from STREAMINFO;
//   - clamps AudioWorkletNode output channel counts to >= 1.

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // fLaC

/**
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isFlacMagic(buffer) {
    if (!buffer || buffer.byteLength < 4) {
        return false;
    }
    const bytes = new Uint8Array(buffer, 0, 4);
    return FLAC_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Strip a leading ID3v2 tag so the WASM FLAC decoder sees `fLaC`.
 * @param {ArrayBuffer} buffer
 * @returns {ArrayBuffer}
 */
export function stripId3Prefix(buffer) {
    if (!buffer || buffer.byteLength < 10) {
        return buffer;
    }
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
        return buffer;
    }
    const size = ((bytes[6] & 0x7f) << 21)
        | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7)
        | (bytes[9] & 0x7f);
    const start = 10 + size;
    if (start <= 10 || start >= bytes.length) {
        return buffer;
    }
    return buffer.slice(start);
}

/**
 * @typedef {object} FlacStreamInfo
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {number} totalSamples Samples per channel; 0 when unknown.
 * @property {number} duration Seconds; 0 when unknown.
 * @property {number} audioOffset Byte offset of the first audio frame.
 */

/**
 * Read STREAMINFO and locate the first audio frame of a native FLAC stream.
 * @param {ArrayBuffer} buffer
 * @returns {FlacStreamInfo | null}
 */
export function parseFlacStreamInfo(buffer) {
    if (!isFlacMagic(buffer)) {
        return null;
    }
    const bytes = new Uint8Array(buffer);
    let pos = 4;
    /** @type {Omit<FlacStreamInfo, 'audioOffset'> | null} */
    let info = null;
    for (;;) {
        if (pos + 4 > bytes.length) {
            return null;
        }
        const isLast = (bytes[pos] & 0x80) !== 0;
        const type = bytes[pos] & 0x7f;
        const length = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        const body = pos + 4;
        if (type === 0 && length >= 18 && body + 18 <= bytes.length) {
            const sampleRate = (bytes[body + 10] << 12) | (bytes[body + 11] << 4) | (bytes[body + 12] >> 4);
            const channels = ((bytes[body + 12] >> 1) & 0x07) + 1;
            const bitsPerSample = (((bytes[body + 12] & 0x01) << 4) | (bytes[body + 13] >> 4)) + 1;
            const totalSamples = (bytes[body + 13] & 0x0f) * 2 ** 32
                + ((bytes[body + 14] << 24) >>> 0)
                + ((bytes[body + 15] << 16) | (bytes[body + 16] << 8) | bytes[body + 17]);
            info = {
                sampleRate,
                channels,
                bitsPerSample,
                totalSamples,
                duration: sampleRate > 0 ? totalSamples / sampleRate : 0,
            };
        }
        pos = body + length;
        if (isLast) {
            break;
        }
    }
    if (!info || info.sampleRate === 0) {
        return null;
    }
    return { ...info, audioOffset: pos };
}

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    let c8 = i;
    let c16 = i << 8;
    for (let bit = 0; bit < 8; bit++) {
        c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
        c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
    }
    CRC8_TABLE[i] = c8;
    CRC16_TABLE[i] = c16;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function crc8(bytes, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc = CRC8_TABLE[crc ^ bytes[i]];
    }
    return crc;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function crc16(bytes, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[(crc >> 8) ^ bytes[i]];
    }
    return crc;
}

/**
 * Multiply two polynomials over GF(2) modulo the CRC-16 polynomial (0x8005).
 * @param {number} a
 * @param {number} b
 */
function crc16MulMod(a, b) {
    let result = 0;
    for (let bit = 15; bit >= 0; bit--) {
        result = result & 0x8000 ? ((result << 1) ^ 0x8005) & 0xffff : (result << 1) & 0xffff;
        if (b & (1 << bit)) {
            result ^= a;
        }
    }
    return result;
}

/**
 * x^(8n) mod P: what appending n zero bytes does to a CRC-16.
 * @param {number} n
 */
function crc16ZeroBytesFactor(n) {
    let result = 1;
    let base = 0x0100; // x^8
    for (let k = n; k > 0; k = Math.floor(k / 2)) {
        if (k % 2) {
            result = crc16MulMod(result, base);
        }
        base = crc16MulMod(base, base);
    }
    return result;
}

/**
 * @typedef {object} FlacFrameHeader
 * @property {number} length Header bytes, excluding the CRC-8 byte.
 * @property {boolean} variable Variable blocking strategy (number = sample number).
 * @property {number} number Frame number (fixed) or first sample number (variable).
 * @property {number} blockSize Samples per channel in the frame.
 */

/**
 * Parse the frame header at `pos`; null unless it is structurally valid and
 * its CRC-8 matches.
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @returns {FlacFrameHeader | null}
 */
export function parseFlacFrameHeader(bytes, pos) {
    if (pos + 6 > bytes.length || bytes[pos] !== 0xff || (bytes[pos + 1] & 0xfe) !== 0xf8) {
        return null;
    }
    const blockSizeCode = bytes[pos + 2] >> 4;
    const sampleRateCode = bytes[pos + 2] & 0x0f;
    if (blockSizeCode === 0 || sampleRateCode === 0x0f || (bytes[pos + 3] & 0x01) !== 0
        || (bytes[pos + 3] >> 4) > 10) {
        return null;
    }
    let length = 4;
    const first = bytes[pos + 4];
    let number = first;
    if (first >= 0x80) {
        let extra = 0;
        while (extra < 7 && first & (0x40 >> extra)) {
            extra++;
        }
        if (extra === 0 || extra > 6 || pos + 5 + extra > bytes.length) {
            return null;
        }
        number = first & (0x3f >> extra);
        for (let k = 1; k <= extra; k++) {
            const byte = bytes[pos + 4 + k];
            if ((byte & 0xc0) !== 0x80) {
                return null;
            }
            number = number * 64 + (byte & 0x3f);
        }
        length += extra;
    }
    length += 1;
    let blockSize;
    if (blockSizeCode === 1) {
        blockSize = 192;
    } else if (blockSizeCode <= 5) {
        blockSize = 576 << (blockSizeCode - 2);
    } else if (blockSizeCode === 6) {
        blockSize = bytes[pos + length] + 1;
        length += 1;
    } else if (blockSizeCode === 7) {
        blockSize = ((bytes[pos + length] << 8) | bytes[pos + length + 1]) + 1;
        length += 2;
    } else {
        blockSize = 256 << (blockSizeCode - 8);
    }
    if (sampleRateCode === 12) {
        length += 1;
    } else if (sampleRateCode === 13 || sampleRateCode === 14) {
        length += 2;
    }
    if (pos + length + 1 > bytes.length || crc8(bytes, pos, pos + length) !== bytes[pos + length]) {
        return null;
    }
    return { length, variable: (bytes[pos + 1] & 0x01) === 1, number, blockSize };
}

/** @type {Record<number, number>} */
const SAMPLE_RATE_CODES = {
    88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6,
    24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11,
};
/** Sample-size codes (already shifted into bits 3..1 of header byte 3). */
/** @type {Record<number, number>} */
const SAMPLE_SIZE_CODES = { 8: 0x02, 12: 0x04, 16: 0x08, 20: 0x0a, 24: 0x0c };

/**
 * End of the last frame: the end of the buffer, or the start of a trailing
 * ID3v1 tag, whichever closes a frame with a valid CRC-16. -1 when neither.
 * @param {Uint8Array} bytes
 * @param {number} start
 */
function findLastFrameEnd(bytes, start) {
    const candidates = [bytes.length];
    const tag = bytes.length - 128;
    if (tag > start && bytes[tag] === 0x54 && bytes[tag + 1] === 0x41 && bytes[tag + 2] === 0x47) {
        candidates.push(tag);
    }
    for (const end of candidates) {
        if (crc16(bytes, start, end) === 0) {
            return end;
        }
    }
    return -1;
}

/**
 * Rewrite frame headers that take sample rate / sample size from STREAMINFO
 * (codes 0000 / 000) to the explicit codes, which codec-parser — and so
 * @wasm-audio-decoders/flac — requires. Header lengths do not change, so
 * frames are patched IN PLACE: the caller's buffer is modified (copying an
 * 80 MB file alone costs ~250 ms). The result is still a valid FLAC stream
 * (bit-identical audio), so the Web Audio fallback can decode it as well.
 *
 * Frames are walked by sync code + header CRC-8 + frame-number continuity
 * (audio bytes that merely look like a header carry the wrong number), using
 * native indexOf rather than a byte-at-a-time CRC pass: this runs on the main
 * thread over files of 80 MB and more. Each frame's CRC-16 is then updated
 * from the stored one: CRC-16 is linear, so new = old ^ CRC(header delta
 * followed by the rest of the frame as zeros).
 *
 * Returns the input unchanged when nothing needs rewriting, when the stream
 * format has no explicit code (e.g. 37.8 kHz, 32-bit), or when the frames
 * cannot be walked; the Web Audio fallback covers those.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ buffer: ArrayBuffer, framesRewritten: number }}
 */
export function normalizeFlacFrameHeaders(buffer) {
    const unchanged = { buffer, framesRewritten: 0 };
    const info = parseFlacStreamInfo(buffer);
    if (!info) {
        return unchanged;
    }
    const src = new Uint8Array(buffer);
    let header = parseFlacFrameHeader(src, info.audioOffset);
    if (!header
        || ((src[info.audioOffset + 2] & 0x0f) !== 0 && (src[info.audioOffset + 3] & 0x0e) !== 0)) {
        return unchanged;
    }
    const rateCode = SAMPLE_RATE_CODES[info.sampleRate];
    const sizeCode = SAMPLE_SIZE_CODES[info.bitsPerSample];
    if (!rateCode || !sizeCode) {
        return unchanged;
    }

    /** @type {Array<[number, number, number]>} [start, end, headerLength] */
    const frames = [];
    let start = info.audioOffset;
    while (header) {
        const current = header;
        const expected = current.variable ? current.number + current.blockSize : current.number + 1;
        let end = -1;
        /** @type {FlacFrameHeader | null} */
        let next = null;
        for (let pos = src.indexOf(0xff, start + current.length + 3); pos !== -1; pos = src.indexOf(0xff, pos + 1)) {
            const candidate = parseFlacFrameHeader(src, pos);
            if (candidate && candidate.number === expected && candidate.variable === current.variable) {
                end = pos;
                next = candidate;
                break;
            }
        }
        if (end < 0) {
            end = findLastFrameEnd(src, start);
        }
        if (end < 0) {
            break; // truncated last frame: leave it as it is
        }
        frames.push([start, end, current.length]);
        start = end;
        header = next;
    }

    const out = src;
    const delta = new Uint8Array(32);
    let framesRewritten = 0;
    for (const [frameStart, frameEnd, length] of frames) {
        const byte2 = out[frameStart + 2];
        const byte3 = out[frameStart + 3];
        if ((byte2 & 0x0f) === 0) {
            out[frameStart + 2] = byte2 | rateCode;
        }
        if ((byte3 & 0x0e) === 0) {
            out[frameStart + 3] = byte3 | sizeCode;
        }
        if (out[frameStart + 2] === byte2 && out[frameStart + 3] === byte3) {
            continue;
        }
        const oldCrc8 = out[frameStart + length];
        out[frameStart + length] = crc8(out, frameStart, frameStart + length);
        delta.fill(0);
        delta[2] = byte2 ^ out[frameStart + 2];
        delta[3] = byte3 ^ out[frameStart + 3];
        delta[length] = oldCrc8 ^ out[frameStart + length];
        const zeroBytes = frameEnd - 2 - (frameStart + length + 1);
        const crcDelta = crc16MulMod(crc16(delta, 0, length + 1), crc16ZeroBytesFactor(zeroBytes));
        const frameCrc = ((out[frameEnd - 2] << 8) | out[frameEnd - 1]) ^ crcDelta;
        out[frameEnd - 2] = frameCrc >> 8;
        out[frameEnd - 1] = frameCrc & 0xff;
        framesRewritten++;
    }
    return { buffer, framesRewritten };
}

/**
 * Everything the guard does to a buffer before it reaches the WASM decoder.
 * May modify `buffer` in place (see {@link normalizeFlacFrameHeaders}).
 * @param {ArrayBuffer} buffer
 * @returns {ArrayBuffer}
 */
export function prepareFlacForDecode(buffer) {
    const stripped = stripId3Prefix(buffer);
    return normalizeFlacFrameHeaders(stripped).buffer;
}

/**
 * @param {unknown} count
 * @param {number} [fallback=2]
 */
export function clampAudioChannelCount(count, fallback = 2) {
    const value = Number(count);
    if (!Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.min(32, Math.floor(value));
}

/**
 * Shape the bundle's worker (bundle.4f00c4158ff714867bc6.js) replies to
 * `decode` with, as `{ id, type: 'decoded', result }`. It drops the
 * decoder's `errors` array: frames that fail just go missing, which
 * {@link decodeShortfall} detects against STREAMINFO.
 * @typedef {object} FlacDecodeResult
 * @property {number} sampleRate
 * @property {number} channels
 * @property {Float32Array} interleavedBuffer
 * @property {number} duration
 * @property {number} [bitDepth] Set by the bundle's worker.
 * @property {number} [bitsPerSample]
 * @property {number} [samplesDecoded]
 * @property {unknown[]} [errors]
 */

/**
 * True when a worker decode result carries no playable audio.
 * @param {any} result
 */
export function isEmptyDecodeResult(result) {
    return !result
        || !(Number(result.channels) >= 1)
        || !(Number(result.sampleRate) > 0)
        || !result.interleavedBuffer
        || !(result.interleavedBuffer.length > 0);
}

/**
 * Samples per channel the decoder lost against STREAMINFO's total (0 when the
 * total is unknown or everything decoded).
 * @param {FlacDecodeResult} result
 * @param {FlacStreamInfo | null} info
 */
export function decodeShortfall(result, info) {
    if (!info || !(info.totalSamples > 0) || !(result.channels >= 1)) {
        return 0;
    }
    const frames = Math.floor(result.interleavedBuffer.length / result.channels);
    return Math.max(0, info.totalSamples - frames);
}

/**
 * @param {{ numberOfChannels: number, length: number, sampleRate: number, getChannelData(channel: number): Float32Array }} audioBuffer
 * @param {FlacStreamInfo | null} [info]
 * @returns {FlacDecodeResult}
 */
export function audioBufferToDecodeResult(audioBuffer, info) {
    const channels = audioBuffer.numberOfChannels;
    const frames = audioBuffer.length;
    const interleavedBuffer = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) {
            interleavedBuffer[i * channels + channel] = data[i];
        }
    }
    const bitDepth = info?.bitsPerSample ?? 16;
    return {
        sampleRate: audioBuffer.sampleRate,
        channels,
        interleavedBuffer,
        duration: frames / audioBuffer.sampleRate,
        bitDepth,
        bitsPerSample: bitDepth,
        samplesDecoded: frames,
    };
}

/**
 * Decode with the browser's native decoder. An OfflineAudioContext at the
 * STREAMINFO rate keeps decodeAudioData from resampling.
 * @param {ArrayBuffer} buffer
 * @param {any} [windowRef]
 * @returns {Promise<FlacDecodeResult>}
 */
export async function decodeWithWebAudio(buffer, windowRef = globalThis) {
    const Ctx = windowRef.OfflineAudioContext || windowRef.webkitOfflineAudioContext;
    if (typeof Ctx !== 'function') {
        throw new Error('OfflineAudioContext unavailable');
    }
    const info = parseFlacStreamInfo(buffer);
    const context = new Ctx(clampAudioChannelCount(info?.channels), 1, info?.sampleRate || 44100);
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    return audioBufferToDecodeResult(audioBuffer, info);
}

/**
 * Fill duration / bitsPerSample from STREAMINFO where the decoder left them
 * out (the player otherwise shows 16-bit and 0:00).
 * @param {FlacDecodeResult} result
 * @param {FlacStreamInfo | null} info
 */
function withStreamInfo(result, info) {
    if (!info) {
        return result;
    }
    const next = { ...result };
    if (!(Number(next.bitDepth) > 0)) {
        next.bitDepth = info.bitsPerSample;
    }
    if (!(Number(next.bitsPerSample) > 0)) {
        next.bitsPerSample = next.bitDepth;
    }
    if (!(Number(next.duration) > 0) && info.duration > 0) {
        next.duration = info.duration;
    }
    return next;
}

export function installAudioWorkletChannelGuard(windowRef = globalThis) {
    const Original = windowRef.AudioWorkletNode;
    if (typeof Original !== 'function' || Original.__projectMChannelGuard) {
        return () => {};
    }

    /**
     * @param {unknown} context
     * @param {string} name
     * @param {any} [options]
     */
    function GuardedAudioWorkletNode(context, name, options) {
        const nextOptions = options ? { ...options } : options;
        if (nextOptions && Array.isArray(nextOptions.outputChannelCount)) {
            nextOptions.outputChannelCount = nextOptions.outputChannelCount.map(
                (/** @type {unknown} */ count) => clampAudioChannelCount(count)
            );
        }
        return new Original(context, name, nextOptions);
    }

    GuardedAudioWorkletNode.prototype = Original.prototype;
    GuardedAudioWorkletNode.__projectMChannelGuard = true;
    windowRef.AudioWorkletNode = GuardedAudioWorkletNode;

    return () => {
        if (windowRef.AudioWorkletNode === GuardedAudioWorkletNode) {
            windowRef.AudioWorkletNode = Original;
        }
    };
}

/**
 * @typedef {object} WorkerDecodeGuardOptions
 * @property {(buffer: ArrayBuffer) => Promise<FlacDecodeResult>} [nativeDecode]
 *   The browser's own decoder. Defaults to {@link decodeWithWebAudio} when
 *   `windowRef` has an OfflineAudioContext.
 * @property {(message: string, detail?: unknown) => void} [log]
 */

/**
 * @typedef {object} PendingDecode
 * @property {ArrayBuffer} buffer What the worker was sent.
 * @property {boolean} nativeTried The native decoder already failed on it.
 */

/**
 * Replace `windowRef.Worker` with a subclass that guards the bundle's
 * `decode` requests:
 *
 *   - ID3v2 prefixes are stripped and STREAMINFO-coded frame headers are
 *     rewritten (see {@link normalizeFlacFrameHeaders}).
 *   - Ordinary streams go to the WASM worker first. An error, an empty
 *     result, or missing samples (the worker drops the decoder's error list,
 *     so failed frames just vanish) fall back to the native decoder.
 *   - Streams that needed their headers rewritten go to the native decoder
 *     first: the WASM decoder mishandles that encoder's output beyond the
 *     headers too (e.g. 16 of 3581 frames of "Claws of the Angel" still fail
 *     with LOST_SYNC after the rewrite), and each failure is logged from
 *     inside the worker. The rewritten stream is the fallback, which is also
 *     the only path where there is no native decoder (Node).
 *   - A decode nothing could recover becomes an `error` reply, so the player
 *     reports it instead of building a 0-channel AudioWorkletNode.
 *
 * @param {any} [windowRef]
 * @param {WorkerDecodeGuardOptions} [options]
 */
export function installWorkerFlacDecodeGuard(windowRef = globalThis, options = {}) {
    const WorkerCtor = windowRef.Worker;
    if (typeof WorkerCtor !== 'function' || WorkerCtor.__projectMFlacGuard) {
        return () => {};
    }
    const nativeDecode = options.nativeDecode
        || (typeof (windowRef.OfflineAudioContext || windowRef.webkitOfflineAudioContext) === 'function'
            ? (/** @type {ArrayBuffer} */ buffer) => decodeWithWebAudio(buffer, windowRef)
            : null);
    const log = options.log || ((message, detail) => console.warn(`[projectM FLAC player] ${message}`, detail ?? ''));

    /**
     * @param {ArrayBuffer} buffer
     * @returns {Promise<FlacDecodeResult>}
     */
    async function decodeNatively(buffer) {
        if (!nativeDecode) {
            throw new Error('no native decoder (OfflineAudioContext unavailable)');
        }
        const result = await nativeDecode(buffer);
        if (isEmptyDecodeResult(result)) {
            throw new Error('native decoder produced no audio');
        }
        return result;
    }

    /**
     * Turn the worker's reply to a guarded `decode` into the reply the
     * bundle sees.
     * @param {PendingDecode} pending
     * @param {any} data
     */
    async function recover({ buffer, nativeTried }, data) {
        const info = parseFlacStreamInfo(buffer);
        const wasmResult = data.type === 'error' ? null : data.result;
        const usable = Boolean(wasmResult) && !isEmptyDecodeResult(wasmResult);
        const errorCount = usable && Array.isArray(wasmResult.errors) ? wasmResult.errors.length : 0;
        const shortfall = usable ? decodeShortfall(wasmResult, info) : 0;
        if (usable && errorCount === 0 && shortfall === 0) {
            return { ...data, result: withStreamInfo(wasmResult, info) };
        }
        let reason = 'decoder produced no audio';
        if (data.type === 'error') {
            reason = `worker error: ${data.error}`;
        } else if (errorCount > 0) {
            reason = `${errorCount} decoder error(s)`;
        } else if (usable) {
            reason = `${shortfall} of ${info?.totalSamples} samples missing`;
        }
        /** @type {unknown} */
        let nativeError = new Error('native decoder already failed');
        if (!nativeTried) {
            try {
                log(`WASM FLAC decode failed (${reason}); falling back to Web Audio decodeAudioData`);
                const result = await decodeNatively(buffer);
                return { ...data, type: data.type === 'error' ? 'decoded' : data.type, result: withStreamInfo(result, info) };
            } catch (error) {
                log('native FLAC decode failed', error);
                nativeError = error;
            }
        }
        if (usable) {
            return { ...data, result: withStreamInfo(wasmResult, info) };
        }
        const message = /** @type {any} */ (nativeError)?.message || String(nativeError);
        return {
            id: data.id,
            type: 'error',
            error: `FLAC decode failed: ${reason}; native decoder: ${message}`,
        };
    }

    class GuardedWorker extends WorkerCtor {
        /** @param {any[]} args */
        constructor(...args) {
            super(...args);
            /** @type {Map<unknown, PendingDecode>} */
            this.__projectMDecodes = new Map();
            /** @type {((event: any) => void) | null} */
            this.__projectMOnMessage = null;
        }

        get onmessage() {
            return this.__projectMOnMessage;
        }

        set onmessage(handler) {
            this.__projectMOnMessage = handler;
            if (typeof handler !== 'function') {
                super.onmessage = handler;
                return;
            }
            super.onmessage = (/** @type {any} */ event) => {
                const data = event?.data;
                const pending = data ? this.__projectMDecodes.get(data.id) : undefined;
                if (!pending) {
                    handler.call(this, event);
                    return;
                }
                this.__projectMDecodes.delete(data.id);
                recover(pending, data).then((next) => this.__projectMReply(next));
            };
        }

        /** @param {any} data */
        __projectMReply(data) {
            this.__projectMOnMessage?.call(this, { data, target: this });
        }

        /**
         * @param {any} message
         * @param {any} [transfer]
         */
        postMessage(message, transfer) {
            if (!(message && message.type === 'decode' && message.data?.arrayBuffer)) {
                return super.postMessage(message, transfer);
            }
            const buffer = stripId3Prefix(message.data.arrayBuffer);
            const { framesRewritten } = normalizeFlacFrameHeaders(buffer);
            /** @param {boolean} nativeTried */
            const toWorker = (nativeTried) => {
                // Keep our own reference for the fallback: post a structured
                // clone instead of transferring it to the worker.
                this.__projectMDecodes.set(message.id, { buffer, nativeTried });
                super.postMessage({ ...message, data: { ...message.data, arrayBuffer: buffer } });
            };
            if (framesRewritten === 0 || !nativeDecode) {
                toWorker(false);
                return undefined;
            }
            log(`${framesRewritten} FLAC frame headers take rate/size from STREAMINFO; decoding with Web Audio first`);
            const info = parseFlacStreamInfo(buffer);
            decodeNatively(buffer).then(
                (result) => this.__projectMReply({ id: message.id, type: 'decoded', result: withStreamInfo(result, info) }),
                (error) => {
                    log('native FLAC decode failed; trying the WASM decoder with rewritten headers', error);
                    toWorker(true);
                }
            );
            return undefined;
        }
    }
    Object.defineProperty(GuardedWorker, '__projectMFlacGuard', { value: true });
    windowRef.Worker = GuardedWorker;

    return () => {
        if (windowRef.Worker === GuardedWorker) {
            windowRef.Worker = WorkerCtor;
        }
    };
}

/**
 * @param {any} [windowRef]
 * @param {WorkerDecodeGuardOptions} [options]
 */
export function installFlacPlayerDecodeGuard(windowRef = globalThis, options = {}) {
    const undoWorklet = installAudioWorkletChannelGuard(windowRef);
    const undoWorker = installWorkerFlacDecodeGuard(windowRef, options);
    return () => {
        undoWorker();
        undoWorklet();
    };
}
