// Unit tests for html/projectm-audio-source-router.js — exclusive-source policy.
// Run with: node --test tests/web/projectm-audio-source-router.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioSourceRouter } from '../../html/projectm-audio-source-router.js';
import { pl, setHostAudioSourceRouter } from '../../html/generated/projectm-wasm-api.js';

function fakeModule() {
    return {
        _stop_worklet_playback: () => {},
        _set_audio_source_to_stream: () => {},
        ccall: () => {},
    };
}

test.after(() => {
    setHostAudioSourceRouter(null);
});

test('exclusive mode blocks external PCM when element source is active', () => {
    const module = fakeModule();
    let streamEnabled = false;
    module._set_audio_source_to_stream = (value) => {
        streamEnabled = value === 1;
    };

    const router = createAudioSourceRouter({
        module,
        initialSource: 'element',
    });

    assert.equal(router.canFeed('external'), false);
    assert.equal(router.externalFeedGate(), false);
    assert.equal(streamEnabled, true);
});

test('switching from external to element stops worklet and enables stream', () => {
    const module = fakeModule();
    let workletStopped = 0;
    let streamEnabled = null;
    module._stop_worklet_playback = () => {
        workletStopped += 1;
    };
    module._set_audio_source_to_stream = (value) => {
        streamEnabled = value === 1;
    };

    const statusLog = [];
    const router = createAudioSourceRouter({
        module,
        autoSwitchOnFeed: true,
        onStatusChange: (status) => statusLog.push(status.activeSource),
    });

    assert.equal(router.externalFeedGate(), true);
    assert.equal(router.getActiveSource(), 'external');
    assert.ok(workletStopped >= 1, 'promoting external stops worklet playback');

    router.setActiveSource('element');
    assert.equal(router.getActiveSource(), 'element');
    assert.equal(router.canFeed('external'), false);
    assert.equal(streamEnabled, true);
    assert.ok(statusLog.includes('external'));
    assert.ok(statusLog.includes('element'));
});

test('autoSwitchOnFeed promotes worklet on pl() and blocks external afterward', () => {
    const module = fakeModule();
    let plCalled = false;
    module.ccall = (name) => {
        if (name === 'pl') plCalled = true;
    };

    const router = createAudioSourceRouter({
        module,
        autoSwitchOnFeed: true,
    });
    setHostAudioSourceRouter(router);

    pl(module, '/music/test.wav');
    assert.equal(plCalled, true);
    assert.equal(router.getActiveSource(), 'worklet');
    assert.equal(router.externalFeedGate(), false);
});

test('setActiveSource emits pm-audio-source-shaped status', () => {
    const router = createAudioSourceRouter({ module: fakeModule(), initialSource: 'external' });
    const status = router.getStatus();
    assert.deepEqual(status, {
        activeSource: 'external',
        mode: 'exclusive',
        streamEnabled: false,
        externalEnabled: true,
        workletAllowed: false,
    });
});
