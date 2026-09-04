import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareImages, composeStrip, evaluateComparison, meanSsim } from '../wasm-smoke/lib/image-diff.mjs';

/** A deterministic, structured test image (bands + a bright block). */
function makeImage(width, height, shift = 0) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const p = (y * width + x) * 4;
            const band = ((x + shift) % 16) < 8 ? 200 : 30;
            data[p] = band;
            data[p + 1] = (y * 4) % 256;
            data[p + 2] = ((x + shift) * 3) % 256;
            data[p + 3] = 255;
        }
    }
    return { width, height, data };
}

function offsetAll(image, delta) {
    const data = new Uint8Array(image.data);
    for (let p = 0; p < data.length; p += 4) {
        data[p] = Math.min(255, Math.max(0, data[p] + delta));
        data[p + 1] = Math.min(255, Math.max(0, data[p + 1] + delta));
        data[p + 2] = Math.min(255, Math.max(0, data[p + 2] + delta));
    }
    return { ...image, data };
}

test('identical images compare as identical', () => {
    const image = makeImage(64, 48);
    const comparison = compareImages(image, image);
    assert.equal(comparison.differingPixels, 0);
    assert.equal(comparison.maxChannelDelta, 0);
    assert.ok(comparison.ssim > 0.9999, `ssim ${comparison.ssim}`);
    assert.equal(evaluateComparison(comparison, {}).pass, true);
});

test('a one-pixel horizontal shift fails the gate', () => {
    // The acceptance case from the proposal, in miniature: a geometric change
    // that leaves the histogram almost untouched must still be caught.
    const golden = makeImage(64, 48, 0);
    const shifted = makeImage(64, 48, 1);
    const comparison = compareImages(golden, shifted);
    const verdict = evaluateComparison(comparison, { minSsim: 0.995, maxDifferingFraction: 0.002 });
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failures.length > 0);
});

test('a vertical flip fails the gate', () => {
    const golden = makeImage(32, 32);
    const flipped = { width: 32, height: 32, data: new Uint8Array(golden.data.length) };
    for (let y = 0; y < 32; y += 1) {
        const src = y * 32 * 4;
        const dst = (31 - y) * 32 * 4;
        flipped.data.set(golden.data.subarray(src, src + 32 * 4), dst);
    }
    const comparison = compareImages(golden, flipped);
    assert.equal(evaluateComparison(comparison, {}).pass, false);
});

test('a uniform low-bit shift stays inside tolerance', () => {
    // This is the driver/precision noise the gate must tolerate, or it gets
    // switched off the first time a runner image updates.
    const golden = makeImage(64, 48);
    const noisy = offsetAll(golden, 2);
    const comparison = compareImages(golden, noisy, { pixelThreshold: 8 });
    assert.equal(comparison.differingPixels, 0, 'below the per-pixel threshold');
    assert.equal(evaluateComparison(comparison, {}).pass, true);
});

test('localized damage fails even though most of the image matches', () => {
    const golden = makeImage(128, 128);
    const damaged = { ...golden, data: new Uint8Array(golden.data) };
    for (let y = 0; y < 40; y += 1) {
        for (let x = 0; x < 40; x += 1) {
            const p = (y * 128 + x) * 4;
            damaged.data[p] = 255 - damaged.data[p];
            damaged.data[p + 1] = 255 - damaged.data[p + 1];
            damaged.data[p + 2] = 255 - damaged.data[p + 2];
        }
    }
    const comparison = compareImages(golden, damaged);
    assert.ok(comparison.differingFraction > 0.002);
    assert.equal(evaluateComparison(comparison, {}).pass, false);
});

test('ssim is symmetric and bounded', () => {
    const a = makeImage(48, 48, 0);
    const b = makeImage(48, 48, 3);
    const ab = meanSsim(a, b);
    const ba = meanSsim(b, a);
    assert.ok(Math.abs(ab - ba) < 1e-12);
    assert.ok(ab <= 1 + 1e-12);
});

test('size mismatch is an error, not a silent pass', () => {
    assert.throws(() => compareImages(makeImage(8, 8), makeImage(8, 9)), /size mismatch/);
});

test('composeStrip lays images out left to right with gaps', () => {
    const a = makeImage(10, 6);
    const b = makeImage(12, 6);
    const strip = composeStrip([a, b], { gap: 4 });
    assert.equal(strip.width, 10 + 4 + 12);
    assert.equal(strip.height, 6);
    // First pixel of the second image sits after the first image plus the gap.
    const dst = (10 + 4) * 4;
    assert.equal(strip.data[dst], b.data[0]);
});
