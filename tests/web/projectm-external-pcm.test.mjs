// Unit tests for html/projectm-external-pcm.js: origin allowlist enforcement,
// the 576-sample analysis-window trim + preallocated transfer buffer path, and
// gain clamping. Run with: node --test tests/web/projectm-external-pcm.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    defaultFeedPCMToModule,
    setExternalPcmGain,
    setupExternalAudioReceiver,
} from '../../html/projectm-external-pcm.js';

function fakeWindow() {
    const listeners = new Map();
    return {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        },
        dispatch(type, event) {
            for (const fn of listeners.get(type) || []) fn(event);
        },
    };
}

function fakeModule({ heapSize = 4096 } = {}) {
    const heap = new Float32Array(heapSize);
    const freed = [];
    const wrapperCalls = [];
    return {
        HEAPF32: heap,
        _malloc: (bytes) => {
            // Fixed offset is fine: each test uses a fresh module/heap.
            void bytes;
            return 0;
        },
        _free: (ptr) => freed.push(ptr),
        _projectm_pcm_add_float_wrapper: (pmHandle, ptr, samplesPerChannel, channels) => {
            wrapperCalls.push({ pmHandle, ptr, samplesPerChannel, channels });
        },
        freed,
        wrapperCalls,
    };
}

test('setupExternalAudioReceiver only feeds PCM posted from an allowlisted origin', () => {
    const win = fakeWindow();
    globalThis.window = win;

    const fed = [];
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer, channels, sampleRate, samplesPerChannel) => {
            fed.push({ channels, samplesPerChannel });
            return true;
        },
    });

    try {
        const buffer = new Float32Array([0.1, 0.2, 0.3, 0.4]); // 2 samples, stereo

        win.dispatch('message', {
            origin: 'https://untrusted.example',
            data: { type: 'pcm', buffer, channels: 2, sampleRate: 44100 },
        });
        assert.equal(fed.length, 0, 'an untrusted origin must not reach the feed callback');

        win.dispatch('message', {
            origin: 'https://trusted.example',
            data: { type: 'pcm', buffer, channels: 2, sampleRate: 44100 },
        });
        assert.equal(fed.length, 1, 'an allowlisted origin should reach the feed callback');
        assert.equal(fed[0].channels, 2);
        assert.equal(fed[0].samplesPerChannel, 2);
    } finally {
        receiver.close();
        delete globalThis.window;
    }
});

test('defaultFeedPCMToModule trims to the 576-sample analysis window via the transfer buffer', () => {
    const channels = 2;
    const samplesPerChannel = 700; // exceeds the 576-sample analysis window
    const buffer = new Float32Array(channels * samplesPerChannel);
    // Distinct values per sample so we can assert the *tail* was kept after trimming.
    for (let i = 0; i < buffer.length; i++) buffer[i] = i;

    const module = fakeModule();
    const fed = defaultFeedPCMToModule(buffer, channels, 44100, samplesPerChannel);

    assert.equal(fed, false, 'no global Module is registered, so the default path must report failure');
    assert.equal(module.wrapperCalls.length, 0, 'nothing should be written without a registered Module');

    globalThis.Module = module;
    try {
        const ok = defaultFeedPCMToModule(buffer, channels, 44100, samplesPerChannel);
        assert.equal(ok, true);
        assert.equal(module.wrapperCalls.length, 1);
        assert.equal(module.wrapperCalls[0].samplesPerChannel, 576, 'must trim to the internal analysis window');
        assert.equal(module.wrapperCalls[0].channels, channels);

        // The trimmed window keeps the *most recent* samples (the tail of the buffer).
        const expectedFirstKeptSample = buffer[buffer.length - 576 * channels];
        assert.equal(module.HEAPF32[0], expectedFirstKeptSample);
    } finally {
        delete globalThis.Module;
    }
});

test('setExternalPcmGain clamps invalid values to the default and scales fed samples', () => {
    assert.equal(setExternalPcmGain(-5), 1, 'non-positive gain falls back to the default (1.0)');
    assert.equal(setExternalPcmGain(Number.NaN), 1, 'NaN gain falls back to the default (1.0)');
    assert.equal(setExternalPcmGain(2), 2, 'a valid positive gain is applied as-is');

    const channels = 1;
    const samplesPerChannel = 4;
    const buffer = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const module = fakeModule();

    globalThis.Module = module;
    try {
        const ok = defaultFeedPCMToModule(buffer, channels, 44100, samplesPerChannel);
        assert.equal(ok, true);
        for (let i = 0; i < buffer.length; i++) {
            assert.ok(
                Math.abs(module.HEAPF32[i] - buffer[i] * 2) < 1e-6,
                `sample ${i} should be scaled by the configured gain`
            );
        }
    } finally {
        setExternalPcmGain(1);
        delete globalThis.Module;
    }
});
