import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decodePng, decodePngDataUrl, encodePng } from '../wasm-smoke/lib/png.mjs';

function gradient(width, height) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const p = (y * width + x) * 4;
            data[p] = (x * 7) & 0xff;
            data[p + 1] = (y * 11) & 0xff;
            data[p + 2] = (x * y) & 0xff;
            data[p + 3] = 255;
        }
    }
    return { width, height, data };
}

test('round-trips an RGBA image', () => {
    const image = gradient(37, 23);
    const decoded = decodePng(encodePng(image));
    assert.equal(decoded.width, 37);
    assert.equal(decoded.height, 23);
    assert.deepEqual([...decoded.data], [...image.data]);
});

test('encodes deterministically', () => {
    const image = gradient(16, 16);
    assert.deepEqual([...encodePng(image)], [...encodePng(image)]);
});

test('decodes a data URL as toDataURL produces it', () => {
    const image = gradient(8, 4);
    const dataUrl = 'data:image/png;base64,' + encodePng(image).toString('base64');
    assert.deepEqual([...decodePngDataUrl(dataUrl).data], [...image.data]);
});

test('rejects a non-PNG data URL rather than decoding garbage', () => {
    assert.throws(() => decodePngDataUrl('data:image/jpeg;base64,AAAA'), /image\/png/);
});

test('decodes every row filter type', () => {
    // Hand-built 4x5 RGB PNG exercising filters 0..4, one per row: the harness
    // decodes whatever Chromium emits, and Chromium picks filters adaptively.
    const width = 4;
    const height = 5;
    const channels = 3;
    const stride = width * channels;
    const pixels = new Uint8Array(stride * height);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 13 + 7) & 0xff;

    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const filter = y; // 0..4
        raw[y * (stride + 1)] = filter;
        for (let i = 0; i < stride; i += 1) {
            const value = pixels[y * stride + i];
            const left = i >= channels ? pixels[y * stride + i - channels] : 0;
            const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
            const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
            let encoded;
            switch (filter) {
                case 0: encoded = value; break;
                case 1: encoded = value - left; break;
                case 2: encoded = value - up; break;
                case 3: encoded = value - ((left + up) >> 1); break;
                default: {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
                    encoded = value - predictor;
                }
            }
            raw[y * (stride + 1) + 1 + i] = encoded & 0xff;
        }
    }

    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        let crc = 0xffffffff;
        for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        const crcBuffer = Buffer.alloc(4);
        crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
        return Buffer.concat([length, body, crcBuffer]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // truecolour, no alpha
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);

    const decoded = decodePng(png);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const src = y * stride + x * channels;
            const dst = (y * width + x) * 4;
            assert.equal(decoded.data[dst], pixels[src], `row ${y} px ${x} R`);
            assert.equal(decoded.data[dst + 1], pixels[src + 1], `row ${y} px ${x} G`);
            assert.equal(decoded.data[dst + 2], pixels[src + 2], `row ${y} px ${x} B`);
            assert.equal(decoded.data[dst + 3], 255, 'alpha filled for RGB source');
        }
    }
});

test('refuses unsupported PNG variants instead of guessing', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /signature/);
});
