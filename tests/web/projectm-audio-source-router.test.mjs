// Unit tests for html/projectm-audio-source-router.js — exclusive-source policy.
// Run with: node --test tests/web/projectm-audio-source-router.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import * as generatedWasmApi from '../../html/generated/projectm-wasm-api.js';

// `setHostAudioSourceRouter` / `playSong` live here, not in the generated WASM
// API: exclusive-source policy is host policy. An earlier revision hand-edited
// them into `generated/projectm-wasm-api.js`, which is regenerated from
// `cmake/WasmApiManifest.cmake` and silently dropped them again.
import {
    createAudioSourceRouter,
    getHostAudioSourceRouter,
    playSong,
    registerHostAudioSourceRouter,
    setHostAudioSourceRouter,
    unregisterHostAudioSourceRouter,
} from '../../html/projectm-audio-source-router.js';

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

test('autoSwitchOnFeed promotes worklet on playSong() and blocks external afterward', () => {
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

    assert.equal(playSong(module, '/music/test.wav'), true);
    assert.equal(plCalled, true);
    assert.equal(router.getActiveSource(), 'worklet');
    assert.equal(router.externalFeedGate(), false);
});

test('playSong is dropped when another source owns the ingress path', () => {
    const module = fakeModule();
    let plCalled = false;
    module.ccall = (name) => {
        if (name === 'pl') plCalled = true;
    };

    const router = createAudioSourceRouter({ module, initialSource: 'external' });
    setHostAudioSourceRouter(router);

    // Regression guard for the gate that was lost when the generated WASM API
    // was regenerated: without it, pl() double-feeds alongside external PCM.
    assert.equal(playSong(module, '/music/test.wav'), false);
    assert.equal(plCalled, false);
    assert.equal(router.getActiveSource(), 'external');
});

test('setActiveSource emits pm-audio-source-shaped status', () => {
    const router = createAudioSourceRouter({ module: fakeModule(), initialSource: 'external' });
    const status = router.getStatus();
    assert.deepEqual(status, {
        activeSource: 'external',
        streamEnabled: false,
        externalEnabled: true,
        workletAllowed: false,
    });
});

// ---- Registry: several routers on one page ----------------------------------

test('destroying one router leaves the other one registered', () => {
    setHostAudioSourceRouter(null);
    const routerA = createAudioSourceRouter({ module: fakeModule() });
    const routerB = createAudioSourceRouter({ module: fakeModule() });
    assert.equal(getHostAudioSourceRouter(), routerB, 'the newest router is the active one');

    // Used to be `setHostAudioSourceRouter(null)`, which forgot B as well.
    routerA.destroy();
    assert.equal(getHostAudioSourceRouter(), routerB);

    routerB.destroy();
    assert.equal(getHostAudioSourceRouter(), null);
});

test('destroying the newest router hands the registry back to the previous one', () => {
    setHostAudioSourceRouter(null);
    const routerA = createAudioSourceRouter({ module: fakeModule() });
    const routerB = createAudioSourceRouter({ module: fakeModule() });

    routerB.destroy();
    assert.equal(getHostAudioSourceRouter(), routerA);
    routerA.destroy();
});

test('handing a router a module or transport makes it the active one again', () => {
    setHostAudioSourceRouter(null);
    const routerA = createAudioSourceRouter({});
    const routerB = createAudioSourceRouter({});
    assert.equal(getHostAudioSourceRouter(), routerB);

    routerA.setModule(fakeModule());
    assert.equal(getHostAudioSourceRouter(), routerA);

    routerB.setTransport({ topology: 'main', callVoid() {} });
    assert.equal(getHostAudioSourceRouter(), routerB);

    routerA.destroy();
    routerB.destroy();
});

test('detaching a module from a shared router does not promote it', () => {
    setHostAudioSourceRouter(null);
    const shared = createAudioSourceRouter({ module: fakeModule() });
    const newer = createAudioSourceRouter({});
    assert.equal(getHostAudioSourceRouter(), newer);

    shared.setModule(null);
    assert.equal(getHostAudioSourceRouter(), newer, 'letting go of an engine is not activity');

    shared.destroy();
    newer.destroy();
});

test('a destroyed router does not put itself back into the registry', () => {
    setHostAudioSourceRouter(null);
    const router = createAudioSourceRouter({});
    router.destroy();

    router.setModule(fakeModule());
    router.setTransport({ topology: 'main', callVoid() {} });

    assert.equal(getHostAudioSourceRouter(), null);
    assert.equal(router.destroyed, true);
});

test('register/unregister are idempotent and unregistering an unknown router is harmless', () => {
    setHostAudioSourceRouter(null);
    const router = /** @type {any} */ ({ notifyWorkletFeed() {} });

    registerHostAudioSourceRouter(router);
    registerHostAudioSourceRouter(router);
    unregisterHostAudioSourceRouter(router);
    assert.equal(getHostAudioSourceRouter(), null, 'registering twice must not leave a second entry behind');

    unregisterHostAudioSourceRouter(router);
    unregisterHostAudioSourceRouter(/** @type {any} */ ({}));
});

test('setHostAudioSourceRouter(null) still clears every router', () => {
    createAudioSourceRouter({});
    createAudioSourceRouter({});
    setHostAudioSourceRouter(null);
    assert.equal(getHostAudioSourceRouter(), null);
});

test('playSong consults the most recently registered router', () => {
    setHostAudioSourceRouter(null);
    const module = fakeModule();
    let plCalls = 0;
    module.ccall = (name) => { if (name === 'pl') plCalls += 1; };

    const blocked = createAudioSourceRouter({ module, initialSource: 'external' });
    assert.equal(playSong(module, '/x.wav'), false);

    const open = createAudioSourceRouter({ module, autoSwitchOnFeed: true });
    assert.equal(playSong(module, '/x.wav'), true, 'the newer router decides');
    assert.equal(plCalls, 1);

    open.destroy();
    assert.equal(playSong(module, '/x.wav'), false, 'and the older one decides again once it is gone');
    blocked.destroy();
});

// ---- One router, one policy ---------------------------------------------------

test('the generated WASM API carries no host audio-source policy', () => {
    // Host policy lives in projectm-audio-source-router.js. It used to be
    // emitted by cmake/GenerateWasmLinkCommon.cmake as well, which left two
    // registries and let a regeneration wipe a hand edit. The generated pl()
    // is a plain ccall now; playSong() is the gate.
    assert.equal('setHostAudioSourceRouter' in generatedWasmApi, false);
    assert.equal('getHostAudioSourceRouter' in generatedWasmApi, false);
});

test('the generated pl() forwards without consulting any router', () => {
    const calls = [];
    const module = { ccall: (...args) => calls.push(args) };
    const router = createAudioSourceRouter({ module, initialSource: 'external' });

    generatedWasmApi.pl(module, '/music/test.wav');

    assert.deepEqual(calls, [['pl', null, ['string'], ['/music/test.wav']]]);
    assert.equal(router.getActiveSource(), 'external', 'the raw wrapper never promotes a source');
    router.destroy();
});

test('a router starts on "none", ignores a repeated source and reports the switch once', () => {
    const statuses = [];
    const router = createAudioSourceRouter({
        module: fakeModule(),
        onStatusChange: (status) => statuses.push(status.activeSource),
    });
    assert.equal(router.getActiveSource(), 'none');

    router.setActiveSource('external');
    router.setActiveSource('external');
    router.setActiveSource('element');
    router.setActiveSource('none');

    assert.deepEqual(statuses, ['external', 'element', 'none']);
    router.destroy();
});

test('canFeed is exclusive: only the active source may feed, and nothing may on "none"', () => {
    const router = createAudioSourceRouter({ module: fakeModule() });
    for (const source of ['element', 'external', 'worklet']) {
        assert.equal(router.canFeed(source), false, `none -> ${source}`);
    }

    for (const active of ['element', 'external', 'worklet']) {
        router.setActiveSource(active);
        for (const source of ['element', 'external', 'worklet']) {
            assert.equal(router.canFeed(source), source === active, `${active} active -> ${source}`);
        }
    }
    router.destroy();
});

test('status has no mode: "mix" was never implemented, so it is not offered', () => {
    const router = createAudioSourceRouter({ module: fakeModule(), initialSource: 'element' });
    assert.equal('mode' in router.getStatus(), false);
    assert.equal('mode' in router, false);
    router.destroy();
});
