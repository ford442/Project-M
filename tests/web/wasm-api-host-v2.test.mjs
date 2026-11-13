// Contract tests for the ABI v2 half of html/generated/projectm-wasm-api.js
// (#352): every engine call reaches its pm_<name>(host, ...) export with the
// host it was bound to, and nothing is ever activated.
//
// The generated file is derived from cmake/WasmApiManifest.cmake, so these
// tests walk the generated tables (WASM_API_SIGNATURES, HOST_SYMBOLS, the
// HostApi methods) rather than listing exports by hand: a manifest entry added
// tomorrow is covered by the same assertions.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as wasmApi from '../../html/generated/projectm-wasm-api.js';

const { HOST_SYMBOLS, WASM_API_SIGNATURES, bindModuleToHost, createHostApi } = wasmApi;

const HOST = 0x0201; // slot 1, generation 2: a handle shape create_host*() returns

/**
 * An ABI v2 module: every `_symbol` is a recorder, `ccall` too, and
 * pm_host_is_live() answers from `live`.
 *
 * @param {{ live?: Set<number> }} [options]
 */
function fakeV2Module({ live = new Set([HOST]) } = {}) {
    /** @type {Array<{ symbol: string, args: unknown[], via: 'direct' | 'ccall' }>} */
    const calls = [];
    const target = {
        calls,
        live,
        _pm_host_is_live: (/** @type {number} */ handle) => (live.has(handle) || handle === 0 ? 1 : 0),
        ccall(/** @type {string} */ symbol, /** @type {unknown} */ _returnType, /** @type {unknown[]} */ _argTypes, /** @type {unknown[]} */ args) {
            calls.push({ symbol, args: [...args], via: 'ccall' });
            return 0;
        },
    };
    return new Proxy(target, {
        get(obj, property) {
            if (property in obj) return Reflect.get(obj, property);
            if (typeof property === 'string' && property.startsWith('_')) {
                return (/** @type {unknown[]} */ ...args) => {
                    calls.push({ symbol: property.slice(1), args, via: 'direct' });
                    return 0;
                };
            }
            return undefined;
        },
    });
}

/** Placeholder arguments of the right JS type for a signature. */
function argsFor(signature) {
    return signature.paramTypes.map((type) => (type === 'string' ? 'x' : type === 'boolean' ? true : 3));
}

test('every engine export has a pm_ form, and the routing table agrees with the signatures', () => {
    let routed = 0;
    for (const [jsName, signature] of Object.entries(WASM_API_SIGNATURES)) {
        const route = HOST_SYMBOLS.get(signature.symbol);
        if (signature.hostSymbol === null) {
            assert.equal(route, undefined, `${jsName}: not an engine call, not routed`);
            continue;
        }
        routed += 1;
        assert.match(signature.hostSymbol, /^pm_/, `${jsName}'s pm_ export`);
        assert.deepEqual(route, [signature.hostSymbol, signature.hostMode], `${jsName}'s route`);
        assert.equal(typeof wasmApi.WASM_API_SYMBOLS[jsName], 'string');
    }
    assert.ok(routed > 50, `the engine surface is routed (${routed} exports)`);
});

test('every HostApi method reaches a pm_ export with its host, activating nothing', () => {
    const module = fakeV2Module();
    const api = createHostApi(module, HOST);
    assert.equal(api.host, HOST);

    const methods = Object.entries(api).filter(([, value]) => typeof value === 'function');
    assert.ok(methods.length > 50, `HostApi has the engine surface (${methods.length} methods)`);
    for (const [name, method] of methods) {
        module.calls.length = 0;
        // Enough arguments of a plausible type; the fake ignores their values.
        method(...new Array(method.length).fill(3));
        assert.ok(module.calls.length >= 1, `${name}() called an export`);
        for (const call of module.calls) {
            assert.match(call.symbol, /^pm_/, `${name}() calls a pm_ export, not ${call.symbol}`);
            assert.notEqual(call.symbol, 'set_active_host', `${name}() activates nothing`);
            if (call.symbol !== 'pm_host_is_live') {
                assert.equal(call.args[0], HOST, `${name}() passes its host first`);
            }
        }
    }
});

test('a bound view rewrites both call styles of every routed export', () => {
    const module = fakeV2Module();
    const view = bindModuleToHost(module, HOST);
    for (const [compat, [pmSymbol, mode]] of HOST_SYMBOLS) {
        const signature = Object.values(WASM_API_SIGNATURES).find((sig) => sig.symbol === compat);
        assert.ok(signature, `${compat} has a signature`);
        const args = argsFor(signature);

        module.calls.length = 0;
        view[`_${compat}`](...args);
        view.ccall(compat, signature.returnType, signature.argTypes, args);
        const [direct, ccall] = module.calls;
        assert.equal(direct.symbol, pmSymbol, `_${compat}() -> _${pmSymbol}()`);
        assert.equal(ccall.symbol, pmSymbol, `ccall('${compat}') -> ccall('${pmSymbol}')`);
        if (mode === 'prepend') {
            assert.deepEqual(direct.args, [HOST, ...args]);
            assert.deepEqual(ccall.args, [HOST, ...args]);
        } else {
            // The first argument already is a handle; 0 means the view's host.
            assert.deepEqual(direct.args, args);
            module.calls.length = 0;
            view[`_${compat}`](0, ...args.slice(1));
            assert.equal(module.calls[0].args[0], HOST, `${compat}(0, ...) is the view's host`);
        }
    }
});

test('a view whose host is gone throws instead of reaching another engine', () => {
    const module = fakeV2Module();
    const view = bindModuleToHost(module, HOST);
    module.live.delete(HOST);
    assert.throws(() => view._set_mesh(48, 32), /host 513 no longer exists/);
    assert.throws(() => view.ccall('load_preset_file', null, ['string'], ['/p.milk']), /no longer exists/);
    assert.deepEqual(module.calls, [], 'nothing was called');
    // Module-level exports are not engine calls and still work.
    view._host_count();
    assert.deepEqual(module.calls.map((call) => call.symbol), ['host_count']);
});

test('host 0 is the implicit default host: routed with handle 0, not left on the active host', () => {
    const module = fakeV2Module();
    createHostApi(module, 0).setMesh(48, 32);
    assert.deepEqual(module.calls, [{ symbol: 'pm_set_mesh', args: [0, 48, 32], via: 'direct' }]);
});

test('a bundle from before ABI v2 is driven by activation, and host 0 is the module itself', () => {
    let active = 0;
    /** @type {string[]} */
    const log = [];
    const module = {
        _get_active_host: () => active,
        _set_mesh: () => log.push(`set_mesh@${active}`),
        ccall(/** @type {string} */ name, /** @type {unknown} */ _ret, /** @type {unknown} */ _types, /** @type {unknown[]} */ args) {
            if (name === 'set_active_host') active = Number(args[0]);
            log.push(name);
        },
    };
    assert.equal(bindModuleToHost(module, 0), module);
    bindModuleToHost(module, HOST)._set_mesh(48, 32);
    assert.deepEqual(log, ['set_active_host', `set_mesh@${HOST}`]);
});
