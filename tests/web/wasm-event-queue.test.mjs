// The page-event queue (src/wasm/WasmEvents.cpp, ABI v2 #352 B), run from its
// own EM_JS bodies.
//
// Every engine-to-page callback (pmOnPerfFrame, pmOnRhythmEvent,
// pmOnGovernor*, pmOnPresetSwitchFailed, pmReportInitError, pmHideInitError,
// pmSetPerfHudEnabled, pmOnTranspiledShaderStored, updatePresetDisplay,
// pmOnLog) hands its handler to Module.pmEventQueue, and the engine drains the
// queue once no engine code is on the stack. What a handler may then do is the
// contract these pin: call back into the engine (its own events land in the
// same pass, after the ones already queued), destroy the host (its remaining
// events are dropped), or throw (the rest still run). The browser side, with a
// real engine, is tests/wasm-smoke/host_churn.html's handler-destroys-host case.
//
// Run with: node --test tests/web/wasm-event-queue.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractEmJs, stripJsComments } from './helpers/em-js.mjs';

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/wasm');
const blocks = readdirSync(wasmDir)
    .filter((file) => file.endsWith('.cpp'))
    .flatMap((file) => extractEmJs(readFileSync(join(wasmDir, file), 'utf8'))
        .map((block) => ({ ...block, file, body: stripJsComments(block.body) })));

/** An EM_JS body as a function of its C++ parameters, with `runtime` in scope. */
function compile(name, runtime) {
    const block = blocks.find((candidate) => candidate.name === name);
    assert.ok(block, `${name} not found`);
    const helpers = Object.keys(runtime);
    return new Function(...helpers, ...block.params, block.body).bind(null, ...helpers.map((key) => runtime[key]));
}

/** A Module with the queue installed, and the drain/drop the engine calls. */
function moduleWithQueue() {
    const Module = {};
    compile('js_event_queue_install', { Module })();
    return {
        Module,
        drain: compile('js_event_queue_drain', { Module }),
        drop: compile('js_event_queue_drop', { Module }),
    };
}

const runtime = (Module) => ({ Module, UTF8ToString: (text) => text, console: { log() {}, warn() {}, error() {} } });

/** Runs `fn` with `globalThis` properties set, then puts every one back. */
function withGlobals(overrides, fn) {
    const saved = new Map();
    for (const key of Object.keys(overrides)) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: overrides[key] });
    }
    try {
        return fn();
    } finally {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

// The page callbacks, each as the engine raises it: [EM_JS name, its arguments, the global it calls].
const NOTIFICATIONS = [
    ['js_perf_hud_set_enabled', [5, 1], 'pmSetPerfHudEnabled'],
    ['js_perf_report_frame', [5, 16, 1, 1, 1, 1, 1, 1, -1, 60, 0, 1, 0, -1], 'pmOnPerfFrame'],
    ['js_governor_report_tier', [5, 2], 'pmOnGovernorTierChange'],
    ['js_governor_report_render_scale', [5, 0.5], 'pmOnGovernorRenderScaleChange'],
    ['js_governor_report_blur_cap', [5, 1], 'pmOnGovernorBlurCapChange'],
    ['js_report_rhythm_event', [5, 1, 120, 4, 0.5, 0, 0.9], 'pmOnRhythmEvent'],
    ['js_report_preset_switch_failed', [5, 'a.milk', 'boom'], 'pmOnPresetSwitchFailed'],
    ['js_notify_init_error', [5, 2, 'no webgl2'], 'pmReportInitError'],
    ['js_notify_init_success', [5], 'pmHideInitError'],
    ['js_on_transpiled_shader_stored', [5, 'key', 0, 'glsl'], 'pmOnTranspiledShaderStored'],
    ['js_update_preset_name', [5, 'a.milk'], 'updatePresetDisplay'],
    ['js_log_message', [3, 'hello'], 'pmOnLog'],
];

test('every page notification queues its handler instead of calling it', () => {
    for (const [name, args, global] of NOTIFICATIONS) {
        const { Module, drain } = moduleWithQueue();
        const calls = [];
        withGlobals({ [global]: (...received) => calls.push(received) }, () => {
            compile(name, runtime(Module))(...args);
            assert.equal(calls.length, 0, `${name}: the handler ran while the engine was still on the stack`);
            drain();
            assert.equal(calls.length, 1, `${name}: the drain did not deliver it`);
        });
    }
});

test('without a queue (a pthread, or an old glue) each notification delivers at once', () => {
    for (const [name, args, global] of NOTIFICATIONS) {
        const calls = [];
        withGlobals({ [global]: (...received) => calls.push(received) }, () => {
            compile(name, runtime({}))(...args);
        });
        assert.equal(calls.length, 1, name);
    }
});

test('values are read when the event is raised, not when it is delivered', () => {
    const { Module, drain } = moduleWithQueue();
    const memory = { text: 'first' };
    const read = { UTF8ToString: () => memory.text, Module };
    const seen = [];
    withGlobals({ pmOnTranspiledShaderStored: (...args) => seen.push(args) }, () => {
        compile('js_on_transpiled_shader_stored', read)(5, 0, 1, 0);
        memory.text = 'freed and reused';
        drain();
    });
    assert.deepEqual(seen, [[5, 'first', 1, 'first']]);
});

test('the queue delivers in order, and what a handler raises lands in the same pass', () => {
    const { Module, drain } = moduleWithQueue();
    const order = [];
    const queue = Module.pmEventQueue;
    queue.post(1, () => {
        order.push('a');
        // A handler calls an export, which raises an event and drains on return:
        // that inner drain must not run the rest of the queue out of order.
        queue.post(1, () => order.push('c'));
        drain();
    });
    queue.post(2, () => order.push('b'));
    drain();
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(queue.items.length, 0);
});

test('destroying a host drops its pending events, and no other host\'s', () => {
    const { Module, drain, drop } = moduleWithQueue();
    const order = [];
    const queue = Module.pmEventQueue;
    queue.post(1, () => {
        order.push('1:first');
        drop(1); // the handler called destroy_host(1)
    });
    queue.post(1, () => order.push('1:second'));
    queue.post(2, () => order.push('2'));
    queue.post(null, () => order.push('log'));
    drain();
    assert.deepEqual(order, ['1:first', '2', 'log']);
});

test('a handler that throws is reported and the rest still run', () => {
    const { Module, drain } = moduleWithQueue();
    const reported = [];
    const queue = Module.pmEventQueue;
    const delivered = [];
    queue.post(1, () => { throw new Error('page bug'); });
    queue.post(1, () => delivered.push('next'));
    const consoleError = console.error;
    console.error = (...args) => reported.push(args);
    try {
        drain();
    } finally {
        console.error = consoleError;
    }
    assert.deepEqual(delivered, ['next']);
    assert.equal(reported.length, 1);
    assert.equal(queue.draining, false, 'a throw does not leave the queue stuck');
});

test('installing twice keeps the first queue and its pending events', () => {
    const { Module, drain } = moduleWithQueue();
    const delivered = [];
    Module.pmEventQueue.post(1, () => delivered.push(1));
    compile('js_event_queue_install', { Module })();
    drain();
    assert.deepEqual(delivered, [1]);
});
