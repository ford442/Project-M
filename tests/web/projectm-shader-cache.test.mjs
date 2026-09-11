// Unit tests for html/projectm-shader-cache.js — the transpiled-GLSL cache
// that lets a repeat visit skip HLSL parse/transpile. Run with:
//   node --test tests/web/projectm-shader-cache.test.mjs
//
// The IndexedDB half runs against tests/web/helpers/fake-indexeddb.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SHADER_STORE, openPresetCacheDb } from '../../html/projectm-preset-cache.js';
import {
    buildShaderCacheKey,
    ensureShaderCacheEngineVersion,
    finalizeShaderCacheForLoad,
    getCachedTranspiledShaders,
    getShaderCacheKeyForBytes,
    hashPresetBytes,
    measurePresetSwitchTimings,
    prepareShaderCacheForLoad,
    putCachedTranspiledShaders,
    setupShaderTranspileCacheHooks,
} from '../../html/projectm-shader-cache.js';
import { PROJECTM_WASM_VERSION } from '../../html/projectm-wasm-version.js';
import {
    fakeStoreContents,
    installFakeIndexedDb,
    resetFakeIndexedDb,
} from './helpers/fake-indexeddb.mjs';

const DB_NAME = 'projectm-preset-cache';

async function withFakeDb(fn) {
    resetFakeIndexedDb();
    const restore = installFakeIndexedDb();
    try {
        return await fn();
    } finally {
        restore();
        resetFakeIndexedDb();
    }
}

/** Minimal localStorage stand-in — ensureShaderCacheEngineVersion needs one. */
function installFakeLocalStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, String(value)),
            removeItem: (key) => map.delete(key),
        },
    });
    return {
        map,
        restore() {
            if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
            else delete globalThis.localStorage;
        },
    };
}

/** Seeds the shader store directly, bypassing the write path under test. */
async function seedShaderRows(rows) {
    const db = await openPresetCacheDb();
    await new Promise((resolve) => {
        const tx = db.transaction(SHADER_STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        const store = tx.objectStore(SHADER_STORE);
        for (const row of rows) store.put(row);
    });
    db.close();
}

test('hashPresetBytes is a stable SHA-256 hex digest', async () => {
    const hash = await hashPresetBytes(new Uint8Array([1, 2, 3]));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, await hashPresetBytes(new Uint8Array([1, 2, 3])));
    assert.notEqual(hash, await hashPresetBytes(new Uint8Array([1, 2, 4])));
});

test('hashPresetBytes falls back to a length/edge-byte key without WebCrypto', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: {} });
    try {
        assert.equal(await hashPresetBytes(new Uint8Array([10, 20, 30])), 'len3-h10-t30');
        // Degenerate inputs must still produce a key rather than throw.
        assert.equal(await hashPresetBytes(new Uint8Array([])), 'len0-h0-t0');
        assert.equal(await hashPresetBytes(new Uint8Array([5])), 'len1-h5-t0');
    } finally {
        if (previous) Object.defineProperty(globalThis, 'crypto', previous);
    }
});

test('buildShaderCacheKey binds the bundle version and the GLSL generator version', () => {
    assert.equal(
        buildShaderCacheKey('abc', { wasmVersion: '0.36', glslVersion: '7' }),
        'shader::0.36::7::abc',
    );
    // An unknown generator version is recorded as '?', not dropped: a key that
    // omitted it would collide across generator changes.
    assert.equal(buildShaderCacheKey('abc'), `shader::${PROJECTM_WASM_VERSION}::?::abc`);
});

test('getShaderCacheKeyForBytes uses the module generator version when there is one', async () => {
    const bytes = new Uint8Array([1]);
    const hash = await hashPresetBytes(bytes);
    const withModule = await getShaderCacheKeyForBytes(bytes, { _get_glsl_generator_version: () => 4 });
    assert.equal(withModule, `shader::${PROJECTM_WASM_VERSION}::4::${hash}`);
    assert.equal(await getShaderCacheKeyForBytes(bytes, null), `shader::${PROJECTM_WASM_VERSION}::?::${hash}`);
});

test('putCachedTranspiledShaders stores both halves and records their byte size', async () => {
    await withFakeDb(async () => {
        assert.equal(await putCachedTranspiledShaders('k1', { warp: 'W', composite: 'C' }, { file: 'a.milk' }), true);
        const row = fakeStoreContents(DB_NAME, SHADER_STORE).get('k1');
        assert.equal(row.warp, 'W');
        assert.equal(row.composite, 'C');
        assert.equal(row.sizeBytes, 2);
        assert.deepEqual(row.meta, { file: 'a.milk' });
    });
});

test('putCachedTranspiledShaders refuses a half-written entry', async () => {
    await withFakeDb(async () => {
        assert.equal(await putCachedTranspiledShaders('k1', { warp: 'W' }), false);
        assert.equal(await putCachedTranspiledShaders('k1', { composite: 'C' }), false);
        assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).size, 0);
    });
});

test('getCachedTranspiledShaders returns null for a miss or a half-written row', async () => {
    await withFakeDb(async () => {
        assert.equal(await getCachedTranspiledShaders('absent'), null);
        await seedShaderRows([{ id: 'half', warp: 'W' }]);
        assert.equal(await getCachedTranspiledShaders('half'), null);
    });
});

test('getCachedTranspiledShaders returns both shaders and refreshes the LRU stamp', async () => {
    await withFakeDb(async () => {
        await seedShaderRows([{ id: 'k1', warp: 'W', composite: 'C', lastUsedAt: 1 }]);
        assert.deepEqual(await getCachedTranspiledShaders('k1'), { warp: 'W', composite: 'C' });
        assert.ok(fakeStoreContents(DB_NAME, SHADER_STORE).get('k1').lastUsedAt > 1);
    });
});

test('a write over the byte cap evicts least-recently-used entries first', async () => {
    await withFakeDb(async () => {
        // sizeBytes is read straight off the stored row, so the cap can be
        // exceeded without allocating 48 MB of strings.
        await seedShaderRows([
            { id: 'oldest', warp: 'W', composite: 'C', sizeBytes: 20 * 1024 * 1024, lastUsedAt: 10 },
            { id: 'newer', warp: 'W', composite: 'C', sizeBytes: 20 * 1024 * 1024, lastUsedAt: 20 },
            { id: 'newest', warp: 'W', composite: 'C', sizeBytes: 20 * 1024 * 1024, lastUsedAt: 30 },
        ]);

        await putCachedTranspiledShaders('incoming', { warp: 'W', composite: 'C' });

        const ids = [...fakeStoreContents(DB_NAME, SHADER_STORE).keys()].sort();
        assert.deepEqual(ids, ['incoming', 'newer', 'newest']);
    });
});

test('a write over the entry cap evicts the oldest entry', async () => {
    await withFakeDb(async () => {
        const rows = [];
        for (let i = 0; i < 96; i += 1) {
            rows.push({ id: `k${i}`, warp: 'W', composite: 'C', sizeBytes: 2, lastUsedAt: i + 1 });
        }
        await seedShaderRows(rows);

        await putCachedTranspiledShaders('incoming', { warp: 'W', composite: 'C' });

        const store = fakeStoreContents(DB_NAME, SHADER_STORE);
        assert.equal(store.size, 96);
        assert.equal(store.has('k0'), false, 'the least-recently-used entry should be gone');
        assert.equal(store.has('k1'), true);
        assert.equal(store.has('incoming'), true);
    });
});

test('ensureShaderCacheEngineVersion clears the store when the bundle version changes', async () => {
    await withFakeDb(async () => {
        const storage = installFakeLocalStorage({ 'projectm:shaderCacheEngineVersion': 'old-version' });
        try {
            await seedShaderRows([{ id: 'stale', warp: 'W', composite: 'C' }]);
            await ensureShaderCacheEngineVersion('new-version');
            assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).size, 0);
            assert.equal(storage.map.get('projectm:shaderCacheEngineVersion'), 'new-version');
        } finally {
            storage.restore();
        }
    });
});

test('ensureShaderCacheEngineVersion keeps the store when the version already matches', async () => {
    await withFakeDb(async () => {
        const storage = installFakeLocalStorage({ 'projectm:shaderCacheEngineVersion': 'same' });
        try {
            await seedShaderRows([{ id: 'keep', warp: 'W', composite: 'C' }]);
            await ensureShaderCacheEngineVersion('same');
            assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).has('keep'), true);
        } finally {
            storage.restore();
        }
    });
});

test('ensureShaderCacheEngineVersion swallows a missing localStorage', async () => {
    await withFakeDb(async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        if (previous) delete globalThis.localStorage;
        try {
            await ensureShaderCacheEngineVersion('any');
        } finally {
            if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        }
    });
});

test('prepareShaderCacheForLoad is a no-op without the WASM shader-cache API', async () => {
    assert.equal(await prepareShaderCacheForLoad({}, new Uint8Array([1])), null);
    assert.equal(await prepareShaderCacheForLoad({ ccall() {} }, new Uint8Array([1])), null);
    // finalize is guarded by the same probe and must not throw either.
    finalizeShaderCacheForLoad({});
});

test('prepareShaderCacheForLoad injects a cache hit and finalize closes the load', async () => {
    await withFakeDb(async () => {
        // Matching the stored engine version keeps setupShaderTranspileCacheHooks()'s
        // fire-and-forget ensureShaderCacheEngineVersion() from wiping the store
        // out from under this test.
        const storage = installFakeLocalStorage({ 'projectm:shaderCacheEngineVersion': PROJECTM_WASM_VERSION });
        /** @type {Array<{ name: string, args: unknown[] }>} */
        const calls = [];
        let ended = 0;
        const module = {
            _shader_cache_end_load: () => { ended += 1; },
            _get_glsl_generator_version: () => 3,
            ccall: (name, _returnType, _argTypes, args) => { calls.push({ name, args }); },
        };

        try {
            const bytes = new Uint8Array([1, 2, 3]);
            const key = await getShaderCacheKeyForBytes(bytes, module);
            await seedShaderRows([{ id: key, warp: 'WARP', composite: 'COMP' }]);

            assert.equal(await prepareShaderCacheForLoad(module, bytes), key);
            assert.deepEqual(calls, [
                { name: 'shader_cache_begin_load', args: [key] },
                { name: 'shader_cache_import_glsl', args: [0, 'WARP'] },
                { name: 'shader_cache_import_glsl', args: [1, 'COMP'] },
            ]);

            finalizeShaderCacheForLoad(module);
            assert.equal(ended, 1);
        } finally {
            storage.restore();
        }
    });
});

test('prepareShaderCacheForLoad begins the load but imports nothing on a cache miss', async () => {
    await withFakeDb(async () => {
        // Matching the stored engine version keeps setupShaderTranspileCacheHooks()'s
        // fire-and-forget ensureShaderCacheEngineVersion() from wiping the store
        // out from under this test.
        const storage = installFakeLocalStorage({ 'projectm:shaderCacheEngineVersion': PROJECTM_WASM_VERSION });
        /** @type {string[]} */
        const names = [];
        const module = {
            _shader_cache_end_load() {},
            _get_glsl_generator_version: () => 3,
            ccall: (name) => { names.push(name); },
        };
        try {
            await prepareShaderCacheForLoad(module, new Uint8Array([4, 5, 6]));
            assert.deepEqual(names, ['shader_cache_begin_load']);
        } finally {
            storage.restore();
        }
    });
});

test('the transpile hook writes a row once both shader halves have arrived', async () => {
    await withFakeDb(async () => {
        // Matching the stored engine version keeps setupShaderTranspileCacheHooks()'s
        // fire-and-forget ensureShaderCacheEngineVersion() from wiping the store
        // out from under this test.
        const storage = installFakeLocalStorage({ 'projectm:shaderCacheEngineVersion': PROJECTM_WASM_VERSION });
        try {
            setupShaderTranspileCacheHooks();
            const hook = globalThis.pmOnTranspiledShaderStored;
            assert.equal(typeof hook, 'function');

            // Warp alone is not enough to write: a half-written row would be
            // read back as a miss forever.
            hook('key-a', 0, 'WARP');
            await new Promise((resolve) => setTimeout(resolve, 5));
            assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).has('key-a'), false);

            hook('key-a', 1, 'COMP');
            await new Promise((resolve) => setTimeout(resolve, 5));
            const row = fakeStoreContents(DB_NAME, SHADER_STORE).get('key-a');
            assert.equal(row.warp, 'WARP');
            assert.equal(row.composite, 'COMP');

            // Empty payloads and unknown kinds are ignored rather than stored.
            hook('', 0, 'WARP');
            hook('key-b', 0, '');
            hook('key-b', 7, 'OTHER');
            await new Promise((resolve) => setTimeout(resolve, 5));
            assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).has('key-b'), false);
        } finally {
            delete globalThis.pmOnTranspiledShaderStored;
            storage.restore();
        }
    });
});

test('measurePresetSwitchTimings requires an injected loader', async () => {
    await assert.rejects(measurePresetSwitchTimings({}, []), /requires loadEntry/);
});

test('measurePresetSwitchTimings loads each preset cold then warm and reports the delta', async () => {
    await withFakeDb(async () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        /** @type {any[]} */
        const posted = [];
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            writable: true,
            value: { postMessage: (msg) => posted.push(msg) },
        });

        await seedShaderRows([{ id: 'stale', warp: 'W', composite: 'C' }]);

        /** @type {string[]} */
        const loads = [];
        try {
            const summary = await measurePresetSwitchTimings(
                {},
                [{ file: 'a.milk', label: 'A' }, { file: 'b.milk' }],
                {
                    clearShaderCache: true,
                    loadEntry: async (entry, opts) => {
                        // The benchmark must not repaint the UI or fire a
                        // crossfade while it is timing loads.
                        assert.equal(opts.updateDisplay, false);
                        assert.equal(opts.startTransitionWhenReady, null);
                        loads.push(entry.file);
                    },
                },
            );

            assert.deepEqual(loads, ['a.milk', 'a.milk', 'b.milk', 'b.milk']);
            assert.deepEqual(summary.presets.map((p) => p.preset), ['A', 'b.milk']);
            for (const row of summary.presets) {
                assert.equal(row.savedMs, row.coldMs - row.warmMs);
            }
            assert.equal(posted.length, 1);
            assert.equal(posted[0].type, 'pm-preset-switch-benchmark');
            // clearShaderCache wipes the store before each cold load.
            assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).size, 0);
        } finally {
            if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
            else delete globalThis.window;
        }
    });
});
