// Unit tests for html/worklets/projectm-audio-processor.js, the AudioWorklet
// processor that writes every render quantum into each engine's PCM ring.
//
// The processor is a classic AudioWorkletGlobalScope script: it extends the
// global AudioWorkletProcessor and calls the global registerProcessor(), and
// Node cannot import it. `node:vm` can run it, as the render-worker tests do:
// the context supplies those two globals, and `registerProcessor` hands the
// class back to the test. The port is a recorder with a hand-driven onmessage.
//
// What these pin is the ring hand-off with the engine (src/wasm/WasmAudioBridge.cpp,
// src/wasm/WasmPcmRing.cpp): one ring per host handle, every quantum written into
// each, and the pcmRingDetach / pcmRingDetached handshake that lets the engine
// reuse a released ring only once this side holds no view of it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PROCESSOR_PATH = fileURLToPath(new URL('../../html/worklets/projectm-audio-processor.js', import.meta.url));
const PROCESSOR_SOURCE = readFileSync(PROCESSOR_PATH, 'utf8');

/** Evaluates the processor script and returns a new processor instance. */
function newProcessor() {
    /** @type {Array<unknown>} */
    const posted = [];
    class AudioWorkletProcessor {
        constructor() {
            this.port = {
                /** @type {((event: { data: unknown }) => void) | null} */
                onmessage: null,
                postMessage: (/** @type {Record<string, unknown>} */ message) => posted.push({ ...message }),
            };
        }
    }
    /** @type {any} */
    let registered = null;
    const sandbox = {
        AudioWorkletProcessor,
        registerProcessor: (/** @type {string} */ _name, /** @type {any} */ cls) => { registered = cls; },
        console: { log() {}, warn() {}, error() {} },
        Atomics,
        Int32Array,
        Float32Array,
        SharedArrayBuffer,
    };
    vm.createContext(sandbox);
    vm.runInContext(PROCESSOR_SOURCE, sandbox, { filename: PROCESSOR_PATH });
    assert.ok(registered, 'the script registers its processor');
    const processor = new registered();
    return {
        processor,
        posted,
        /** @param {unknown} data */
        send: (data) => processor.port.onmessage({ data }),
    };
}

const HEADER_PTR = 16;
const DATA_PTR = 32;

/** A shared heap with one ring at the fixed offsets above. */
function ringMemory(capacityFrames = 8) {
    const memory = new SharedArrayBuffer(DATA_PTR + capacityFrames * 2 * 4 + 64);
    return {
        memory,
        header: new Int32Array(memory, HEADER_PTR, 4),
        data: new Float32Array(memory, DATA_PTR, capacityFrames * 2),
        descriptor: { type: 'pcmRing', memory, headerPtr: HEADER_PTR, dataPtr: DATA_PTR, capacityFrames, indexModulus: capacityFrames * 1024 },
    };
}

/** Runs one quantum of `frames` stereo frames through the processor's input. */
function runQuantum(processor, left, right) {
    const output = [new Float32Array(left.length), new Float32Array(left.length)];
    processor.process([[Float32Array.from(left), Float32Array.from(right)]], [output]);
}

test('an attached ring receives every quantum, interleaved, with the write index published', () => {
    const { processor, send } = newProcessor();
    const ring = ringMemory();
    send({ ...ring.descriptor, hostHandle: 7 });

    runQuantum(processor, [0.1, 0.2], [-0.1, -0.2]);
    assert.equal(Atomics.load(ring.header, 0), 2);
    assert.deepEqual(Array.from(ring.data.subarray(0, 4)).map((v) => Math.round(v * 10) / 10), [0.1, -0.1, 0.2, -0.2]);
});

test('pcmRingDetach drops the ring and answers pcmRingDetached for the ring it names', () => {
    const { processor, posted, send } = newProcessor();
    const ring = ringMemory();
    send({ ...ring.descriptor, hostHandle: 7 });

    send({ type: 'pcmRingDetach', hostHandle: 7, headerPtr: HEADER_PTR });
    assert.deepEqual(posted, [{ type: 'pcmRingDetached', hostHandle: 7, headerPtr: HEADER_PTR }]);

    // Nothing more lands in the released ring: the engine may reuse it now.
    runQuantum(processor, [0.5], [0.5]);
    assert.equal(Atomics.load(ring.header, 0), 0);
});

test('a detach of a ring the engine has since replaced leaves the new ring attached', () => {
    const { processor, posted, send } = newProcessor();
    const ring = ringMemory();
    // The engine re-initialised host 7's ring: the attached one is at
    // HEADER_PTR, and the detach names an older allocation.
    send({ ...ring.descriptor, hostHandle: 7 });
    send({ type: 'pcmRingDetach', hostHandle: 7, headerPtr: 4096 });
    assert.deepEqual(posted, [{ type: 'pcmRingDetached', hostHandle: 7, headerPtr: 4096 }],
        'answered: this side holds no view of the ring it names');

    runQuantum(processor, [0.25], [0.25]);
    assert.equal(Atomics.load(ring.header, 0), 1, 'the current ring is still fed');
});

test('a detach from a bundle before the handshake drops the ring and posts nothing', () => {
    const { processor, posted, send } = newProcessor();
    const ring = ringMemory();
    send({ ...ring.descriptor, hostHandle: 3 });
    send({ type: 'pcmRingDetach', hostHandle: 3 });
    assert.deepEqual(posted, []);
    runQuantum(processor, [0.5], [0.5]);
    assert.equal(Atomics.load(ring.header, 0), 0);
});

test('two engines each get every quantum, and detaching one leaves the other fed', () => {
    const { processor, send } = newProcessor();
    const a = ringMemory();
    const b = ringMemory();
    send({ ...a.descriptor, hostHandle: 1 });
    send({ ...b.descriptor, hostHandle: 2 });

    runQuantum(processor, [0.5, 0.5], [0.5, 0.5]);
    assert.equal(Atomics.load(a.header, 0), 2);
    assert.equal(Atomics.load(b.header, 0), 2);

    send({ type: 'pcmRingDetach', hostHandle: 1, headerPtr: HEADER_PTR });
    runQuantum(processor, [0.5], [0.5]);
    assert.equal(Atomics.load(a.header, 0), 2, 'A released');
    assert.equal(Atomics.load(b.header, 0), 3, 'B still fed');
});
