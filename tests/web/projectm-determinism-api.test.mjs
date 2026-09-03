// The generated WASM API wrappers for the deterministic-capture controls
// (cmake/WasmApiManifest.cmake → html/generated/projectm-wasm-api.js).
//
// Worth testing rather than trusting the generator: the boolean arguments are
// marshalled to 0/1 by hand in the generated code, and the golden-image harness
// silently loses determinism — rather than failing — if `enabled` arrives as
// something the C++ side reads as false.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    deterministicFrameIndex,
    deterministicNowMs,
    isDeterministicClock,
    isDeterministicSeed,
    setDeterministicClock,
    setDeterministicSeed,
    setRenderLoopPaused,
} from '../../html/generated/projectm-wasm-api.js';

function stubModule(overrides = {}) {
    const calls = [];
    const module = {
        calls,
        _set_deterministic_seed: (enabled, seed) => calls.push(['seed', enabled, seed]),
        _is_deterministic_seed: () => 1,
        _set_deterministic_clock: (enabled, fps) => calls.push(['clock', enabled, fps]),
        _is_deterministic_clock: () => 0,
        _deterministic_now_ms: () => 1234.5,
        _deterministic_frame_index: () => 42,
        _set_render_loop_paused: (paused) => calls.push(['pause', paused]),
        ...overrides,
    };
    return module;
}

test('boolean arguments reach the engine as 1/0, not as booleans', () => {
    const module = stubModule();
    setDeterministicSeed(module, true, 20260901);
    setDeterministicSeed(module, false, 0);
    setDeterministicClock(module, true, 60);
    setRenderLoopPaused(module, true);
    setRenderLoopPaused(module, false);

    assert.deepEqual(module.calls, [
        ['seed', 1, 20260901],
        ['seed', 0, 0],
        ['clock', 1, 60],
        ['pause', 1],
        ['pause', 0],
    ]);
});

test('the state queries return booleans', () => {
    const module = stubModule();
    assert.equal(isDeterministicSeed(module), true);
    assert.equal(isDeterministicClock(module), false);
});

test('the clock readings pass through unchanged', () => {
    const module = stubModule();
    assert.equal(deterministicNowMs(module), 1234.5);
    assert.equal(deterministicFrameIndex(module), 42);
});
