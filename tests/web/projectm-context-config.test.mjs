// projectm-context-config.js: ProjectMContextOptions → create_host_with_config()'s
// arguments, the legacy set_context_config() mapping, and the one create call
// both topologies make.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    CONTEXT_CONFIG_FLAGS,
    CONTEXT_SNAPSHOT_ATTRIBUTES_MASK,
    CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT,
    CONTEXT_SNAPSHOT_BITS,
    CONTEXT_SNAPSHOT_FORMAT_MASK,
    CONTEXT_SNAPSHOT_FORMAT_SHIFT,
    CONTEXT_SNAPSHOT_POWER_MASK,
    CONTEXT_SNAPSHOT_POWER_SHIFT,
    contextAttributeMismatches,
    createConfiguredHost,
    decodeContextAttributes,
    decodeContextSnapshot,
    legacyContextConfigArgs,
    resolveFlashLimit,
    resolveWasmContextConfig,
} from '../../html/projectm-context-config.js';

const F = CONTEXT_CONFIG_FLAGS;

test('defaults: an opaque canvas (WebGL alpha off), premultipliedAlpha on, everything else off, high-performance, RGBA16F', () => {
    assert.deepEqual(resolveWasmContextConfig(), {
        flags: F.premultipliedAlpha,
        powerPreference: 2,
        fboPrecision: 0,
    });
    assert.deepEqual(resolveWasmContextConfig({}), resolveWasmContextConfig());
});

test('a transparent context asks for WebGL alpha unless contextAlpha says otherwise', () => {
    assert.notEqual(resolveWasmContextConfig({ transparent: true }).flags & F.contextAlpha, 0);
    assert.equal(resolveWasmContextConfig({ transparent: false }).flags & F.contextAlpha, 0);
    // A host that toggles transparency at runtime asks for the alpha channel up front...
    assert.notEqual(resolveWasmContextConfig({ transparent: false, contextAlpha: true }).flags & F.contextAlpha, 0);
    // ...and contextAlpha: false is honoured even for a transparent context.
    assert.equal(resolveWasmContextConfig({ transparent: true, contextAlpha: false }).flags & F.contextAlpha, 0);
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
        ['contextAlpha', true, F.contextAlpha],
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
    assert.deepEqual(legacyContextConfigArgs(config), [1, 0, 0, 1, 0, 1, 2]);
    assert.equal(legacyContextConfigArgs(resolveWasmContextConfig({ transparent: true }))[4], 1);
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

// ---- get_context_snapshot() ---------------------------------------------------------

/**
 * Packs a snapshot the way get_context_snapshot() does, from the exported layout.
 * `attributes` (flags) and `power` are the context's real ones; leaving
 * `attributes` out packs a snapshot from a bundle that does not report them.
 *
 * @param {{ valid?: boolean, floatColorBuffer?: boolean, floatBlend?: boolean, loseContext?: boolean, format?: number, attributes?: number, power?: number }} [fields]
 */
function packSnapshot({ valid = true, floatColorBuffer = false, floatBlend = false, loseContext = false, format = 0, attributes, power = 2 } = {}) {
    const b = CONTEXT_SNAPSHOT_BITS;
    return (valid ? b.valid : 0)
        | (floatColorBuffer ? b.floatColorBuffer : 0)
        | (floatBlend ? b.floatBlend : 0)
        | (loseContext ? b.loseContext : 0)
        | (format << CONTEXT_SNAPSHOT_FORMAT_SHIFT)
        | (attributes === undefined
            ? 0
            : b.attributesKnown | (power << CONTEXT_SNAPSHOT_POWER_SHIFT) | (attributes << CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT));
}

test('the snapshot layout matches WasmContextSnapshotBit and the format field in WasmWebGLContext.hpp', () => {
    const header = readFileSync(new URL('../../src/wasm/WasmWebGLContext.hpp', import.meta.url), 'utf8');
    /** @type {Record<string, keyof typeof CONTEXT_SNAPSHOT_BITS>} C++ enumerator → JS key */
    const names = {
        kSnapshotValid: 'valid',
        kSnapshotFloatColorBuffer: 'floatColorBuffer',
        kSnapshotFloatBlend: 'floatBlend',
        kSnapshotLoseContext: 'loseContext',
        kSnapshotAttributesKnown: 'attributesKnown',
    };
    const found = [...header.matchAll(/(kSnapshot(?!Format)\w+)\s*=\s*1\s*<<\s*(\d+)/g)];
    assert.equal(found.length, Object.keys(names).length, 'every C++ snapshot bit has a JS counterpart');
    for (const [, cxxName, shift] of found) {
        const key = names[cxxName];
        assert.ok(key, `${cxxName} is not mapped`);
        assert.equal(CONTEXT_SNAPSHOT_BITS[key], 1 << Number(shift), `${cxxName} / ${key}`);
    }

    const formatShift = header.match(/kSnapshotFormatShift\s*=\s*(\d+)/);
    const formatMask = header.match(/kSnapshotFormatMask\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
    assert.equal(Number(formatShift?.[1]), CONTEXT_SNAPSHOT_FORMAT_SHIFT);
    assert.equal(Number(formatMask?.[1]), CONTEXT_SNAPSHOT_FORMAT_MASK);

    /** @param {string} name */
    const constant = (name) => Number(header.match(new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)`))?.[1]);
    assert.equal(constant('kSnapshotPowerShift'), CONTEXT_SNAPSHOT_POWER_SHIFT);
    assert.equal(constant('kSnapshotPowerMask'), CONTEXT_SNAPSHOT_POWER_MASK);
    assert.equal(constant('kSnapshotAttributesShift'), CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT);
    assert.equal(constant('kSnapshotAttributesMask'), CONTEXT_SNAPSHOT_ATTRIBUTES_MASK);
    // The attribute field holds every flag, and stays inside a signed 32-bit int.
    const allFlags = Object.values(F).reduce((all, bit) => all | bit, 0);
    assert.equal(allFlags & ~CONTEXT_SNAPSHOT_ATTRIBUTES_MASK, 0);
    assert.ok(CONTEXT_SNAPSHOT_ATTRIBUTES_MASK << CONTEXT_SNAPSHOT_ATTRIBUTES_SHIFT > 0);
});

test('decodeContextSnapshot reads each capability and the format on its own', () => {
    assert.deepEqual(decodeContextSnapshot(packSnapshot()), {
        floatColorBuffer: false, floatBlend: false, loseContext: false, fboFormat: 0, fboFormatName: 'RGBA16F',
        attributes: null, mismatches: [],
    });
    assert.equal(decodeContextSnapshot(packSnapshot({ floatColorBuffer: true }))?.floatColorBuffer, true);
    assert.equal(decodeContextSnapshot(packSnapshot({ floatBlend: true }))?.floatBlend, true);
    assert.equal(decodeContextSnapshot(packSnapshot({ loseContext: true }))?.loseContext, true);

    // One capability set must not leak into the others.
    assert.deepEqual(decodeContextSnapshot(packSnapshot({ floatBlend: true })), {
        floatColorBuffer: false, floatBlend: true, loseContext: false, fboFormat: 0, fboFormatName: 'RGBA16F',
        attributes: null, mismatches: [],
    });
});

test('decodeContextAttributes names each flag and the power preference', () => {
    const none = decodeContextAttributes(0, 0);
    assert.equal(none.powerPreference, 'default');
    for (const [name, bit] of Object.entries(F)) {
        const attributes = decodeContextAttributes(bit, 1);
        assert.equal(attributes.powerPreference, 'low-power');
        for (const key of Object.keys(F)) {
            assert.equal(/** @type {any} */ (attributes)[key], key === name, `${name} must set only ${name}`);
            assert.equal(/** @type {any} */ (none)[key], false);
        }
    }
    assert.equal(decodeContextAttributes(0, 2).powerPreference, 'high-performance');
    assert.ok(Object.isFrozen(none));
});

test('the snapshot reports the context\'s real attributes, field by field', () => {
    const flags = F.contextAlpha | F.premultipliedAlpha | F.depth | F.desynchronized;
    const snapshot = decodeContextSnapshot(packSnapshot({ floatColorBuffer: true, format: 1, attributes: flags, power: 1 }));
    assert.deepEqual(snapshot?.attributes, decodeContextAttributes(flags, 1));
    // The fields next to it are untouched.
    assert.equal(snapshot?.floatColorBuffer, true);
    assert.equal(snapshot?.floatBlend, false);
    assert.equal(snapshot?.fboFormat, 1);
    // Without a requested config there is nothing to compare against.
    assert.deepEqual(snapshot?.mismatches, []);
});

test('requested vs effective: the snapshot lists each attribute the context did not get', () => {
    const requested = resolveWasmContextConfig({ transparent: true });
    // A context the canvas already held: opaque, with a depth buffer, low-power.
    const effectiveFlags = F.premultipliedAlpha | F.depth;
    const snapshot = decodeContextSnapshot(packSnapshot({ attributes: effectiveFlags, power: 1 }), requested);
    assert.deepEqual(snapshot?.mismatches, [
        { attribute: 'depth', requested: false, effective: true },
        { attribute: 'contextAlpha', requested: true, effective: false },
        { attribute: 'powerPreference', requested: 'high-performance', effective: 'low-power' },
    ]);
    assert.ok(Object.isFrozen(snapshot?.mismatches));
    assert.ok(snapshot?.mismatches.every((entry) => Object.isFrozen(entry)));

    // The same context, asked for exactly what it has: no mismatches.
    const agreeing = { flags: effectiveFlags, powerPreference: 1, fboPrecision: 0 };
    assert.deepEqual(decodeContextSnapshot(packSnapshot({ attributes: effectiveFlags, power: 1 }), agreeing)?.mismatches, []);
    // A bundle that does not report attributes has none to compare.
    assert.deepEqual(decodeContextSnapshot(packSnapshot(), requested)?.mismatches, []);
});

test('manual present expects preserveDrawingBuffer: Emscripten forces it for the offscreen back buffer', () => {
    const requested = resolveWasmContextConfig({ presentMode: 'manual' });
    const granted = requested.flags | F.preserveDrawingBuffer;
    assert.deepEqual(contextAttributeMismatches(requested, decodeContextAttributes(granted, 2)), []);
    // Without manual present the same back buffer is a real difference.
    const browser = resolveWasmContextConfig();
    assert.deepEqual(contextAttributeMismatches(browser, decodeContextAttributes(browser.flags | F.preserveDrawingBuffer, 2)), [
        { attribute: 'preserveDrawingBuffer', requested: false, effective: true },
    ]);
});

test('decodeContextSnapshot maps the format field to FboFloatFormat, unknown values to RGBA8', () => {
    // The fboPrecision numbering, as dual_fbo_get_format() reports it.
    for (const [format, name] of [[0, 'RGBA16F'], [1, 'RGBA32F'], [2, 'RGBA8']]) {
        const snapshot = decodeContextSnapshot(packSnapshot({ format }));
        assert.equal(snapshot?.fboFormat, format);
        assert.equal(snapshot?.fboFormatName, name);
    }
    const unknown = decodeContextSnapshot(packSnapshot({ format: 3 }));
    assert.equal(unknown?.fboFormat, 2);
    assert.equal(unknown?.fboFormatName, 'RGBA8');
});

test('a snapshot with no context behind it decodes to null, not to a false RGBA16F', () => {
    assert.equal(decodeContextSnapshot(0), null, 'get_context_snapshot() answers 0 before init');
    // Capability bits without the valid bit are not a snapshot either.
    assert.equal(decodeContextSnapshot(packSnapshot({ valid: false, floatColorBuffer: true, format: 1 })), null);
    assert.equal(decodeContextSnapshot(Number.NaN), null);
    assert.equal(decodeContextSnapshot(/** @type {any} */ (undefined)), null);
});

test('the decoded snapshot is frozen: a host cannot edit what the engine reported', () => {
    const snapshot = decodeContextSnapshot(packSnapshot({ floatColorBuffer: true }));
    assert.ok(snapshot && Object.isFrozen(snapshot));
    assert.throws(() => { /** @type {any} */ (snapshot).floatColorBuffer = false; }, TypeError);
    assert.equal(snapshot.floatColorBuffer, true);
});
