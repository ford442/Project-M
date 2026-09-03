// Unit tests for html/projectm-pcm-ring.js — the single PCM ingest path.
//
// The real ring lives in the WASM heap (src/wasm/WasmPcmRing.cpp). These tests
// stand a fake module in front of the same descriptor contract: an ArrayBuffer
// playing the part of the heap, with a header at one offset and interleaved
// float storage at another. That is enough to pin the parts of the contract
// both sides depend on — stereo interleaving, mono duplication, wraparound, the
// wrapping write index, and the Atomics publish.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPcmRingWriter,
    feedPcmThroughRing,
    getPcmRingWriter,
    installHostPcmRingWriter,
    moduleHasPcmRing,
    readPcmRingDescriptor,
} from '../../html/projectm-pcm-ring.js';

// Non-zero, like the real thing: these are offsets into the WASM heap, and the
// descriptor reader treats a zero pointer as "not allocated yet".
const HEADER_PTR = 16;
const DATA_PTR = 32;

/**
 * A module exposing the PCM ring exports over a fake heap.
 *
 * @param {object} [options]
 * @param {number} [options.capacityFrames]
 */
function fakeRingModule({ capacityFrames = 4 } = {}) {
    const memory = new ArrayBuffer(DATA_PTR + capacityFrames * 2 * 4);
    const module = {
        HEAPF32: new Float32Array(memory),
        _get_pcm_ring_header_ptr: () => HEADER_PTR,
        _get_pcm_ring_data_ptr: () => DATA_PTR,
        _get_pcm_ring_capacity_frames: () => capacityFrames,
        _get_pcm_ring_index_modulus: () => capacityFrames * 1024,
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, capacityFrames * 2),
        memory,
    };
    return module;
}

function descriptorFor(module) {
    return {
        memory: module.memory,
        headerPtr: HEADER_PTR,
        dataPtr: DATA_PTR,
        capacityFrames: module._get_pcm_ring_capacity_frames(),
        indexModulus: module._get_pcm_ring_index_modulus(),
    };
}

test('moduleHasPcmRing feature-detects every export the writer needs', () => {
    assert.equal(moduleHasPcmRing(null), false);
    assert.equal(moduleHasPcmRing({}), false);
    assert.equal(moduleHasPcmRing(fakeRingModule()), true);

    const partial = fakeRingModule();
    delete partial._get_pcm_ring_index_modulus;
    assert.equal(moduleHasPcmRing(partial), false, 'a module missing one export is not usable');
});

test('readPcmRingDescriptor allocates the ring when the engine has not yet', () => {
    let initCalls = 0;
    let allocated = false;
    const module = fakeRingModule();
    module._get_pcm_ring_data_ptr = () => (allocated ? DATA_PTR : 0);
    module._pcm_ring_init = () => {
        initCalls += 1;
        allocated = true;
        return 1;
    };

    const descriptor = readPcmRingDescriptor(module);
    assert.equal(initCalls, 1);
    assert.equal(descriptor.dataPtr, DATA_PTR);
});

test('readPcmRingDescriptor returns null when the ring cannot be allocated', () => {
    const module = fakeRingModule();
    module._get_pcm_ring_data_ptr = () => 0;
    assert.equal(readPcmRingDescriptor(module), null);
});

test('write duplicates mono to both channels and publishes the index with Atomics', () => {
    const module = fakeRingModule({ capacityFrames: 8 });
    const writer = createPcmRingWriter(descriptorFor(module));

    assert.equal(writer.write(new Float32Array([1, 2, 3]), 1), 3);
    assert.equal(Atomics.load(module.header, 0), 3);
    assert.deepEqual(Array.from(module.data.subarray(0, 6)), [1, 1, 2, 2, 3, 3]);
});

test('write keeps stereo separation: a hard-panned signal stays asymmetric', () => {
    // The old ingest called projectm_pcm_add_float(..., channels=1), so a signal
    // panned entirely to one side reached the engine as an average of both. The
    // ring is stereo end to end, so what goes in is what comes out.
    const module = fakeRingModule({ capacityFrames: 4 });
    const writer = createPcmRingWriter(descriptorFor(module));

    // Interleaved: left carries the tone, right is silent. Values are exact in
    // float32 so the round trip through the heap compares cleanly.
    writer.write(new Float32Array([0.75, 0, -0.75, 0, 0.75, 0]), 2);

    const left = [module.data[0], module.data[2], module.data[4]];
    const right = [module.data[1], module.data[3], module.data[5]];
    assert.deepEqual(left, [0.75, -0.75, 0.75]);
    assert.deepEqual(right, [0, 0, 0]);
    assert.notDeepEqual(left, right, 'the channels must not be collapsed into each other');
});

test('write wraps around the end of the ring', () => {
    const module = fakeRingModule({ capacityFrames: 4 });
    const writer = createPcmRingWriter(descriptorFor(module));

    writer.write(new Float32Array([1, 1, 2, 2, 3, 3]), 2); // frames 0..2
    assert.equal(writer.writeIndex(), 3);

    // Frames 3,4,5: one slot free before the wrap, so this splits across the end
    // and start, overwriting the two oldest frames and leaving frame 2 alone.
    writer.write(new Float32Array([4, 4, 5, 5, 6, 6]), 2);
    assert.equal(writer.writeIndex(), 6);
    assert.deepEqual(Array.from(module.data), [5, 5, 6, 6, 3, 3, 4, 4]);
});

test('a write larger than the ring keeps only the newest frames', () => {
    const module = fakeRingModule({ capacityFrames: 2 });
    const writer = createPcmRingWriter(descriptorFor(module));

    // Five mono frames into a two-frame ring: only the last two can survive, and
    // dropping the excess up front is what stops the write clobbering its own
    // output as it laps.
    assert.equal(writer.write(new Float32Array([1, 2, 3, 4, 5]), 1), 2);
    assert.equal(writer.writeIndex(), 2);
    assert.deepEqual(Array.from(module.data), [4, 4, 5, 5]);
});

test('the write index wraps at the modulus instead of growing without bound', () => {
    const capacityFrames = 4;
    const module = fakeRingModule({ capacityFrames });
    const descriptor = descriptorFor(module);
    const writer = createPcmRingWriter(descriptor);

    // Start one frame short of the modulus, which is a multiple of the capacity,
    // so wrapping must not disturb which slot the next frame lands in.
    Atomics.store(module.header, 0, descriptor.indexModulus - 1);
    writer.write(new Float32Array([7, 8]), 1);

    assert.equal(writer.writeIndex(), 1, 'index wraps through zero');
    const slotBeforeWrap = ((descriptor.indexModulus - 1) % capacityFrames) * 2;
    assert.equal(module.data[slotBeforeWrap], 7);
    assert.equal(module.data[0], 8, 'the frame after the wrap lands in slot 0');
});

test('getPcmRingWriter caches per module and re-derives after the heap grows', () => {
    const module = fakeRingModule();
    const first = getPcmRingWriter(module);
    assert.equal(getPcmRingWriter(module), first, 'same module, same writer');

    // Memory growth replaces HEAPF32 with a view over a new buffer, which
    // detaches the old views — the writer must be rebuilt, not reused.
    const grown = fakeRingModule();
    module.HEAPF32 = grown.HEAPF32;
    module.memory = grown.memory;
    const second = getPcmRingWriter(module);
    assert.notEqual(second, first);

    second.write(new Float32Array([1]), 1);
    assert.equal(Atomics.load(grown.header, 0), 1, 'writes land in the new heap');
});

test('feedPcmThroughRing prefers the ring and falls back only without one', () => {
    const module = fakeRingModule();
    let fallbackCalls = 0;
    const fed = feedPcmThroughRing(module, new Float32Array([0.25]), {
        channels: 1,
        fallback: () => { fallbackCalls += 1; return true; },
    });
    assert.equal(fed, true);
    assert.equal(fallbackCalls, 0, 'the ring is used when the module has one');
    assert.equal(module.data[0], 0.25);

    const ringless = { HEAPF32: new Float32Array(4) };
    assert.equal(
        feedPcmThroughRing(ringless, new Float32Array([1]), {
            channels: 1,
            fallback: () => { fallbackCalls += 1; return true; },
        }),
        true
    );
    assert.equal(fallbackCalls, 1);

    assert.equal(
        feedPcmThroughRing(ringless, new Float32Array([1]), { channels: 1 }),
        false,
        'no ring and no fallback means the audio did not reach the engine'
    );
});

test('installHostPcmRingWriter exposes the writer the baked EM_JS handler prefers', () => {
    const module = fakeRingModule();
    try {
        assert.equal(installHostPcmRingWriter({}), false, 'nothing installed without a ring');
        assert.equal(typeof globalThis.projectMWritePcmRing, 'undefined');

        assert.equal(installHostPcmRingWriter(module), true);
        globalThis.projectMWritePcmRing(new Float32Array([0.5, -0.5]), 2);
        assert.equal(Atomics.load(module.header, 0), 1);
        assert.deepEqual(Array.from(module.data.subarray(0, 2)), [0.5, -0.5]);
    } finally {
        delete globalThis.projectMWritePcmRing;
    }
});

test('empty and zero-frame writes are no-ops', () => {
    const module = fakeRingModule();
    const writer = createPcmRingWriter(descriptorFor(module));
    assert.equal(writer.write(new Float32Array(0), 2), 0);
    assert.equal(writer.write(new Float32Array([1]), 2), 0, 'one sample is not a stereo frame');
    assert.equal(Atomics.load(module.header, 0), 0);
});
