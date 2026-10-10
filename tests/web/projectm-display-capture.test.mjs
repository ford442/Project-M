// Unit tests for html/projectm-display-capture.js.
// Run with: node --test tests/web/projectm-display-capture.test.mjs
//
// Drives the getDisplayMedia → AudioWorklet → postMessage wiring with fake
// media and Web Audio objects, so it runs without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DISPLAY_CAPTURE_PRODUCER,
    SILENCE_HINT_MS,
    buildDisplayMediaOptions,
    describeCaptureError,
    startDisplayAudioCapture,
} from '../../html/projectm-display-capture.js';
import { CAPTURE_PROCESSOR_NAME } from '../../html/flac-player/projectm-pcm-bridge.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTrack(kind, { channelCount = 2, label = 'Tab audio' } = {}) {
    const listeners = new Map();
    return {
        kind,
        label,
        stopped: false,
        stop() { this.stopped = true; },
        getSettings: () => ({ channelCount }),
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        fire(type) { listeners.get(type)?.(); },
    };
}

function fakeStream({ audio = true, channelCount = 2 } = {}) {
    let tracks = [fakeTrack('video')];
    if (audio) tracks.push(fakeTrack('audio', { channelCount }));
    const all = [...tracks];
    return {
        all,
        getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
        getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
        getTracks: () => tracks,
        removeTrack(track) { tracks = tracks.filter((t) => t !== track); },
    };
}

function fakeNode(name) {
    return {
        name,
        connections: [],
        disconnected: false,
        gain: { value: 1 },
        connect(dest) { this.connections.push(dest); },
        disconnect() { this.disconnected = true; },
    };
}

function makeAudio({ worklet = true } = {}) {
    const created = { contexts: [], workletNodes: [], scriptNodes: [], modules: [] };
    class FakeContext {
        constructor(opts) {
            this.opts = opts;
            this.sampleRate = 48000;
            this.state = 'running';
            this.closed = false;
            this.destination = fakeNode('destination');
            this.audioWorklet = worklet ? { addModule: async (url) => { created.modules.push(url); } } : undefined;
            created.contexts.push(this);
        }
        createMediaStreamSource(stream) { const n = fakeNode('source'); n.stream = stream; return n; }
        createGain() { return fakeNode('gain'); }
        createScriptProcessor(frames) {
            const n = fakeNode('script');
            n.frames = frames;
            created.scriptNodes.push(n);
            return n;
        }
        close() { this.closed = true; }
    }
    class FakeWorkletNode {
        constructor(ctx, name, opts) {
            Object.assign(this, fakeNode('worklet'));
            this.processorName = name;
            this.opts = opts;
            this.port = { onmessage: null };
            created.workletNodes.push(this);
        }
    }
    return { created, FakeContext, FakeWorkletNode };
}

function harness({ stream = fakeStream(), reject = null, worklet = true, opener = null, parent } = {}) {
    const posted = [];
    const broadcasts = [];
    const statuses = [];
    const audio = makeAudio({ worklet });
    const win = { opener, URL: { revokeObjectURL() {} } };
    win.parent = parent === undefined ? win : parent;
    let clock = 0;
    const opts = {
        windowRef: win,
        onStatus: (s) => statuses.push(s),
        mediaDevices: {
            getDisplayMedia: async (constraints) => {
                opts.lastConstraints = constraints;
                if (reject) throw reject;
                return stream;
            },
        },
        audioContextCtor: audio.FakeContext,
        audioWorkletNodeCtor: audio.FakeWorkletNode,
        broadcastChannelCtor: class {
            constructor(name) { this.name = name; this.closed = false; }
            postMessage(msg) { broadcasts.push(msg); }
            close() { this.closed = true; }
        },
        blobCtor: class { constructor(parts) { this.parts = parts; } },
        createObjectURL: () => 'blob:capture',
        now: () => clock,
    };
    return {
        opts, posted, broadcasts, statuses, audio, stream, win,
        advance(ms) { clock += ms; },
    };
}

test('buildDisplayMediaOptions asks for tab audio without voice processing', () => {
    const o = buildDisplayMediaOptions();
    assert.ok(o.video);
    assert.equal(o.audio.echoCancellation, false);
    assert.equal(o.audio.noiseSuppression, false);
    assert.equal(o.audio.autoGainControl, false);
    assert.equal(o.audio.suppressLocalAudioPlayback, false);
    assert.equal(o.systemAudio, 'include');
    assert.equal(o.selfBrowserSurface, 'exclude');
});

test('describeCaptureError maps rejections to states', () => {
    assert.equal(describeCaptureError({ name: 'NotAllowedError' }).state, 'denied');
    assert.equal(describeCaptureError({ name: 'NotSupportedError' }).state, 'unsupported');
    assert.equal(describeCaptureError({ name: 'NotReadableError' }).state, 'error');
    assert.match(describeCaptureError(new Error('boom')).message, /boom/);
});

test('reports unsupported without getDisplayMedia', async () => {
    const statuses = [];
    const result = await startDisplayAudioCapture({ windowRef: {}, mediaDevices: {}, onStatus: (s) => statuses.push(s) });
    assert.equal(result, null);
    assert.equal(statuses.at(-1).state, 'unsupported');
});

test('permission denied resolves null with a denied status', async () => {
    const h = harness({ reject: Object.assign(new Error('no'), { name: 'NotAllowedError' }) });
    assert.equal(await startDisplayAudioCapture(h.opts), null);
    assert.deepEqual(h.statuses.map((s) => s.state), ['requesting', 'denied']);
    assert.equal(h.audio.created.contexts.length, 0);
});

test('a share without an audio track stops video and reports no-audio', async () => {
    const stream = fakeStream({ audio: false });
    const h = harness({ stream });
    assert.equal(await startDisplayAudioCapture(h.opts), null);
    assert.equal(h.statuses.at(-1).state, 'no-audio');
    assert.equal(stream.all[0].stopped, true);
    assert.equal(h.audio.created.contexts.length, 0);
});

test('captures via the worklet and posts tagged stereo PCM to the opener, not the channel', async () => {
    const opener = { postMessage: (msg, origin, transfer) => h.posted.push({ msg, origin, transfer }) };
    const h = harness({ opener });
    const capture = await startDisplayAudioCapture(h.opts);
    assert.ok(capture);
    // Video dropped at once.
    assert.equal(h.stream.all[0].stopped, true);
    assert.equal(h.stream.getVideoTracks().length, 0);
    assert.equal(h.statuses.at(-1).state, 'capturing');
    assert.match(h.statuses.at(-1).message, /stereo/);

    const node = h.audio.created.workletNodes[0];
    assert.equal(node.processorName, CAPTURE_PROCESSOR_NAME);
    const block = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    node.port.onmessage({ data: block });
    node.port.onmessage({ data: new Float32Array([0.3, 0.3]) });

    assert.equal(h.posted.length, 2);
    assert.deepEqual(h.posted[0].msg, {
        type: 'pcm', buffer: block, channels: 2, sampleRate: 48000, producer: DISPLAY_CAPTURE_PRODUCER, seq: 1,
    });
    assert.equal(h.posted[1].msg.seq, 2);
    assert.equal(h.broadcasts.length, 0);
    const stats = capture.stats();
    assert.equal(stats.blocks, 2);
    assert.equal(stats.frames, 3);
    assert.equal(stats.via, 'postMessage');
    assert.equal(stats.captureKind, 'audio-worklet');
    capture.stop();
});

test('falls back to BroadcastChannel when there is no window to post to', async () => {
    const h = harness();
    const capture = await startDisplayAudioCapture(h.opts);
    h.audio.created.workletNodes[0].port.onmessage({ data: new Float32Array([0.5, 0.5]) });
    assert.equal(h.broadcasts.length, 1);
    assert.equal(h.broadcasts[0].producer, DISPLAY_CAPTURE_PRODUCER);
    assert.equal(capture.stats().via, 'broadcast');
    capture.stop();
});

test('falls back to a ScriptProcessor when AudioWorklet is unavailable', async () => {
    const parent = { postMessage: (msg) => h.posted.push({ msg }) };
    const h = harness({ worklet: false, parent });
    const capture = await startDisplayAudioCapture(h.opts);
    assert.equal(capture.stats().captureKind, 'script-processor');
    const processor = h.audio.created.scriptNodes[0];
    const left = new Float32Array([0.25, 0.5]);
    const right = new Float32Array([-0.25, -0.5]);
    processor.onaudioprocess({
        inputBuffer: { numberOfChannels: 2, length: 2, getChannelData: (ch) => (ch === 0 ? left : right) },
    });
    assert.equal(h.posted.length, 1);
    assert.deepEqual(Array.from(h.posted[0].msg.buffer), [0.25, -0.25, 0.5, -0.5]);
    assert.equal(h.posted[0].msg.producer, DISPLAY_CAPTURE_PRODUCER);
    capture.stop();
    assert.equal(processor.onaudioprocess, null);
});

test('stop() releases tracks, nodes and context, once', async () => {
    const h = harness();
    const capture = await startDisplayAudioCapture(h.opts);
    const node = h.audio.created.workletNodes[0];
    capture.stop();
    capture.stop();
    assert.equal(h.stream.all[1].stopped, true);
    assert.equal(h.audio.created.contexts[0].closed, true);
    assert.equal(node.disconnected, true);
    assert.equal(node.port.onmessage, null);
    assert.deepEqual(h.statuses.filter((s) => s.state === 'stopped').length, 1);
    // No PCM after stop.
    const before = h.broadcasts.length;
    node.port.onmessage?.({ data: new Float32Array([1, 1]) });
    assert.equal(h.broadcasts.length, before);
});

test('ending the share from the browser UI stops the capture', async () => {
    const h = harness();
    const capture = await startDisplayAudioCapture(h.opts);
    h.stream.all[1].fire('ended');
    assert.equal(h.statuses.at(-1).state, 'stopped');
    assert.match(h.statuses.at(-1).message, /browser/);
    assert.equal(h.audio.created.contexts[0].closed, true);
    capture.stop(); // idempotent: no second 'stopped'
    assert.equal(h.statuses.filter((s) => s.state === 'stopped').length, 1);
});

test('reports silence (e.g. DRM) and recovers when audio arrives', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = harness();
    const capture = await startDisplayAudioCapture(h.opts);
    h.advance(SILENCE_HINT_MS);
    t.mock.timers.tick(1000);
    assert.equal(h.statuses.at(-1).state, 'silent');
    assert.match(h.statuses.at(-1).message, /DRM/);
    h.audio.created.workletNodes[0].port.onmessage({ data: new Float32Array([0.5, 0.5]) });
    t.mock.timers.tick(1000);
    assert.equal(h.statuses.at(-1).state, 'capturing');
    capture.stop();
    await flush();
});
