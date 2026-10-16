import assert from 'node:assert/strict';
import test from 'node:test';
import { claimGlobal, countGlobalClaims } from '../../html/projectm-globals.js';
import {
    WASM_CALLBACK_NAMES,
    countWasmCallbackSubscribers,
    decodeWasmCallback,
    subscribeWasmCallback,
} from '../../html/projectm-wasm-callbacks.js';

// ---- claimGlobal ------------------------------------------------------------

test('claimGlobal publishes the value and removes a slot it created', () => {
    const host = {};
    const release = claimGlobal(host, 'hook', 'a');
    assert.equal(host.hook, 'a');
    assert.equal(countGlobalClaims(host, 'hook'), 1);

    release();
    assert.equal('hook' in host, false, 'a slot the host never had must not linger as undefined');
    assert.equal(countGlobalClaims(host, 'hook'), 0);
});

test('claimGlobal restores the value the host had before the first claim', () => {
    const host = { hook: 'original' };
    const release = claimGlobal(host, 'hook', 'a');
    assert.equal(host.hook, 'a');
    release();
    assert.equal(host.hook, 'original');
});

test('releasing the older of two claims leaves the newer one in place', () => {
    const host = {};
    const releaseA = claimGlobal(host, 'hook', 'a');
    const releaseB = claimGlobal(host, 'hook', 'b');
    assert.equal(host.hook, 'b', 'the newest claim is the visible one');

    releaseA();
    assert.equal(host.hook, 'b', 'destroying A must not touch the slot B is using');

    releaseB();
    assert.equal('hook' in host, false);
});

test('releasing the newer claim hands the slot back to the older one', () => {
    const host = {};
    const releaseA = claimGlobal(host, 'hook', 'a');
    const releaseB = claimGlobal(host, 'hook', 'b');

    releaseB();
    assert.equal(host.hook, 'a');

    releaseA();
    assert.equal('hook' in host, false);
});

test('a release never overwrites a value someone else assigned directly', () => {
    const host = {};
    const release = claimGlobal(host, 'hook', 'mine');
    host.hook = 'theirs';

    release();
    assert.equal(host.hook, 'theirs');
});

test('release is idempotent and cannot revoke a later claim of the same value', () => {
    const host = {};
    const first = claimGlobal(host, 'hook', 'same');
    first();
    const second = claimGlobal(host, 'hook', 'same');

    first();
    assert.equal(host.hook, 'same', 'a stale release must not drop the live claim');
    assert.equal(countGlobalClaims(host, 'hook'), 1);

    second();
    assert.equal(countGlobalClaims(host, 'hook'), 0);
});

test('claims on different keys and different hosts are independent', () => {
    const hostA = {};
    const hostB = {};
    const releaseA = claimGlobal(hostA, 'hook', 1);
    const releaseB = claimGlobal(hostB, 'hook', 2);
    const releaseOther = claimGlobal(hostA, 'other', 3);

    releaseA();
    assert.equal(hostB.hook, 2);
    assert.equal(hostA.other, 3);

    releaseB();
    releaseOther();
});

// ---- WASM callback bus ------------------------------------------------------

test('the callback list names what the engine actually looks up', () => {
    assert.ok(WASM_CALLBACK_NAMES.includes('pmOnGovernorRenderScaleChange'));
    assert.ok(WASM_CALLBACK_NAMES.includes('pmOnPerfFrame'));
    assert.ok(Object.isFrozen(WASM_CALLBACK_NAMES));
});

test('the first subscriber installs the global and every subscriber hears the engine', () => {
    const host = {};
    const seenA = [];
    const seenB = [];

    const offA = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => seenA.push(scale), host);
    const offB = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => seenB.push(scale), host);
    assert.equal(typeof host.pmOnGovernorRenderScaleChange, 'function');
    assert.equal(countWasmCallbackSubscribers('pmOnGovernorRenderScaleChange', host), 2);

    host.pmOnGovernorRenderScaleChange(7, 0.75);
    assert.deepEqual(seenA, [0.75]);
    assert.deepEqual(seenB, [0.75]);

    offA();
    offB();
});

test('unsubscribing one context leaves the other one subscribed', () => {
    const host = {};
    const seenB = [];
    const offA = subscribeWasmCallback('pmOnGovernorRenderScaleChange', () => {}, host);
    const offB = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => seenB.push(scale), host);

    offA();
    assert.equal(typeof host.pmOnGovernorRenderScaleChange, 'function', 'B still needs the global');
    host.pmOnGovernorRenderScaleChange(0, 0.5);
    assert.deepEqual(seenB, [0.5]);

    offB();
    assert.equal('pmOnGovernorRenderScaleChange' in host, false, 'the last subscriber removes the global');
});

test('a throwing subscriber does not starve the others', () => {
    const host = {};
    const seen = [];
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        const offBad = subscribeWasmCallback('pmOnPerfFrame', () => { throw new Error('boom'); }, host);
        const offGood = subscribeWasmCallback('pmOnPerfFrame', (stats) => seen.push(stats), host);

        host.pmOnPerfFrame({ host: 0, fps: 60 });
        assert.deepEqual(seen, [{ host: 0, fps: 60 }]);
        assert.equal(errors.length, 1);

        offBad();
        offGood();
    } finally {
        console.error = originalError;
    }
});

test('subscribing the same function twice is two subscriptions', () => {
    const host = {};
    let calls = 0;
    const listener = () => { calls += 1; };
    const off1 = subscribeWasmCallback('pmOnGovernorBlurCapChange', listener, host);
    const off2 = subscribeWasmCallback('pmOnGovernorBlurCapChange', listener, host);

    host.pmOnGovernorBlurCapChange(2);
    assert.equal(calls, 2);

    off1();
    host.pmOnGovernorBlurCapChange(2);
    assert.equal(calls, 3, 'the second subscription survives the first one leaving');

    off2();
});

test('a listener may unsubscribe itself while it runs', () => {
    const host = {};
    const seen = [];
    let offSelf = () => {};
    offSelf = subscribeWasmCallback('pmOnGovernorTierChange', () => { seen.push('self'); offSelf(); }, host);
    const offOther = subscribeWasmCallback('pmOnGovernorTierChange', () => seen.push('other'), host);

    host.pmOnGovernorTierChange(1);
    host.pmOnGovernorTierChange(1);
    assert.deepEqual(seen, ['self', 'other', 'other']);

    offOther();
});

// ---- which engine (bundle 040+) ---------------------------------------------

test('every positional callback decodes the same from the 040 shape and the pre-040 shape', () => {
    // [name, payload as the engine passes it after the handle, decoded fields]
    const cases = [
        ['pmOnGovernorTierChange', [2], { tier: 2 }],
        ['pmOnGovernorRenderScaleChange', [0.5], { scale: 0.5 }],
        ['pmOnGovernorBlurCapChange', [1], { cap: 1 }],
        ['pmSetPerfHudEnabled', [true], { enabled: true }],
        ['pmOnTranspiledShaderStored', ['preset-key', 1, 'void main(){}'], { key: 'preset-key', kind: 1, glsl: 'void main(){}' }],
        ['pmReportInitError', [6, 'Primary canvas selector not found'], { code: 6, detail: 'Primary canvas selector not found' }],
        ['pmHideInitError', [], {}],
    ];
    for (const [name, payload, fields] of cases) {
        assert.ok(WASM_CALLBACK_NAMES.includes(name), name);
        assert.deepEqual(decodeWasmCallback(name, [123456, ...payload]), { host: 123456, ...fields }, `${name}, 040 shape`);
        assert.deepEqual(decodeWasmCallback(name, payload), { host: null, ...fields }, `${name}, pre-040 shape`);
    }
});

test('the two object callbacks keep their object and gain host: null when it is missing', () => {
    const stats = { host: 0, fps: 60 };
    assert.equal(decodeWasmCallback('pmOnPerfFrame', [stats]), stats, 'a 040 frame is passed through, not copied');
    assert.deepEqual(decodeWasmCallback('pmOnPerfFrame', [{ fps: 60 }]), { host: null, fps: 60 });
    assert.deepEqual(decodeWasmCallback('pmOnRhythmEvent', [{ host: 9, beat: true }]), { host: 9, beat: true });
});

test('an engineHost filter hears its own engine only', () => {
    const host = {};
    const seenA = [];
    const seenB = [];
    const seenAll = [];
    const offA = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => seenA.push(scale), host, { engineHost: 11 });
    const offB = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => seenB.push(scale), host, { engineHost: 12 });
    const offAll = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ host: engine, scale }) => seenAll.push([engine, scale]), host);

    host.pmOnGovernorRenderScaleChange(11, 0.75);
    host.pmOnGovernorRenderScaleChange(12, 0.5);
    assert.deepEqual(seenA, [0.75]);
    assert.deepEqual(seenB, [0.5]);
    assert.deepEqual(seenAll, [[11, 0.75], [12, 0.5]], 'no filter: every engine');

    offA();
    offB();
    offAll();
});

test('engineHost 0 is the default host, not "any"', () => {
    const host = {};
    const seen = [];
    const off = subscribeWasmCallback('pmOnGovernorTierChange', ({ tier }) => seen.push(tier), host, { engineHost: 0 });
    host.pmOnGovernorTierChange(0, 1);
    host.pmOnGovernorTierChange(77, 2);
    host.pmOnGovernorTierChange(-1, 2);
    assert.deepEqual(seen, [1]);
    off();
});

test('a pre-040 bundle (no handle) still reaches filtered listeners, as it did before', () => {
    const host = {};
    const seen = [];
    const off = subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ host: engine, scale }) => seen.push([engine, scale]), host, { engineHost: 11 });
    host.pmOnGovernorRenderScaleChange(0.5);
    assert.deepEqual(seen, [[null, 0.5]]);
    off();
});

test('a page that overwrote the global keeps its value when the last subscriber leaves', () => {
    const host = {};
    const off = subscribeWasmCallback('pmOnPerfFrame', () => {}, host);
    const pageHook = () => {};
    host.pmOnPerfFrame = pageHook;

    off();
    assert.equal(host.pmOnPerfFrame, pageHook);
});
