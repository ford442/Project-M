// FLAC container parsing and frame-header repair for decode-guard.js:
// STREAMINFO, ID3v2 stripping, frame-header CRCs and the rewrite of
// STREAMINFO-coded frame headers to explicit codes. Split out of
// decode-guard.js, which re-exports everything here.

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
