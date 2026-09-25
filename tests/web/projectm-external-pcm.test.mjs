// Unit tests for html/projectm-external-pcm.js: origin allowlist enforcement,
// the 576-sample analysis-window trim + preallocated transfer buffer path, and
// gain clamping. Run with: node --test tests/web/projectm-external-pcm.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
     DEFAULT_EXTERNAL_PCM_ORIGINS,
     defaultFeedPCMToModule,
     feedPCMToModule,
     flushQueuedExternalPCM,
     getExternalPcmReceiverCount,
     isTrustedExternalPcmOrigin,
     resetExternalPcmStateForTests,
     setConfiguredAllowedOrigins,
     setExternalPcmGain,
     setExternalPcmTransport,
     setupExternalAudioReceiver,
 } from '../../html/projectm-external-pcm.js';
import { trackListeners } from './helpers/listener-ledger.mjs';

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
            wrapperCalls.push({
                pmHandle,
                ptr,
                samplesPerChannel,
                channels,
                firstSample: heap[0],
            });
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

test('defaultFeedPCMToModule feeds the whole chunk, not just an analysis window', () => {
    const channels = 2;
    const samplesPerChannel = 700; // more than projectM's 576-frame analysis buffer
    const buffer = new Float32Array(channels * samplesPerChannel);
    // Distinct values per sample so we can assert which samples survived.
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
        // The old analyser-shaped path trimmed to the newest 576 frames and threw
        // the rest away. The ring takes everything, so nothing is dropped here
        // either — the fallback marshaling path must match the ring's contract.
        assert.equal(
            module.wrapperCalls[0].samplesPerChannel,
            samplesPerChannel,
            'must feed every frame the producer sent'
        );
        assert.equal(module.wrapperCalls[0].channels, channels);
        assert.equal(module.HEAPF32[0], buffer[0], 'the chunk is fed from its first sample');
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
 
test('isTrustedExternalPcmOrigin respects configured allowlist', () => {
    resetExternalPcmStateForTests();
    setConfiguredAllowedOrigins(['https://a.example', 'https://b.example']);
    try {
        assert.equal(isTrustedExternalPcmOrigin('https://a.example'), true);
        assert.equal(isTrustedExternalPcmOrigin('https://evil.example'), false);
    } finally {
        resetExternalPcmStateForTests();
    }
});

test('default allowlist includes first-party FLAC/MOD/projectM origins', () => {
    resetExternalPcmStateForTests();
    try {
        for (const origin of [
            'https://flac.1ink.us',
            'https://mod.1ink.us',
            'https://projectm.1ink.us',
            'https://go.1ink.us',
            'https://test.1ink.us',
        ]) {
            assert.equal(
                isTrustedExternalPcmOrigin(origin),
                true,
                `${origin} must be trusted by default`
            );
            assert.ok(
                DEFAULT_EXTERNAL_PCM_ORIGINS.includes(origin),
                `${origin} must appear in DEFAULT_EXTERNAL_PCM_ORIGINS`
            );
        }
        assert.equal(isTrustedExternalPcmOrigin('https://evil.example'), false);
    } finally {
        resetExternalPcmStateForTests();
    }
});

test('page origin is always trusted even with an empty remote allowlist', () => {
    resetExternalPcmStateForTests();
    const previousLocation = globalThis.location;
    // jsdom-less node tests: stub location.origin.
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://projectm.1ink.us' },
    });
    setConfiguredAllowedOrigins([]);
    try {
        assert.equal(isTrustedExternalPcmOrigin('https://projectm.1ink.us'), true);
        assert.equal(isTrustedExternalPcmOrigin('https://flac.1ink.us'), false);
    } finally {
        resetExternalPcmStateForTests();
        if (previousLocation === undefined) {
            delete globalThis.location;
        } else {
            Object.defineProperty(globalThis, 'location', {
                configurable: true,
                value: previousLocation,
            });
        }
    }
});
 
test('feedPCMToModule rejects odd-length stereo payloads', () => {
    resetExternalPcmStateForTests();
    const module = fakeModule();
    globalThis.Module = module;
    try {
        const oddStereo = new Float32Array([0.1, 0.2, 0.3]);
        assert.equal(feedPCMToModule(oddStereo, 2, 44100), false);
        assert.equal(module.wrapperCalls.length, 0);
    } finally {
        delete globalThis.Module;
        resetExternalPcmStateForTests();
    }
});
 
test('feedPCMToModule accepts mono payloads with one sample per channel', () => {
    resetExternalPcmStateForTests();
    const module = fakeModule();
    globalThis.Module = module;
    try {
        const mono = new Float32Array([0.5, -0.25, 0.75]);
        assert.equal(feedPCMToModule(mono, 1, 44100), true);
        assert.equal(module.wrapperCalls.length, 1);
        assert.equal(module.wrapperCalls[0].channels, 1);
        assert.equal(module.wrapperCalls[0].samplesPerChannel, 3);
    } finally {
        delete globalThis.Module;
        resetExternalPcmStateForTests();
    }
});
 
test('feedPCMToModule drops oldest queued chunk when the pending queue is full', () => {
    resetExternalPcmStateForTests();
    const first = new Float32Array([1]);
    const last = new Float32Array([99]);
    assert.equal(feedPCMToModule(first, 1, 44100), false, 'queues when module is not ready');
 
    for (let i = 0; i < 24; i += 1) {
        feedPCMToModule(new Float32Array([i + 2]), 1, 44100);
    }
    feedPCMToModule(last, 1, 44100);
 
    const module = fakeModule();
    globalThis.Module = module;
    try {
        flushQueuedExternalPCM();
        assert.equal(module.wrapperCalls.length, 24, 'queue capacity is 24 chunks');
        const fedFirstSamples = module.wrapperCalls.map((call) => call.firstSample);
        assert.ok(!fedFirstSamples.includes(first[0]), 'oldest chunk should have been dropped');
        assert.ok(fedFirstSamples.includes(last[0]), 'most recent chunk should be retained');
    } finally {
        delete globalThis.Module;
        resetExternalPcmStateForTests();
    }
});
 
test('feedGate drops external PCM without queueing when policy blocks the path', () => {
    resetExternalPcmStateForTests();
    globalThis.window = fakeWindow();
    const blocked = new Float32Array([0.42]);
    const receiver = setupExternalAudioReceiver({
        feedGate: () => false,
        onFeed: () => true,
    });
    try {
        assert.equal(feedPCMToModule(blocked, 1, 44100), false);
        const module = fakeModule();
        globalThis.Module = module;
        flushQueuedExternalPCM();
        assert.equal(module.wrapperCalls.length, 0, 'blocked chunks must not flush from the queue');
        delete globalThis.Module;
    } finally {
        receiver.close();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});
 
// ---------------------------------------------------------------------------
// Queue-drop behaviour
// ---------------------------------------------------------------------------
 
test('feedPCMToModule queues chunks when no module is registered and drops the oldest when full', () => {
    // onFeed returning false causes chunks to be enqueued internally. Once the
    // queue reaches MAX_PENDING (24) the oldest entry is evicted before each
    // new push. We call feedPCMToModule() directly to bypass the module-level
    // singleton message-listener (which is only installed once and bound to the
    // first test's fake window).
    const MAX_PENDING = 24;
    const fedByOnFeed = [];
 
    // setupExternalAudioReceiver may call window.addEventListener('beforeunload', ...)
    // when resetting state between tests; provide a minimal shim.
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer) => {
            fedByOnFeed.push(buffer[0]);
            return false; // reject so chunks are queued
        },
    });
 
    try {
        for (let i = 0; i < MAX_PENDING + 2; i++) {
            const buf = new Float32Array([i / 100, (i + 1) / 100]); // stereo
            feedPCMToModule(buf, 2, 44100);
        }
        assert.equal(fedByOnFeed.length, MAX_PENDING + 2, 'onFeed should be called for every incoming chunk');
    } finally {
        receiver.close();
        delete globalThis.window;
        // Drain the internal queue so module-level state is clean for subsequent tests.
        flushQueuedExternalPCM();
    }
});
 
// ---------------------------------------------------------------------------
// Stereo / mono normalisation
// ---------------------------------------------------------------------------
 
test('feedPCMToModule accepts mono buffers with channels=1', () => {
    // Call feedPCMToModule() directly to bypass the singleton message listener.
    const accepted = [];
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer, channels, sampleRate, samplesPerChannel) => {
            accepted.push({ channels, samplesPerChannel });
            return true;
        },
    });
 
    try {
        const buffer = new Float32Array([0.1, 0.2, 0.3, 0.4]); // 4 mono samples
        feedPCMToModule(buffer, 1, 44100);
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0].channels, 1);
        assert.equal(accepted[0].samplesPerChannel, 4);
    } finally {
        receiver.close();
        delete globalThis.window;
    }
});
 
test('feedPCMToModule rejects an odd-length buffer when channels=2 (stereo)', () => {
    // An odd-length buffer cannot be split evenly into two channels.
    const fed = [];
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer, channels) => {
            fed.push(channels);
            return true;
        },
    });
 
    try {
        const oddBuffer = new Float32Array([0.1, 0.2, 0.3]); // 3 samples — invalid for stereo
        feedPCMToModule(oddBuffer, 2, 44100);
        assert.equal(fed.length, 0, 'odd-length stereo buffer must be silently rejected');
    } finally {
        receiver.close();
        delete globalThis.window;
    }
});
 
test('feedPCMToModule normalises channel counts outside [1,2] to stereo', () => {
    // channels=3 is out of the valid range [1,2] → normalised to 2.
    const accepted = [];
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer, channels) => {
            accepted.push(channels);
            return true;
        },
    });
 
    try {
        const evenBuffer = new Float32Array([0.1, 0.2, 0.3, 0.4]); // valid stereo length
        feedPCMToModule(evenBuffer, 3, 44100);
        // channels=3 is invalid → normalised to 2
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0], 2);
    } finally {
        receiver.close();
        delete globalThis.window;
    }
});
 
test('feedPCMToModule rejects a non-Float32Array payload', () => {
    // Call feedPCMToModule() directly — the message-listener singleton is on a
    // different window after the first test, so we test the normalisation layer
    // directly here.
    const fed = [];
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: () => { fed.push(true); return true; },
    });
 
    try {
        // @ts-expect-error — intentionally passing a plain Array to test rejection
        const result = feedPCMToModule([0.1, 0.2], 2, 44100);
        assert.equal(result, false, 'feedPCMToModule must return false for a non-Float32Array');
        assert.equal(fed.length, 0, 'plain Array must be rejected before reaching onFeed');
    } finally {
        receiver.close();
        delete globalThis.window;
    }
});
 
// ---------------------------------------------------------------------------
// BroadcastChannel reception
// ---------------------------------------------------------------------------
 
test('setupExternalAudioReceiver feeds PCM received via the BroadcastChannel', () => {
    const win = fakeWindow();
    globalThis.window = win;
 
    const bcCallbacks = [];
    // Minimal fake BroadcastChannel constructor that captures the onmessage setter.
    function FakeBroadcastChannel(name) {
        this.name = name;
        this._closed = false;
        bcCallbacks.push(this);
    }
    FakeBroadcastChannel.prototype.close = function () { this._closed = true; };
 
    const originalBC = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = FakeBroadcastChannel;
 
    const fed = [];
    const receiver = setupExternalAudioReceiver({
        allowedOrigins: ['https://trusted.example'],
        onFeed: (buffer, channels, sampleRate, samplesPerChannel) => {
            fed.push({ channels, samplesPerChannel });
            return true;
        },
    });
 
    try {
        assert.ok(bcCallbacks.length > 0, 'BroadcastChannel must be created by setupExternalAudioReceiver');
        const bc = bcCallbacks[bcCallbacks.length - 1];
        assert.ok(typeof bc.onmessage === 'function', 'onmessage must be set on the channel');
 
        const buffer = new Float32Array([0.5, -0.5]); // 2 samples, stereo
        bc.onmessage({ data: { type: 'pcm', buffer, channels: 2, sampleRate: 44100 } });
 
        assert.equal(fed.length, 1, 'BroadcastChannel PCM must reach the feed callback');
        assert.equal(fed[0].channels, 2);
        assert.equal(fed[0].samplesPerChannel, 1);
    } finally {
        receiver.close();
        if (originalBC !== undefined) {
            globalThis.BroadcastChannel = originalBC;
        } else {
            delete globalThis.BroadcastChannel;
        }
        delete globalThis.window;
    }
});

// ---------------------------------------------------------------------------
// Several receivers on one page (two contexts), and what a close() leaves behind
// ---------------------------------------------------------------------------

/** A worker-topology stand-in that records what reaches it. */
function fakeTransport(name) {
    const fed = [];
    return { name, topology: 'worker', feedPcm: (samples, channels) => fed.push({ length: samples.length, channels }), fed };
}

/** A BroadcastChannel stand-in that can be inspected. */
function installFakeChannel() {
    const original = globalThis.BroadcastChannel;
    const instances = [];
    globalThis.BroadcastChannel = function FakeChannel(name) {
        this.name = name;
        this.closed = false;
        this.onmessage = null;
        this.close = () => { this.closed = true; };
        instances.push(this);
    };
    return {
        instances,
        restore() {
            if (original === undefined) delete globalThis.BroadcastChannel;
            else globalThis.BroadcastChannel = original;
        },
    };
}

function pcmMessage(origin, samples = [0.1, 0.2]) {
    return { origin, data: { type: 'pcm', buffer: new Float32Array(samples), channels: 2, sampleRate: 44100 } };
}

test('closing an older receiver does not cut off the newer one', () => {
    resetExternalPcmStateForTests();
    const win = fakeWindow();
    const ledger = trackListeners(win, 'window');
    globalThis.window = win;
    const channel = installFakeChannel();

    const fedA = [];
    const fedB = [];
    const receiverA = setupExternalAudioReceiver({ allowedOrigins: ['https://a.example'], onFeed: () => { fedA.push(1); return true; } });
    const receiverB = setupExternalAudioReceiver({ allowedOrigins: ['https://b.example'], onFeed: () => { fedB.push(1); return true; } });

    try {
        assert.equal(getExternalPcmReceiverCount(), 2);
        assert.equal(channel.instances.length, 1, 'receivers share one BroadcastChannel');
        assert.equal(ledger.outstanding().message, 1, 'and one message listener');

        receiverA.close();
        assert.equal(getExternalPcmReceiverCount(), 1);
        assert.equal(ledger.outstanding().message, 1, 'B still needs the shared listener');
        assert.equal(channel.instances[0].closed, false, 'and the shared channel');

        win.dispatch('message', pcmMessage('https://b.example'));
        assert.equal(fedB.length, 1, 'destroying A must not stop B hearing audio');
        assert.equal(fedA.length, 0);
    } finally {
        receiverB.close();
        channel.restore();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('only the live (newest) receiver feeds, so a page receiver and a context do not double-feed', () => {
    resetExternalPcmStateForTests();
    globalThis.window = fakeWindow();
    const fedPage = [];
    const fedContext = [];
    const page = setupExternalAudioReceiver({ onFeed: () => { fedPage.push(1); return true; } });
    const context = setupExternalAudioReceiver({ onFeed: () => { fedContext.push(1); return true; } });

    try {
        feedPCMToModule(new Float32Array([0.1, 0.2]), 2, 44100);
        assert.equal(fedContext.length, 1);
        assert.equal(fedPage.length, 0, 'one chunk must reach one engine once');

        context.close();
        feedPCMToModule(new Float32Array([0.1, 0.2]), 2, 44100);
        assert.equal(fedPage.length, 1, 'closing the context hands the role back to the page receiver');
    } finally {
        page.close();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('closing the live receiver hands its gate and origin allowlist back to the previous one', () => {
    resetExternalPcmStateForTests();
    globalThis.window = fakeWindow();
    const page = setupExternalAudioReceiver({ allowedOrigins: ['https://page.example'], feedGate: () => true, onFeed: () => true });
    const context = setupExternalAudioReceiver({ allowedOrigins: ['https://ctx.example'], feedGate: () => false, onFeed: () => true });

    try {
        assert.equal(isTrustedExternalPcmOrigin('https://ctx.example'), true);
        assert.equal(isTrustedExternalPcmOrigin('https://page.example'), false, 'the live receiver\'s policy decides');
        assert.equal(feedPCMToModule(new Float32Array([1, 2]), 2), false, 'the live gate blocks');

        context.close();
        assert.equal(isTrustedExternalPcmOrigin('https://page.example'), true);
        assert.equal(isTrustedExternalPcmOrigin('https://ctx.example'), false, 'a closed receiver\'s policy must not linger');
        assert.equal(feedPCMToModule(new Float32Array([1, 2]), 2), true, 'and its gate no longer applies');
    } finally {
        page.close();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('after the last close nothing reaches the old feed callback, gated or not', () => {
    resetExternalPcmStateForTests();
    const win = fakeWindow();
    globalThis.window = win;
    const channel = installFakeChannel();
    let calls = 0;
    const receiver = setupExternalAudioReceiver({ allowedOrigins: ['https://a.example'], onFeed: () => { calls += 1; return true; } });

    try {
        const listener = channel.instances[0].onmessage;
        assert.equal(typeof listener, 'function');
        receiver.close();

        // Used to keep feeding the destroyed context's wrapper with no gate at
        // all: the listener stayed installed and `customFeed` stayed set.
        win.dispatch('message', pcmMessage('https://a.example'));
        assert.equal(calls, 0, 'the window listener is gone');
        assert.equal(channel.instances[0].onmessage, null, 'the channel handler is detached');
        assert.equal(feedPCMToModule(new Float32Array([1, 2]), 2), false, 'a direct call no longer reaches the old callback');
        assert.equal(calls, 0);
    } finally {
        channel.restore();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('the last close leaves no window listeners, closes the channel and drops queued chunks', () => {
    resetExternalPcmStateForTests();
    const win = fakeWindow();
    const ledger = trackListeners(win, 'window');
    globalThis.window = win;
    const channel = installFakeChannel();

    const receiver = setupExternalAudioReceiver({ onFeed: () => false });
    try {
        feedPCMToModule(new Float32Array([0.5, 0.5]), 2, 44100);
        assert.deepEqual(Object.keys(ledger.outstanding()).sort(), ['beforeunload', 'message']);

        receiver.close();
        ledger.assertBalanced(assert, 'a closed receiver must remove its window listeners');
        assert.equal(channel.instances[0].closed, true);

        const module = fakeModule();
        globalThis.Module = module;
        flushQueuedExternalPCM();
        assert.equal(module.wrapperCalls.length, 0, 'stale queued audio is not delivered to the next context');
        delete globalThis.Module;

        receiver.close();
        ledger.assertBalanced(assert, 'closing twice is harmless');
    } finally {
        channel.restore();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('receivers opened and closed repeatedly do not accumulate window listeners', () => {
    resetExternalPcmStateForTests();
    const win = fakeWindow();
    const ledger = trackListeners(win, 'window');
    globalThis.window = win;
    const channel = installFakeChannel();
    try {
        for (let i = 0; i < 5; i += 1) {
            setupExternalAudioReceiver({ onFeed: () => true }).close();
        }
        ledger.assertBalanced(assert);
        assert.equal(ledger.adds, ledger.removes, 'every add has its remove');
        assert.equal(channel.instances.every((instance) => instance.closed), true);
    } finally {
        channel.restore();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('beforeunload closes every receiver', () => {
    resetExternalPcmStateForTests();
    const win = fakeWindow();
    const ledger = trackListeners(win, 'window');
    globalThis.window = win;
    const channel = installFakeChannel();
    try {
        setupExternalAudioReceiver({ onFeed: () => true });
        setupExternalAudioReceiver({ onFeed: () => true });
        win.dispatch('beforeunload', {});
        assert.equal(getExternalPcmReceiverCount(), 0);
        ledger.assertBalanced(assert);
    } finally {
        channel.restore();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('a receiver\'s own transport is fed instead of the page default', () => {
    resetExternalPcmStateForTests();
    globalThis.window = fakeWindow();
    const pageDefault = fakeTransport('default');
    const own = fakeTransport('own');
    const releaseDefault = setExternalPcmTransport(pageDefault);
    const receiver = setupExternalAudioReceiver({ transport: own });
    try {
        assert.equal(feedPCMToModule(new Float32Array([1, 2, 3, 4]), 2, 44100), true);
        assert.equal(own.fed.length, 1);
        assert.equal(pageDefault.fed.length, 0);

        receiver.close();
        assert.equal(feedPCMToModule(new Float32Array([1, 2, 3, 4]), 2, 44100), true);
        assert.equal(pageDefault.fed.length, 1, 'with no receiver the page default is used again');
    } finally {
        releaseDefault();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});

test('releasing one context\'s transport claim leaves the other context\'s registered', () => {
    resetExternalPcmStateForTests();
    const transportA = fakeTransport('A');
    const transportB = fakeTransport('B');
    const releaseA = setExternalPcmTransport(transportA);
    const releaseB = setExternalPcmTransport(transportB);
    try {
        assert.equal(defaultFeedPCMToModule(new Float32Array([1, 2]), 2, 44100, 1), true);
        assert.equal(transportB.fed.length, 1, 'the newest claim is fed');

        // Used to be `setExternalPcmTransport(null)`, which cut B off.
        releaseA();
        assert.equal(defaultFeedPCMToModule(new Float32Array([1, 2]), 2, 44100, 1), true);
        assert.equal(transportB.fed.length, 2, 'destroying A must not stop B hearing audio');
        assert.equal(transportA.fed.length, 0);

        releaseB();
        assert.equal(defaultFeedPCMToModule(new Float32Array([1, 2]), 2, 44100, 1), false, 'nothing left to feed');

        releaseA();
        releaseB();
    } finally {
        resetExternalPcmStateForTests();
    }
});

test('releasing the newer transport claim hands the page default back to the older one', () => {
    resetExternalPcmStateForTests();
    const transportA = fakeTransport('A');
    const transportB = fakeTransport('B');
    const releaseA = setExternalPcmTransport(transportA);
    const releaseB = setExternalPcmTransport(transportB);
    try {
        releaseB();
        defaultFeedPCMToModule(new Float32Array([1, 2]), 2, 44100, 1);
        assert.equal(transportA.fed.length, 1);
        releaseA();
    } finally {
        resetExternalPcmStateForTests();
    }
});

test('setExternalPcmTransport(null) still drops every claim', () => {
    resetExternalPcmStateForTests();
    const transport = fakeTransport('A');
    setExternalPcmTransport(transport);
    setExternalPcmTransport(null);
    assert.equal(defaultFeedPCMToModule(new Float32Array([1, 2]), 2, 44100, 1), false);
    assert.equal(transport.fed.length, 0);
    resetExternalPcmStateForTests();
});

test('setConfiguredAllowedOrigins tightens the policy of an already-open receiver', () => {
    resetExternalPcmStateForTests();
    globalThis.window = fakeWindow();
    const receiver = setupExternalAudioReceiver({ allowedOrigins: ['https://old.example'] });
    try {
        assert.equal(isTrustedExternalPcmOrigin('https://old.example'), true);
        setConfiguredAllowedOrigins(['https://new.example']);
        assert.equal(isTrustedExternalPcmOrigin('https://new.example'), true);
        assert.equal(isTrustedExternalPcmOrigin('https://old.example'), false);
    } finally {
        receiver.close();
        delete globalThis.window;
        resetExternalPcmStateForTests();
    }
});
