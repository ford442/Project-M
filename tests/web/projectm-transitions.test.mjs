// Unit tests for html/projectm-transitions.js: the host-side readiness polling
// that gates a dual-FBO preset transition (Phase B4 — timing / sync polish).
//
// These cover the browser half of the rapid "next preset" stress case that
// tests/libprojectM/PresetTransitionStressTest.cpp covers natively: spamming
// switches must never start more than one transition, and superseded polls must
// resolve instead of dangling.
//
// Run with: node --test tests/web/projectm-transitions.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_TRANSITION_DURATION_SEC,
    setTransitionDuration,
    startTransitionWhenReady,
} from '../../html/projectm-transitions.js';

// startTransitionWhenReady drives its poll loop through requestAnimationFrame,
// which Node does not provide. This mock queues callbacks so tests can advance
// frame by frame deterministically.
function installRequestAnimationFrame() {
    const queue = [];
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => queue.push(callback);

    return {
        pending: () => queue.length,
        /** Runs at most `maxFrames` queued callbacks, yielding to the microtask queue. */
        async advance(maxFrames = 1) {
            for (let frame = 0; frame < maxFrames && queue.length > 0; frame += 1) {
                const callback = queue.shift();
                callback();
                await Promise.resolve();
            }
        },
        restore() {
            globalThis.requestAnimationFrame = original;
        },
    };
}

/**
 * Minimal fake of the Emscripten module surface projectm-transitions.js uses.
 * `state` controls what the engine reports back to the poll loop.
 */
function fakeModule(state = {}) {
    const calls = {
        setDuration: [],
        beginTransition: 0,
        transitionStart: 0,
    };

    const module = {
        calls,
        state: {
            ready: false,
            allocated: false,
            active: false,
            beginTransitionSucceeds: true,
            ...state,
        },
        _transition_set_duration(seconds) {
            calls.setDuration.push(seconds);
        },
        _transition_is_active() {
            return module.state.active ? 1 : 0;
        },
        _dual_fbo_is_preset_b_ready() {
            return module.state.ready ? 1 : 0;
        },
        _dual_fbo_is_preset_b_allocated() {
            return module.state.allocated ? 1 : 0;
        },
        _dual_fbo_begin_transition() {
            calls.beginTransition += 1;
            if (module.state.beginTransitionSucceeds) {
                module.state.allocated = true;
                return 1;
            }
            return 0;
        },
        _transition_start() {
            calls.transitionStart += 1;
            module.state.active = true;
        },
    };

    return module;
}

test('setTransitionDuration forwards the duration and falls back on invalid input', () => {
    const module = fakeModule();

    assert.equal(setTransitionDuration(module, 2.5), true);
    assert.equal(setTransitionDuration(module, Number.NaN), true);
    assert.equal(setTransitionDuration(module, -1), true);
    assert.deepEqual(module.calls.setDuration, [2.5, DEFAULT_TRANSITION_DURATION_SEC, DEFAULT_TRANSITION_DURATION_SEC]);

    // No module at all is a no-op, not a throw.
    assert.equal(setTransitionDuration(null, 2.5), false);
});

test('startTransitionWhenReady resolves false when the dual-FBO API is missing', async () => {
    const raf = installRequestAnimationFrame();
    try {
        // A module without the transition exports (legacy build / transitions
        // compiled out) must not schedule any polling at all.
        assert.equal(await startTransitionWhenReady({ module: { _transition_set_duration() {} } }), false);
        assert.equal(raf.pending(), 0);
    } finally {
        raf.restore();
    }
});

test('startTransitionWhenReady waits for preset B, allocates it, then starts once', async () => {
    const raf = installRequestAnimationFrame();
    const module = fakeModule();
    try {
        const started = startTransitionWhenReady({ module, durationSec: 2.0 });

        // Preset B is not ready yet: several frames pass with no transition start.
        await raf.advance(5);
        assert.equal(module.calls.transitionStart, 0);
        assert.equal(module.calls.beginTransition, 0);

        // Shaders finish compiling; the next frame allocates and starts.
        module.state.ready = true;
        await raf.advance(1);

        assert.equal(await started, true);
        assert.equal(module.calls.beginTransition, 1, 'preset B must be allocated before starting');
        assert.equal(module.calls.transitionStart, 1);
        assert.deepEqual(module.calls.setDuration, [2.0]);
    } finally {
        raf.restore();
    }
});

test('startTransitionWhenReady keeps polling when allocation fails', async () => {
    const raf = installRequestAnimationFrame();
    const module = fakeModule({ ready: true, beginTransitionSucceeds: false });
    try {
        const started = startTransitionWhenReady({ module });

        await raf.advance(3);
        assert.equal(module.calls.transitionStart, 0);
        assert.equal(module.calls.beginTransition, 3, 'each frame retries allocation');

        module.state.beginTransitionSucceeds = true;
        await raf.advance(1);

        assert.equal(await started, true);
        assert.equal(module.calls.transitionStart, 1);
    } finally {
        raf.restore();
    }
});

test('startTransitionWhenReady resolves true without restarting an active transition', async () => {
    const raf = installRequestAnimationFrame();
    const module = fakeModule({ active: true, ready: true, allocated: true });
    try {
        const started = startTransitionWhenReady({ module });
        await raf.advance(1);

        assert.equal(await started, true);
        assert.equal(module.calls.transitionStart, 0, 'an in-flight transition must not be restarted');
    } finally {
        raf.restore();
    }
});

test('startTransitionWhenReady times out instead of polling forever', async () => {
    const raf = installRequestAnimationFrame();
    const module = fakeModule();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const started = startTransitionWhenReady({ module, timeoutFrames: 4 });

        await raf.advance(10);

        assert.equal(await started, false);
        assert.equal(module.calls.transitionStart, 0);
        assert.equal(raf.pending(), 0, 'polling must stop after the timeout');
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = originalWarn;
        raf.restore();
    }
});

test('100 rapid switches supersede each other and start exactly one transition', async () => {
    const raf = installRequestAnimationFrame();
    const module = fakeModule();
    try {
        // Spam "next preset" 100 times before the engine ever reports readiness —
        // the browser-side equivalent of the native rapid-switch stress test.
        const pending = [];
        for (let i = 0; i < 100; i += 1) {
            pending.push(startTransitionWhenReady({ module }));
            await raf.advance(1);
        }

        // Every superseded poll resolves false rather than dangling forever.
        const superseded = await Promise.all(pending.slice(0, -1));
        assert.deepEqual(superseded, new Array(99).fill(false));
        assert.equal(module.calls.transitionStart, 0);

        // Only the most recent request is still live, and it is the one that runs.
        module.state.ready = true;
        await raf.advance(2);

        assert.equal(await pending[pending.length - 1], true);
        assert.equal(module.calls.transitionStart, 1, 'rapid switching must never start two transitions');
        assert.equal(module.calls.beginTransition, 1);
        assert.equal(raf.pending(), 0, 'no poll loops may survive the switch storm');
    } finally {
        raf.restore();
    }
});
