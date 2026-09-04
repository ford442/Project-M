import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    generateDeterministicBlock, PROJECTM_ANALYSIS_WINDOW,
} from '../../html/projectm-synthetic-audio.js';

test('a block depends only on its frame index', () => {
    const first = generateDeterministicBlock(42);
    const again = generateDeterministicBlock(42);
    assert.deepEqual([...first], [...again]);
    assert.equal(first.length, PROJECTM_ANALYSIS_WINDOW);
});

test('blocks are generated out of order without drift', () => {
    // The capture pump asks for blocks in order, but the property that matters
    // is that block N does not depend on N-1 having been generated: that is what
    // removes accumulated phase — and thus run-to-run variation — from the feed.
    const inOrder = [0, 1, 2, 3].map((n) => generateDeterministicBlock(n));
    const outOfOrder = [3, 1, 0, 2].map((n) => generateDeterministicBlock(n));
    assert.deepEqual([...outOfOrder[2]], [...inOrder[0]]);
    assert.deepEqual([...outOfOrder[0]], [...inOrder[3]]);
});

test('successive blocks join without a discontinuity', () => {
    // A step at the block boundary would read as a transient to beat detection
    // and make the visuals jump every 576 samples.
    const a = generateDeterministicBlock(7);
    const b = generateDeterministicBlock(8);
    const step = Math.abs(b[0] - a[a.length - 1]);
    assert.ok(step < 0.2, `discontinuity at the block seam: ${step}`);
});

test('the signal stays in range and actually carries a beat', () => {
    let peak = 0;
    let quietest = Infinity;
    let loudest = 0;
    // 120 BPM at 44.1 kHz is a beat every ~38 blocks; scan two beats' worth.
    for (let frame = 0; frame < 96; frame += 1) {
        const block = generateDeterministicBlock(frame);
        let energy = 0;
        for (const sample of block) {
            peak = Math.max(peak, Math.abs(sample));
            energy += sample * sample;
        }
        energy = Math.sqrt(energy / block.length);
        quietest = Math.min(quietest, energy);
        loudest = Math.max(loudest, energy);
    }
    assert.ok(peak <= 1.0, `clipping: peak ${peak}`);
    assert.ok(loudest > quietest * 1.15, 'no beat-driven energy variation in the feed');
});
