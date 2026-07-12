// Unit tests for html/flac-player/projectm-pcm-bridge.js.
// Run with: node --test tests/web/flac-pcm-bridge.test.mjs
//
// Exercises the browser-independent wiring (feeder-mode detection, sender
// contract, and the AudioNode.connect → analyser-tap → postMessage pump) with
// fake Web Audio objects so it runs without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveFeedTarget,
    isProjectMFeederMode,
    createPcmSender,
    installProjectMPcmBridge
} from '../../html/flac-player/projectm-pcm-bridge.js';

function fakeWindow({ search = '', name = '', opener = null, parent } = {}) {
    const win = { location: { search }, name, opener };
    win.parent = parent === undefined ? win : parent; // self by default (no iframe)
    return win;
}

test('resolveFeedTarget prefers opener, then parent, else null', () => {
    const opener = {};
    const parent = {};
    assert.equal(resolveFeedTarget(fakeWindow({ opener, parent })), opener);
    assert.equal(resolveFeedTarget(fakeWindow({ parent })), parent);
    assert.equal(resolveFeedTarget(fakeWindow({})), null); // parent === self
});

test('isProjectMFeederMode detects the feeder signals', () => {
    assert.equal(isProjectMFeederMode(fakeWindow({ search: '?projectm=1' })), true);
    assert.equal(isProjectMFeederMode(fakeWindow({ name: 'flac-player' })), true);
    assert.equal(isProjectMFeederMode(fakeWindow({ name: 'mod-player' })), true);
    assert.equal(isProjectMFeederMode(fakeWindow({ opener: {} })), true);
    assert.equal(isProjectMFeederMode(fakeWindow({})), false);
});

test('createPcmSender posts the documented contract to target and BroadcastChannel', () => {
    const targetMsgs = [];
    const bcMsgs = [];
    const send = createPcmSender({
        target: { postMessage: (msg, origin) => targetMsgs.push({ msg, origin }) },
        broadcastChannel: { postMessage: (msg) => bcMsgs.push(msg) }
    });
    const buf = new Float32Array([0.1, -0.2]);
    send(buf, 1, 48000);
    assert.equal(targetMsgs.length, 1);
    assert.deepEqual(targetMsgs[0].msg, { type: 'pcm', buffer: buf, channels: 1, sampleRate: 48000 });
    assert.equal(targetMsgs[0].origin, '*');
    assert.deepEqual(bcMsgs[0], { type: 'pcm', buffer: buf, channels: 1 });
});

test('createPcmSender swallows a throwing target (non-fatal)', () => {
    const send = createPcmSender({ target: { postMessage() { throw new Error('boom'); } } });
    assert.doesNotThrow(() => send(new Float32Array(1), 1, 44100));
});

// Build a fake Web Audio environment for the install/tap test.
function fakeAudioEnv(waveform) {
    const analyser = {
        fftSize: waveform.length,
        getFloatTimeDomainData(out) { out.set(waveform.subarray(0, out.length)); }
    };
    const context = {
        sampleRate: 44100,
        destination: { id: 'destination' },
        createAnalyser() { return analyser; }
    };
    const proto = { connect(/* destination */) { this._connected = (this._connected || 0) + 1; } };
    return { analyser, context, proto };
}

test('install taps connect-to-destination and pumps PCM to the opener once per frame', () => {
    const waveform = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const { context, proto } = fakeAudioEnv(waveform);

    const sent = [];
    const opener = { postMessage: (msg) => sent.push(msg) };
    const win = fakeWindow({ opener });

    // requestFrame runs the first scheduled callback exactly once (the callback
    // reschedules itself, but we don't run the second), simulating one frame.
    const scheduled = [];
    const requestFrame = (cb) => { scheduled.push(cb); if (scheduled.length === 1) cb(); return scheduled.length; };

    const bridge = installProjectMPcmBridge({
        windowRef: win,
        audioNodeProto: proto,
        requestFrame,
        broadcastChannelCtor: undefined,
        fftSize: waveform.length
    });
    assert.equal(bridge.installed, true);
    assert.notEqual(proto.connect, undefined);

    // A source node connecting to the destination should trigger the tap+pump.
    const source = { context };
    proto.connect.call(source, context.destination);

    // Playback connection preserved (original connect called for dest + analyser tap).
    assert.ok(source._connected >= 1, 'original connect must still run for playback');
    assert.equal(sent.length, 1, 'exactly one PCM frame pumped');
    assert.equal(sent[0].type, 'pcm');
    assert.equal(sent[0].channels, 1);
    assert.equal(sent[0].sampleRate, 44100);
    assert.deepEqual(Array.from(sent[0].buffer), Array.from(waveform));

    bridge.uninstall();
});

test('install no-ops (and does not patch connect) when not in feeder mode', () => {
    const { proto } = fakeAudioEnv(new Float32Array([0]));
    const original = proto.connect;
    const win = fakeWindow({}); // no opener/parent/flag
    const bridge = installProjectMPcmBridge({ windowRef: win, audioNodeProto: proto, requestFrame: () => 0 });
    assert.equal(bridge.installed, false);
    assert.equal(proto.connect, original, 'connect must be untouched in standalone mode');
});

test('uninstall restores the original connect and stops the pump', () => {
    const waveform = new Float32Array([1, 1]);
    const { context, proto } = fakeAudioEnv(waveform);
    const original = proto.connect;
    const sent = [];
    const win = fakeWindow({ opener: { postMessage: (m) => sent.push(m) } });

    let live = null;
    const requestFrame = (cb) => { live = cb; return 1; }; // capture, don't auto-run
    const cancelFrame = () => { live = null; };

    const bridge = installProjectMPcmBridge({
        windowRef: win, audioNodeProto: proto, requestFrame, cancelFrame, fftSize: 2
    });
    proto.connect.call({ context }, context.destination); // schedules a pump (not yet run)
    bridge.uninstall();
    assert.equal(proto.connect, original);

    // Running any leftover frame callback after uninstall must not send.
    if (live) live();
    assert.equal(sent.length, 0);
});
