/**
 * Minimal PNG reader/writer for the golden-image harness.
 *
 * Deliberately dependency-free. The harness has to run in CI on a checkout that
 * only has `playwright` installed (tests/wasm-smoke/package.json), and adding an
 * image library to compare two buffers of bytes is not worth the supply-chain
 * surface. Node's zlib does the only hard part.
 *
 * Scope: 8-bit non-interlaced truecolour, with or without alpha (PNG colour
 * types 2 and 6). That is exactly what `canvas.toDataURL('image/png')` emits,
 * which is the only producer here. Anything else throws rather than guessing —
 * a silently mis-decoded golden is worse than a failed run.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @type {number[] | null} */
let crcTable = null;

function crc32(buffer) {
    if (crcTable === null) {
        crcTable = [];
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
}

/**
 * @typedef {object} RgbaImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data Row-major RGBA, 4 bytes per pixel.
 */

/**
 * Encodes an RGBA image as a PNG.
 *
 * @param {RgbaImage} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, data }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`encodePng: bad dimensions ${width}x${height}`);
    }
    if (data.length !== width * height * 4) {
        throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${data.length}`);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: truecolour with alpha
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    // Filter type 0 (None) on every row. The harness's images are compared, not
    // shipped, so the extra few percent from adaptive filtering buys nothing and
    // costs reproducibility of the encoded bytes.
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + y * stride, stride)
            .copy(raw, y * (stride + 1) + 1);
    }

    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Decodes an 8-bit truecolour PNG into RGBA.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {RgbaImage}
 */
export function decodePng(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('decodePng: not a PNG (bad signature)');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idatParts = [];

    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const data = buffer.subarray(dataStart, dataStart + length);

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            const bitDepth = data[8];
            const colourType = data[9];
            const interlace = data[12];
            if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}`);
            if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
            if (colourType === 6) channels = 4;
            else if (colourType === 2) channels = 3;
            else throw new Error(`decodePng: unsupported colour type ${colourType}`);
        } else if (type === 'IDAT') {
            idatParts.push(Buffer.from(data));
        } else if (type === 'IEND') {
            break;
        }

        offset = dataStart + length + 4; // + CRC
    }

    if (width === 0 || height === 0 || channels === 0) {
        throw new Error('decodePng: missing or invalid IHDR');
    }
    if (idatParts.length === 0) throw new Error('decodePng: no IDAT data');

    const raw = inflateSync(Buffer.concat(idatParts));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) {
        throw new Error(`decodePng: truncated image data (${raw.length} bytes)`);
    }

    // Un-filter in place into a scanline buffer, then widen to RGBA.
    const out = new Uint8Array(width * height * 4);
    const current = Buffer.alloc(stride);
    let previous = Buffer.alloc(stride);

    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (stride + 1);
        const filter = raw[rowStart];
        raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);

        for (let i = 0; i < stride; i += 1) {
            const left = i >= channels ? current[i - channels] : 0;
            const up = previous[i];
            const upLeft = i >= channels ? previous[i - channels] : 0;
            switch (filter) {
                case 0: break;
                case 1: current[i] = (current[i] + left) & 0xff; break;
                case 2: current[i] = (current[i] + up) & 0xff; break;
                case 3: current[i] = (current[i] + ((left + up) >> 1)) & 0xff; break;
                case 4: current[i] = (current[i] + paeth(left, up, upLeft)) & 0xff; break;
                default: throw new Error(`decodePng: unknown row filter ${filter}`);
            }
        }

        for (let x = 0; x < width; x += 1) {
            const src = x * channels;
            const dst = (y * width + x) * 4;
            out[dst] = current[src];
            out[dst + 1] = current[src + 1];
            out[dst + 2] = current[src + 2];
            out[dst + 3] = channels === 4 ? current[src + 3] : 255;
        }

        previous = Buffer.from(current);
    }

    return { width, height, data: out };
}

/**
 * Decodes a `data:image/png;base64,...` URL as produced by
 * `canvas.toDataURL()`.
 *
 * @param {string} dataUrl
 * @returns {RgbaImage}
 */
export function decodePngDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
        throw new Error('decodePngDataUrl: expected a base64 image/png data URL');
    }
    return decodePng(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}
