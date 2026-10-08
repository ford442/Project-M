// Unit tests for html/projectm-pcm-hud.js: ring-index arithmetic, the rate
// meter, where ring counters come from in each topology, and the HUD wiring.
// Run with: node --test tests/web/projectm-pcm-hud.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    RATE_WINDOW_MS,
    createPcmRateMeter,
    formatPcmHudText,
    readTransportRingCounters,
    ringDelta,
    setupPcmHud,
} from '../../html/projectm-pcm-hud.js';
import {
    feedPCMToModule,
    getExternalPcmStats,
    resetExternalPcmStateForTests,
} from '../../html/projectm-external-pcm.js';

const ring = (writeIndex, readIndex, sampledAt, overruns = 0) => ({
    writeIndex, readIndex, overruns, capacityFrames: 1000, indexModulus: 100000, sampledAt,
});

test('ringDelta handles wrap-around at the index modulus', () => {
    assert.equal(ringDelta(10, 30, 100), 20);
    assert.equal(ringDelta(90, 10, 100), 20);
    assert.equal(ringDelta(5, 5, 100), 0);
    assert.equal(ringDelta(5, 9, 0), 4);
});

test('the meter turns host counters into frames per second', () => {
    const meter = createPcmRateMeter();
    const first = meter.sample({ hostFramesReceived: 0, hostFramesFed: 0, ring: null }, 0);
    assert.equal(first.hostFps, 0);
    assert.equal(first.engineFps, null);
    const second = meter.sample({ hostFramesReceived: 44100, hostFramesFed: 22050, ring: null }, 1000);
    assert.equal(second.hostFps, 44100);
    assert.equal(second.fedFps, 22050);
});

test('ring rates use the reader timestamps, ignore repeated readings, and average over the window', () => {
    const meter = createPcmRateMeter();
    const host = { hostFramesReceived: 0, hostFramesFed: 0 };
    meter.sample({ ...host, ring: ring(0, 0, 100) }, 0);
    // Half a second later on the worker's clock, 22050 frames written, 20000 drained.
    let rates = meter.sample({ ...host, ring: ring(22050, 20000, 600) }, 1000);
    assert.equal(rates.ringWriteFps, 44100);
    assert.equal(rates.engineFps, 40000);
    // The same report seen again changes nothing.
    rates = meter.sample({ ...host, ring: ring(22050, 20000, 600) }, 2000);
    assert.equal(rates.ringWriteFps, 44100);
    // Rates span the window: a burst in the last reading is averaged out.
    rates = meter.sample({ ...host, ring: ring(44100, 44100, 1100) }, 3000);
    assert.equal(rates.engineFps, 44100);
    // Old readings fall out of the window.
    meter.sample({ ...host, ring: ring(44100 + 88200, 44100 + 88200, 1100 + RATE_WINDOW_MS) }, 4000);
    rates = meter.sample({ ...host, ring: ring(44100 + 88200 + 44100, 44100 + 88200 + 44100, 2100 + RATE_WINDOW_MS) }, 5000);
    assert.equal(Math.round(rates.engineFps), 44100);
    assert.equal(rates.overruns, 0);
    // A ring that goes away resets.
    rates = meter.sample({ ...host, ring: null }, 6000);
    assert.equal(rates.engineFps, null);
    assert.equal(rates.overruns, null);
});

test('readTransportRingCounters reads the worker stats or the module on this thread', () => {
    assert.deepEqual(readTransportRingCounters(null), { ring: null, source: null });

    const stats = { type: 'stats', pcmRing: ring(1, 2, 3) };
    const worker = { topology: 'worker', workerHandle: { getLastStats: () => stats } };
    assert.deepEqual(readTransportRingCounters(worker), { ring: stats.pcmRing, source: stats });

    const memory = new SharedArrayBuffer(64);
    const header = new Int32Array(memory, 16, 4);
    header[0] = 5;
    header[2] = 4;
    header[3] = 2;
    const module = {
        HEAPF32: new Float32Array(memory),
        _get_pcm_ring_header_ptr: () => 16,
        _get_pcm_ring_data_ptr: () => 32,
        _get_pcm_ring_capacity_frames: () => 4,
        _get_pcm_ring_index_modulus: () => 16,
    };
    const main = readTransportRingCounters({ topology: 'main', module });
    assert.equal(main.ring.writeIndex, 5);
    assert.equal(main.ring.readIndex, 4);
    assert.equal(main.ring.overruns, 2);
    assert.equal(readTransportRingCounters({ topology: 'main', module: null }).ring, null);
});

test('formatPcmHudText names the worker and the producer', () => {
    const text = formatPcmHudText(
        { hostFps: 44100, fedFps: 44100, ringWriteFps: 44000, engineFps: 43900, overruns: 3, hostFramesReceived: 0, hostFramesFed: 0 },
        { ...getExternalPcmStats(), lastChannels: 2, lastSampleRate: 44100, lastProducer: 'projectm-flac-bridge' },
        'worker',
    );
    assert.match(text, /PCM host 44\.1k fr\/s \(fed 44\.1k\)/);
    assert.match(text, /worker 43\.9k fr\/s/);
    assert.match(text, /overruns 3/);
    assert.match(text, /2ch @44100/);
    assert.match(text, /projectm-flac-bridge/);
    assert.match(formatPcmHudText({ hostFps: 5, fedFps: 0, ringWriteFps: null, engineFps: null, overruns: null }, getExternalPcmStats(), 'main'), /engine n\/a fr\/s/);
});

function fakeDocument() {
    const elements = new Map();
    const body = {
        children: [],
        appendChild(el) { this.children.push(el); elements.set(el.id, el); },
    };
    return {
        body,
        getElementById: (id) => elements.get(id) ?? null,
        createElement: () => {
            const el = {
                id: '',
                textContent: '',
                attrs: {},
                setAttribute(name, value) { this.attrs[name] = value; },
                remove() { body.children.splice(body.children.indexOf(el), 1); elements.delete(el.id); },
            };
            return el;
        },
    };
}

test('setupPcmHud publishes projectMPcmStats and shows the overlay only when asked', () => {
    resetExternalPcmStateForTests();
    const doc = fakeDocument();
    const stop = setupPcmHud({
        transport: { topology: 'worker', workerHandle: { getLastStats: () => null } },
        windowRef: { location: { search: '?pcmhud=1' } },
        documentRef: /** @type {any} */ (doc),
        intervalMs: 60000,
    });
    try {
        assert.equal(typeof globalThis.projectMPcmStats, 'function');
        const latest = globalThis.projectMPcmStats();
        assert.equal(latest.topology, 'worker');
        assert.equal(latest.engineFps, null);
        assert.equal(doc.body.children.length, 1);
        assert.match(doc.body.children[0].textContent, /^PCM host/);
    } finally {
        stop();
    }
    assert.equal(globalThis.projectMPcmStats, undefined);
    assert.equal(doc.body.children.length, 0);

    const quietDoc = fakeDocument();
    const stopQuiet = setupPcmHud({
        transport: null,
        windowRef: { location: { search: '' }, localStorage: { getItem: () => null } },
        documentRef: /** @type {any} */ (quietDoc),
        intervalMs: 60000,
    });
    feedPCMToModule(new Float32Array(4), 2);
    stopQuiet();
    assert.equal(quietDoc.body.children.length, 0);
    resetExternalPcmStateForTests();
});
