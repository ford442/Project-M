// Unit tests for html/flac-player/projectm-pcm-bridge.js.
// Run with: node --test tests/web/flac-pcm-bridge.test.mjs
//
// Exercises the browser-independent wiring (feeder-mode detection, the sender
// contract, and the AudioNode.connect → capture node → postMessage path) with
// fake Web Audio objects so it runs without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CAPTURE_PROCESSOR_NAME,
    CAPTURE_PROCESSOR_SOURCE,
    PCM_BRIDGE_PRODUCER,
    createPcmSender,
    installProjectMPcmBridge,
    interleaveStereo,
    isProjectMFeederMode,
    resolveFeedTarget
} from '../../html/flac-player/projectm-pcm-bridge.js';

function fakeWindow({ search = '', name = '', opener = null, parent } = {}) {
    const win = { location: { search }, name, opener };
    win.parent = parent === undefined ? win : parent; // self by default (no iframe)
    return win;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

test('createPcmSender posts the tagged contract with the buffer transferred, and not to the channel', () => {
    const targetMsgs = [];
    const bcMsgs = [];
    const send = createPcmSender({
        target: { postMessage: (msg, origin, transfer) => targetMsgs.push({ msg, origin, transfer }) },
        broadcastChannel: { postMessage: (msg) => bcMsgs.push(msg) }
    });
    const buf = new Float32Array([0.1, -0.2]);
    send(buf, 2, 48000);
    send(new Float32Array([0.3, 0.4]), 2, 48000);
    assert.equal(targetMsgs.length, 2);
    assert.deepEqual(targetMsgs[0].msg, {
        type: 'pcm', buffer: buf, channels: 2, sampleRate: 48000, producer: PCM_BRIDGE_PRODUCER, seq: 1
    });
    assert.equal(targetMsgs[1].msg.seq, 2);
    assert.equal(targetMsgs[0].origin, '*');
    assert.deepEqual(targetMsgs[0].transfer, [buf.buffer]);
    // A same-origin host listens on both; sending on both doubled every block.
    assert.equal(bcMsgs.length, 0);
});

test('createPcmSender uses the BroadcastChannel only when there is no target', () => {
    const bcMsgs = [];
    const send = createPcmSender({ target: null, broadcastChannel: { postMessage: (msg) => bcMsgs.push(msg) } });
    send(new Float32Array(2), 2, 44100);
    assert.equal(bcMsgs.length, 1);
    assert.equal(bcMsgs[0].producer, PCM_BRIDGE_PRODUCER);
});

test('createPcmSender retries without a transfer list and swallows a throwing target', () => {
    const calls = [];
    const send = createPcmSender({
        target: {
            postMessage(msg, origin, transfer) {
                calls.push(transfer);
                if (transfer) throw new Error('not transferable');
            }
        }
    });
    send(new Float32Array(2), 2, 44100);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], undefined);

    const failing = createPcmSender({ target: { postMessage() { throw new Error('boom'); } } });
    assert.doesNotThrow(() => failing(new Float32Array(2), 2, 44100));
});

test('interleaveStereo interleaves, upmixes mono, and skips silence', () => {
    const stereo = {
        numberOfChannels: 2,
        length: 2,
        getChannelData: (ch) => (ch === 0 ? new Float32Array([1, 2]) : new Float32Array([3, 4]))
    };
    assert.deepEqual(Array.from(interleaveStereo(stereo)), [1, 3, 2, 4]);
    const mono = { numberOfChannels: 1, length: 2, getChannelData: () => new Float32Array([0.5, -0.5]) };
    assert.deepEqual(Array.from(interleaveStereo(mono)), [0.5, 0.5, -0.5, -0.5]);
    const silent = { numberOfChannels: 2, length: 2, getChannelData: () => new Float32Array(2) };
    assert.equal(interleaveStereo(silent), null);
});

test('the capture processor source registers under the advertised name', () => {
    assert.match(CAPTURE_PROCESSOR_SOURCE, new RegExp(`registerProcessor\\('${CAPTURE_PROCESSOR_NAME}'`));
    // Evaluate it against stand-ins to check the block / silence handling.
    let Processor = null;
    const posted = [];
    class AudioWorkletProcessor {
        constructor() {
            this.port = { postMessage: (data, transfer) => posted.push({ data, transfer }) };
        }
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', CAPTURE_PROCESSOR_SOURCE)(
        AudioWorkletProcessor,
        (name, ctor) => { Processor = ctor; }
    );
    const proc = new Processor({ processorOptions: { blockFrames: 128 } });
    const silentQuantum = [[new Float32Array(128), new Float32Array(128)]];
    proc.process(silentQuantum);
    assert.equal(posted.length, 0, 'silent blocks are not posted');
    const left = new Float32Array(128).fill(0.25);
    proc.process([[left]]); // mono input is duplicated
    assert.equal(posted.length, 1);
    assert.equal(posted[0].data.length, 256);
    assert.equal(posted[0].data[0], 0.25);
    assert.equal(posted[0].data[1], 0.25);
    assert.deepEqual(posted[0].transfer, [posted[0].data.buffer]);
    assert.equal(proc.process([[]]), true, 'no active input keeps the processor alive');
});

// A fake Web Audio graph: every node's connect() is the (patched) prototype
// method, and records its destinations.
function fakeAudioEnv({ worklet = true } = {}) {
    const proto = {
        connect(destination) {
            this.connections = this.connections || [];
            this.connections.push(destination);
            return destination;
        },
        disconnect() {
            this.disconnected = true;
        }
    };
    const makeNode = (extra = {}) => Object.assign(Object.create(proto), { context }, extra);
    const modules = [];
    const context = {
        sampleRate: 48000,
        destination: { id: 'destination' },
        createGain: () => makeNode({ gain: { value: 1 } }),
        createScriptProcessor: () => makeNode({ kind: 'script-processor' }),
        audioWorklet: worklet
            ? { addModule: async (url) => { modules.push(url); } }
            : undefined
    };
    const workletNodes = [];
    function AudioWorkletNode(ctx, name, options) {
        const node = makeNode({ kind: 'worklet', name, options, port: { onmessage: null } });
        workletNodes.push(node);
        return node;
    }
    return { proto, context, makeNode, modules, workletNodes, AudioWorkletNode };
}

function install(env, win, extra = {}) {
    return installProjectMPcmBridge({
        windowRef: win,
        audioNodeProto: env.proto,
        audioWorkletNodeCtor: env.AudioWorkletNode,
        blobCtor: function Blob(parts) { this.parts = parts; },
        createObjectURL: () => 'blob:capture',
        ...extra
    });
}

test('a node connecting to the destination is captured by an AudioWorklet and posted as stereo', async () => {
    const env = fakeAudioEnv();
    const sent = [];
    const win = fakeWindow({ opener: { postMessage: (msg) => sent.push(msg) } });
    const bridge = install(env, win);
    assert.equal(bridge.installed, true);

    const source = env.makeNode();
    source.connect(env.context.destination);
    await flush();

    // Playback is untouched; the source also feeds the capture input.
    assert.equal(source.connections[0], env.context.destination);
    const tapInput = source.connections[1];
    assert.ok(tapInput && tapInput !== env.context.destination);
    assert.equal(tapInput.channelCount, 2);
    assert.equal(tapInput.channelCountMode, 'explicit');

    assert.deepEqual(env.modules, ['blob:capture']);
    assert.equal(env.workletNodes.length, 1);
    const node = env.workletNodes[0];
    assert.equal(node.name, CAPTURE_PROCESSOR_NAME);
    assert.ok(tapInput.connections.includes(node));
    // The capture node drains into a muted gain on the destination.
    const sink = node.connections[0];
    assert.equal(sink.gain.value, 0);
    assert.deepEqual(sink.connections, [env.context.destination]);

    const block = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    node.port.onmessage({ data: block });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'pcm');
    assert.equal(sent[0].channels, 2);
    assert.equal(sent[0].sampleRate, 48000);
    assert.equal(sent[0].producer, PCM_BRIDGE_PRODUCER);
    assert.equal(sent[0].buffer, block);
    assert.deepEqual(bridge.stats(), { blocks: 1, frames: 2, sampleRate: 48000, captureKind: 'audio-worklet' });

    // A second source on the same context reuses the one capture node.
    env.makeNode().connect(env.context.destination);
    await flush();
    assert.equal(env.workletNodes.length, 1);

    bridge.uninstall();
});

test('falls back to a ScriptProcessor when the context has no AudioWorklet', async () => {
    const env = fakeAudioEnv({ worklet: false });
    const sent = [];
    const win = fakeWindow({ parent: { postMessage: (msg) => sent.push(msg) } });
    const bridge = install(env, win);

    const source = env.makeNode();
    source.connect(env.context.destination);
    await flush();
    assert.equal(bridge.stats().captureKind, 'script-processor');

    // Found through the tap input's connections.
    const processor = source.connections[1].connections.find((n) => n.kind === 'script-processor');
    assert.ok(processor, 'script processor attached behind the tap input');
    processor.onaudioprocess({
        inputBuffer: { numberOfChannels: 2, length: 1, getChannelData: (ch) => new Float32Array([ch ? 0.5 : -0.5]) }
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(Array.from(sent[0].buffer), [-0.5, 0.5]);
    bridge.uninstall();
});

test('install no-ops (and does not patch connect) when not in feeder mode', () => {
    const env = fakeAudioEnv();
    const original = env.proto.connect;
    const bridge = install(env, fakeWindow({}));
    assert.equal(bridge.installed, false);
    assert.equal(env.proto.connect, original, 'connect must be untouched in standalone mode');
});

test('uninstall restores the original connect and stops sending', async () => {
    const env = fakeAudioEnv();
    const original = env.proto.connect;
    const sent = [];
    const win = fakeWindow({ opener: { postMessage: (m) => sent.push(m) } });
    const bridge = install(env, win);
    env.makeNode().connect(env.context.destination);
    await flush();
    const node = env.workletNodes[0];
    const onmessage = node.port.onmessage;
    bridge.uninstall();
    assert.equal(env.proto.connect, original);
    assert.equal(node.disconnected, true);

    // A block already in flight from the audio thread must not be sent.
    onmessage({ data: new Float32Array(4).fill(1) });
    assert.equal(sent.length, 0);
});
