// projectm-context-config.js: ProjectMContextOptions → create_host_with_config()'s
// arguments, the legacy set_context_config() mapping, and the one create call
// both topologies make.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    CONTEXT_CONFIG_FLAGS,
    createConfiguredHost,
    legacyContextConfigArgs,
    resolveFlashLimit,
    resolveWasmContextConfig,
} from '../../html/projectm-context-config.js';

const F = CONTEXT_CONFIG_FLAGS;

test('defaults: WebGL alpha and premultipliedAlpha on, everything else off, high-performance, RGBA16F', () => {
    assert.deepEqual(resolveWasmContextConfig(), {
        flags: F.contextAlpha | F.premultipliedAlpha,
        powerPreference: 2,
        fboPrecision: 0,
    });
    assert.deepEqual(resolveWasmContextConfig({}), resolveWasmContextConfig());
});

test('the alpha option is a CSS hint: it never decides the WebGL alpha bit', () => {
    // alpha: true used to be read as "the page wants a transparent context";
    // the WebGL bit is contextAlpha, and alpha alone changes nothing.
    assert.equal(resolveWasmContextConfig({ alpha: true }).flags, resolveWasmContextConfig({ alpha: false }).flags);
    assert.equal(resolveWasmContextConfig({ alpha: true, contextAlpha: false }).flags & F.contextAlpha, 0);
    assert.notEqual(resolveWasmContextConfig({ alpha: false, contextAlpha: true }).flags & F.contextAlpha, 0);
});

test('each boolean option sets exactly its own bit', () => {
    const base = resolveWasmContextConfig().flags;
    /** @type {Array<[string, boolean, number]>} */
    const cases = [
        ['antialias', true, F.antialias],
        ['preserveDrawingBuffer', true, F.preserveDrawingBuffer],
        ['depth', true, F.depth],
        ['stencil', true, F.stencil],
        ['contextAlpha', false, F.contextAlpha],
        ['premultipliedAlpha', false, F.premultipliedAlpha],
        ['failIfMajorPerformanceCaveat', true, F.failIfMajorPerformanceCaveat],
        ['explicitSwapControl', true, F.explicitSwapControl],
        ['desynchronized', true, F.desynchronized],
    ];
    for (const [option, value, bit] of cases) {
        const { flags } = resolveWasmContextConfig({ [option]: value });
        assert.equal(flags ^ base, bit, `${option}: ${value} must toggle only its own bit`);
    }
});

test('presentMode manual is the explicitSwapControl bit; browser (the default) is not', () => {
    const base = resolveWasmContextConfig().flags;
    assert.equal(resolveWasmContextConfig({ presentMode: 'manual' }).flags ^ base, F.explicitSwapControl);
    assert.equal(resolveWasmContextConfig({ presentMode: 'browser' }).flags, base);
    assert.equal(
        resolveWasmContextConfig({ presentMode: 'browser', explicitSwapControl: true }).flags,
        resolveWasmContextConfig({ presentMode: 'manual' }).flags,
        'either spelling asks for manual present',
    );
});

test('resolveFlashLimit: off unless asked, threshold only when it is a number', () => {
    assert.equal(resolveFlashLimit(), null);
    assert.equal(resolveFlashLimit({ flashLimit: false }), null);
    assert.deepEqual(resolveFlashLimit({ flashLimit: true }), { enabled: true });
    assert.deepEqual(resolveFlashLimit({ flashLimit: {} }), { enabled: true });
    assert.deepEqual(resolveFlashLimit({ flashLimit: { threshold: 0.04 } }), { enabled: true, threshold: 0.04 });
    assert.deepEqual(resolveFlashLimit({ flashLimit: { threshold: Number.NaN } }), { enabled: true });
});

test('powerPreference and fboPrecision map to the C++ numbering, unknown values to the defaults', () => {
    assert.equal(resolveWasmContextConfig({ powerPreference: 'default' }).powerPreference, 0);
    assert.equal(resolveWasmContextConfig({ powerPreference: 'low-power' }).powerPreference, 1);
    assert.equal(resolveWasmContextConfig({ powerPreference: 'high-performance' }).powerPreference, 2);
    assert.equal(resolveWasmContextConfig({ powerPreference: /** @type {any} */ ('turbo') }).powerPreference, 2);
    // FboFloatFormat, as dual_fbo_get_format() reports it.
    assert.equal(resolveWasmContextConfig({ fboPrecision: 'half' }).fboPrecision, 0);
    assert.equal(resolveWasmContextConfig({ fboPrecision: 'high' }).fboPrecision, 1);
    assert.equal(resolveWasmContextConfig({ fboPrecision: 'byte' }).fboPrecision, 2);
    assert.equal(resolveWasmContextConfig({ fboPrecision: /** @type {any} */ ('quad') }).fboPrecision, 0);
});

test('the flag bits match WasmContextConfigFlag in WasmWebGLContext.hpp', () => {
    const header = readFileSync(new URL('../../src/wasm/WasmWebGLContext.hpp', import.meta.url), 'utf8');
    /** @type {Record<string, string>} C++ enumerator → JS key */
    const names = {
        kContextFlagAntialias: 'antialias',
        kContextFlagPreserveDrawingBuffer: 'preserveDrawingBuffer',
        kContextFlagDepth: 'depth',
        kContextFlagStencil: 'stencil',
        kContextFlagAlpha: 'contextAlpha',
        kContextFlagPremultipliedAlpha: 'premultipliedAlpha',
        kContextFlagFailIfMajorPerformanceCaveat: 'failIfMajorPerformanceCaveat',
        kContextFlagExplicitSwapControl: 'explicitSwapControl',
        kContextFlagDesynchronized: 'desynchronized',
    };
    const found = [...header.matchAll(/(kContextFlag\w+)\s*=\s*1\s*<<\s*(\d+)/g)];
    assert.equal(found.length, Object.keys(names).length, 'every C++ flag has a JS counterpart');
    for (const [, cxxName, shift] of found) {
        const key = names[cxxName];
        assert.ok(key, `${cxxName} is not mapped`);
        assert.equal(/** @type {any} */ (F)[key], 1 << Number(shift), `${cxxName} / ${key}`);
    }
});

test('legacyContextConfigArgs produces set_context_config()\'s seven arguments', () => {
    const config = resolveWasmContextConfig({ antialias: true, stencil: true, powerPreference: 'low-power', fboPrecision: 'byte' });
    assert.deepEqual(legacyContextConfigArgs(config), [1, 0, 0, 1, 1, 1, 2]);
});

/** @param {Record<string, unknown>} [extra] */
function recordingModule(extra = {}) {
    /** @type {Array<[string, unknown[]]>} */
    const calls = [];
    const module = {
        calls,
        ccall: (/** @type {string} */ name, /** @type {unknown} */ _r, /** @type {unknown} */ _t, /** @type {unknown[]} */ args) => {
            calls.push([name, args]);
            return name.startsWith('create_host') ? 11 : name === 'init_with_canvases' ? 0 : undefined;
        },
        ...extra,
    };
    return /** @type {any} */ (module);
}

test('createConfiguredHost passes the config with the create call when the bundle has the export', () => {
    const module = recordingModule({ _create_host_with_config: () => 0, _get_last_init_error: () => 0 });
    const config = resolveWasmContextConfig({ antialias: true, fboPrecision: 'high' });
    const result = createConfiguredHost(module, { primary: '#a', secondary: '#b', config, create: 'init' });
    assert.deepEqual(result, { handle: 11, code: 0 });
    assert.deepEqual(module.calls, [['create_host_with_config', ['#a', '#b', config.flags, 2, 1]]]);
});

test('createConfiguredHost reports get_last_init_error() when the create fails', () => {
    const module = recordingModule({ _create_host_with_config: () => 0, _get_last_init_error: () => 8 });
    module.ccall = () => 0;
    const result = createConfiguredHost(module, {
        primary: '#a', secondary: '#b', config: resolveWasmContextConfig({ failIfMajorPerformanceCaveat: true }),
    });
    assert.deepEqual(result, { handle: 0, code: 8 });
});

test('on an older bundle the owned-Module path keeps set_context_config + init_with_canvases', () => {
    const module = recordingModule();
    const result = createConfiguredHost(module, {
        primary: '#a', secondary: '#b', config: resolveWasmContextConfig({ depth: true }), create: 'init',
    });
    assert.deepEqual(result, { handle: 0, code: 0 });
    assert.deepEqual(module.calls.map(([name]) => name), ['set_context_config', 'init_with_canvases']);
});
