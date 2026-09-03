// Unit tests for html/projectm-audio-element-source.js — the media-element
// producer. An <audio>/<video> element now reaches the engine as
// MediaElementAudioSourceNode → the shared AudioWorkletNode → the PCM ring,
// replacing the AnalyserNode that the WASM render loop used to poll.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    connectMediaElement,
    disconnectMediaElement,
    installMediaElementSourceHook,
    resetMediaElementSourcesForTests,
} from '../../html/projectm-audio-element-source.js';

class FakeSourceNode {
    constructor(element) {
        this.element = element;
        this.connections = [];
        this.disconnects = 0;
    }
    connect(node) {
        this.connections.push(node);
    }
    disconnect() {
        this.disconnects += 1;
    }
}

function fakeAudioContext({ throwOnCreate = false } = {}) {
    return {
        created: [],
        createMediaElementSource(element) {
            if (throwOnCreate) throw new Error('already connected');
            const node = new FakeSourceNode(element);
            this.created.push(node);
            return node;
        },
    };
}

function fakeElement(id = 'track') {
    return { id, nodeName: 'AUDIO' };
}

function fakeDocument(map) {
    return { querySelector: (selector) => map[selector] ?? null };
}

test('connectMediaElement wires the element into the worklet node', () => {
    const element = fakeElement();
    const audioContext = fakeAudioContext();
    const workletNode = { name: 'worklet' };

    assert.equal(connectMediaElement(element, { audioContext, workletNode }), true);
    assert.equal(audioContext.created.length, 1);
    assert.deepEqual(audioContext.created[0].connections, [workletNode]);

    resetMediaElementSourcesForTests(element);
});

test('connectMediaElement resolves a CSS selector against the document', () => {
    const element = fakeElement();
    const documentRef = fakeDocument({ '#track': element });
    const audioContext = fakeAudioContext();
    const workletNode = { name: 'worklet' };

    assert.equal(
        connectMediaElement('#track', { audioContext, workletNode, documentRef }),
        true
    );
    assert.equal(audioContext.created[0].element, element);

    resetMediaElementSourcesForTests(element);
});

test('connectMediaElement reuses the source node for an element it already wrapped', () => {
    // createMediaElementSource() throws on a second call for the same element,
    // so reconnecting after a source switch must go through the cached node.
    const element = fakeElement();
    const audioContext = fakeAudioContext();
    const first = { name: 'worklet-a' };
    const second = { name: 'worklet-b' };

    assert.equal(connectMediaElement(element, { audioContext, workletNode: first }), true);
    assert.equal(connectMediaElement(element, { audioContext, workletNode: second }), true);
    assert.equal(audioContext.created.length, 1, 'only one source node per element');
    assert.deepEqual(audioContext.created[0].connections, [first, second]);

    resetMediaElementSourcesForTests(element);
});

test('connectMediaElement reports failure rather than throwing when nothing is ready', () => {
    const element = fakeElement();
    assert.equal(connectMediaElement(element, { audioContext: undefined, workletNode: {} }), false);
    assert.equal(connectMediaElement(element, { audioContext: fakeAudioContext(), workletNode: undefined }), false);
    assert.equal(
        connectMediaElement('#missing', {
            audioContext: fakeAudioContext(),
            workletNode: {},
            documentRef: fakeDocument({}),
        }),
        false
    );

    const audioContext = fakeAudioContext({ throwOnCreate: true });
    assert.equal(connectMediaElement(element, { audioContext, workletNode: {} }), false);

    resetMediaElementSourcesForTests(element);
});

test('disconnectMediaElement disconnects a connected element and no-ops otherwise', () => {
    const element = fakeElement();
    const audioContext = fakeAudioContext();
    connectMediaElement(element, { audioContext, workletNode: {} });

    assert.equal(disconnectMediaElement(element), true);
    assert.equal(audioContext.created[0].disconnects, 1);
    assert.equal(disconnectMediaElement(fakeElement('other')), false, 'never connected');

    resetMediaElementSourcesForTests(element);
});

test('installMediaElementSourceHook gives the WASM export a host implementation', () => {
    const element = fakeElement();
    const audioContext = fakeAudioContext();
    const workletNode = { name: 'worklet' };
    globalThis.projectMWorkletNode_Global_Cpp = workletNode;
    globalThis.document = fakeDocument({ '#track': element });
    try {
        installMediaElementSourceHook();
        assert.equal(typeof globalThis.projectMConnectMediaElement, 'function');
        // The hook resolves the AudioContext through the bootstrap module, which
        // has none here, so this reports failure without throwing — the EM_JS
        // caller treats that as "not connected" and retries later.
        assert.equal(globalThis.projectMConnectMediaElement('#track'), false);
        assert.equal(audioContext.created.length, 0);
    } finally {
        delete globalThis.projectMConnectMediaElement;
        delete globalThis.projectMWorkletNode_Global_Cpp;
        delete globalThis.document;
        resetMediaElementSourcesForTests(element);
    }
});
