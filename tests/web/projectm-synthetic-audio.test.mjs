// html/projectm-synthetic-audio.js — the synthetic PCM generators behind the
// ?audioTest=1 panel and the deterministic golden-image feed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SAMPLE_RATE,
    feedPcmToModule,
    generateBeatPulse,
    generateDeterministicBlock,
    generateFrequencySweep,
    generateSilence,
    generateSine,
    PROJECTM_ANALYSIS_WINDOW,
    setupAudioTestPanel,
    startSyntheticFeed,
    trimToAnalysisWindow,
} from '../../html/projectm-synthetic-audio.js';
import { createFakePage, installFakePage } from './helpers/fake-page.mjs';

const peak = (buffer) => buffer.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

/** Zero crossings per second, a frequency estimate for a pure tone. */
function crossingRate(buffer, sampleRate = DEFAULT_SAMPLE_RATE) {
    let crossings = 0;
    for (let i = 1; i < buffer.length; i++) {
        if ((buffer[i - 1] < 0) !== (buffer[i] < 0)) crossings++;
    }
    return (crossings / 2) / (buffer.length / sampleRate);
}

test('generators produce the requested length, level and pitch', () => {
    assert.deepEqual([...generateSilence(4)], [0, 0, 0, 0]);

    const tone = generateSine(44100, { frequencyHz: 440, amplitude: 0.5 });
    assert.equal(tone.length, 44100);
    assert.ok(Math.abs(peak(tone) - 0.5) < 1e-3);
    assert.ok(Math.abs(crossingRate(tone) - 440) < 2);
    assert.equal(generateSine(8, { phase: 0 })[0], 0);

    const sweep = generateFrequencySweep(44100, { startHz: 100, endHz: 1000, amplitude: 0.6 });
    const head = crossingRate(sweep.subarray(0, 4410));
    const tail = crossingRate(sweep.subarray(44100 - 4410));
    assert.ok(head < tail, `the sweep rises (${head.toFixed(0)} -> ${tail.toFixed(0)} Hz)`);
    assert.ok(peak(sweep) <= 0.6 + 1e-6);
    assert.equal(generateFrequencySweep(1).length, 1, 'a one-sample sweep does not divide by zero');

    const pulse = generateBeatPulse(44100, { bpm: 120 });
    const interval = Math.round(44100 * 60 / 120);
    assert.equal(pulse[0], 0, 'the burst starts at a zero of its carrier');
    assert.ok(peak(pulse.subarray(1, 80)) > 0, 'a burst at every beat');
    assert.ok(peak(pulse.subarray(interval + 1, interval + 80)) > 0);
    assert.equal(peak(pulse.subarray(100, interval)), 0, 'silence between beats');
});

test('the deterministic block depends only on its absolute frame index', () => {
    const direct = generateDeterministicBlock(37);
    // Generating everything before it first makes no difference.
    for (let i = 0; i < 37; i++) generateDeterministicBlock(i);
    assert.deepEqual(generateDeterministicBlock(37), direct);
    assert.equal(direct.length, PROJECTM_ANALYSIS_WINDOW);
    assert.notDeepEqual(generateDeterministicBlock(38), direct);

    // Block N continues block N-1 sample for sample: blocks of 2 frames each
    // equal one block of 4 frames.
    const joined = [...generateDeterministicBlock(0, { frames: 2 }), ...generateDeterministicBlock(1, { frames: 2 })];
    assert.deepEqual(joined, [...generateDeterministicBlock(0, { frames: 4 })]);

    let worst = 0;
    for (let i = 0; i < 200; i++) worst = Math.max(worst, peak(generateDeterministicBlock(i)));
    assert.ok(worst <= 0.93, `never clips (${worst})`);
});

test('trimToAnalysisWindow keeps the newest frames of interleaved PCM', () => {
    const stereo = Float32Array.from({ length: 20 }, (_, i) => i);
    const trimmed = trimToAnalysisWindow(stereo, 10, 4);
    assert.equal(trimmed.samplesPerChannel, 4);
    assert.deepEqual([...trimmed.buffer], [12, 13, 14, 15, 16, 17, 18, 19]);
    const short = trimToAnalysisWindow(stereo, 10, 64);
    assert.equal(short.buffer, stereo, 'shorter than the window: untouched');
    assert.equal(short.samplesPerChannel, 10);
});

/** A Module with no PCM ring, only the direct marshaling exports. */
function directModule() {
    const heap = new Float32Array(4096);
    const fed = [];
    return {
        fed,
        HEAPF32: heap,
        _malloc: () => 64,
        _free: () => {},
        _projectm_pcm_add_float_wrapper: (_handle, ptr, frames, channels) => {
            fed.push({ frames, channels, first: heap[ptr >> 2] });
        },
    };
}

test('feedPcmToModule falls back to direct marshaling, trimmed to the analysis window', () => {
    assert.equal(feedPcmToModule(null, new Float32Array(4)), false);
    assert.equal(feedPcmToModule(/** @type {any} */ ({}), new Float32Array(4)), false, 'no exports to feed through');

    const module = directModule();
    const mono = Float32Array.from({ length: 1000 }, (_, i) => i);
    assert.equal(feedPcmToModule(/** @type {any} */ (module), mono, 1), true);
    assert.deepEqual(module.fed[0], { frames: PROJECTM_ANALYSIS_WINDOW, channels: 1, first: 1000 - PROJECTM_ANALYSIS_WINDOW });

    const stereo = new Float32Array(20).fill(0.25);
    feedPcmToModule(/** @type {any} */ (module), stereo, 2);
    assert.deepEqual(module.fed[1], { frames: 10, channels: 2, first: 0.25 });

    const noHeap = { ...directModule(), _malloc: () => 0 };
    assert.equal(feedPcmToModule(/** @type {any} */ (noHeap), mono, 1), false, 'a failed malloc is not a feed');
});

test('startSyntheticFeed feeds one block per animation frame until stopped', (t) => {
    /** @type {Array<() => void>} */
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    t.after(() => { delete globalThis.requestAnimationFrame; });
    const module = directModule();
    const seen = [];
    const stop = startSyntheticFeed(/** @type {any} */ (module), 'treble', { channels: 2, onFrame: (f, mode) => seen.push([f, mode]) });
    frames.shift()();
    frames.shift()();
    assert.deepEqual(seen, [[0, 'treble'], [1, 'treble']]);
    assert.deepEqual(module.fed.map((entry) => entry.channels), [2, 2]);
    stop();
    frames.shift()();
    assert.equal(seen.length, 2, 'nothing after stop');
    assert.equal(frames.length, 0, 'and no further frame is requested');

    // Unknown modes fall back to bass rather than throwing.
    const fallback = startSyntheticFeed(/** @type {any} */ (module), /** @type {any} */ ('nope'));
    frames.shift()();
    fallback();
});

test('the ?audioTest=1 panel starts and switches feeds', (t) => {
    /** @type {Array<() => void>} */
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    t.after(() => { delete globalThis.requestAnimationFrame; });
    const page = createFakePage('<body></body>', { search: '?audioTest=1' });
    const restore = installFakePage(page);
    try {
        /** @type {any} */
        let module = null;
        const panel = setupAudioTestPanel(() => module);
        assert.ok(panel && page.document.body.children.includes(panel));
        const status = panel.querySelector('#pm-audio-test-status');
        const buttons = panel.querySelectorAll('button[data-mode]');
        assert.deepEqual(buttons.map((b) => b.dataset.mode), ['silence', 'bass', 'mid', 'treble', 'beat', 'sweep']);
        const button = (mode) => buttons.find((b) => b.dataset.mode === mode);

        button('beat').click();
        assert.equal(status.textContent, 'module not ready', 'the module getter is re-read on each click');

        module = directModule();
        button('beat').click();
        assert.equal(status.textContent, 'feeding: beat');
        frames.shift()();
        assert.equal(status.textContent, 'feeding: beat (frame 0)');
        assert.equal(module.fed.length, 1);

        // Switching stops the previous feed: its pending frame feeds nothing.
        button('sweep').click();
        const stale = frames.shift();
        stale();
        assert.equal(module.fed.length, 1, 'the beat feed stopped');
        frames.shift()();
        assert.equal(status.textContent, 'feeding: sweep (frame 0)');
    } finally {
        restore();
    }
});

test('the panel is not built without ?audioTest=1', () => {
    const page = createFakePage('<body></body>', { search: '' });
    const restore = installFakePage(page);
    try {
        assert.equal(setupAudioTestPanel(null), null);
        assert.equal(page.document.body.children.length, 0);
    } finally {
        restore();
    }
});
