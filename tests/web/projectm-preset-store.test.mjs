// html/projectm-preset-store.js: preset bytes into the engine through
// load_preset_data() (#352 D), or the FS sequence on bundles built before it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PRESET_STORE_MODES, canStorePresets, hasPresetDataExport, storePreset } from '../../html/projectm-preset-store.js';

/** A bundle with load_preset_data(): a 64-byte heap, malloc hands out offset 16. */
function presetDataModule({ mallocResult = 16, stored = 1 } = {}) {
    /** @type {Array<{ name: string, returnType: unknown, argTypes: unknown, args: unknown[], heap: number[] }>} */
    const ccalls = [];
    /** @type {number[]} */
    const freed = [];
    const module = {
        HEAPU8: new Uint8Array(64),
        _malloc: () => mallocResult,
        _free: (/** @type {number} */ ptr) => freed.push(ptr),
        // Presence is what the store probes; the call itself goes through ccall (it takes a string).
        _load_preset_data: () => assert.fail('load_preset_data takes a string: call it through ccall'),
        ccall: (/** @type {string} */ name, /** @type {unknown} */ returnType, /** @type {unknown} */ argTypes, /** @type {unknown[]} */ args) => {
            // What the engine sees at the pointer while the call runs.
            const [ptr, len] = /** @type {[number, number]} */ (args);
            ccalls.push({ name, returnType, argTypes, args, heap: [...module.HEAPU8.subarray(ptr, ptr + len)] });
            return stored;
        },
        ccalls,
        freed,
    };
    return module;
}

/** A bundle built before load_preset_data(): the FS and the path exports. */
function fsModule() {
    /** @type {Array<[string, number[]]>} */
    const written = [];
    /** @type {string[]} */
    const dirs = [];
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const ccalls = [];
    return {
        FS: {
            mkdirTree: (/** @type {string} */ dir) => dirs.push(dir),
            writeFile: (/** @type {string} */ path, /** @type {Uint8Array} */ bytes) => written.push([path, [...bytes]]),
        },
        ccall: (/** @type {string} */ name, /** @type {unknown} */ _returnType, /** @type {unknown} */ _argTypes, /** @type {unknown[]} */ args) => {
            ccalls.push({ name, args });
            return null;
        },
        written,
        dirs,
        ccalls,
    };
}

test('load_preset_data gets the bytes on the heap, the name and the mode, and the copy is freed', () => {
    const module = presetDataModule();
    storePreset(module, '/presets/a.milk', Uint8Array.of(7, 8, 9));

    assert.equal(module.ccalls.length, 1);
    const [call] = module.ccalls;
    assert.equal(call.name, 'load_preset_data');
    assert.equal(call.returnType, 'number');
    assert.deepEqual(call.argTypes, ['number', 'number', 'string', 'number']);
    assert.deepEqual(call.args, [16, 3, '/presets/a.milk', 0]);
    assert.deepEqual(call.heap, [7, 8, 9]);
    assert.deepEqual(module.freed, [16]);
});

test('each mode reaches load_preset_data as its number', () => {
    for (const mode of /** @type {const} */ (['load', 'load-hard', 'add', 'store'])) {
        const module = presetDataModule();
        storePreset(module, '/presets/a.milk', Uint8Array.of(1), mode);
        assert.equal(module.ccalls[0].args[3], PRESET_STORE_MODES[mode], mode);
    }
    assert.deepEqual({ ...PRESET_STORE_MODES }, { load: 0, 'load-hard': 1, add: 2, store: 3 });
});

test('a refused preset throws, and the heap copy is still freed', () => {
    const module = presetDataModule({ stored: 0 });
    assert.throws(() => storePreset(module, '/presets/a.milk', Uint8Array.of(1)), /the engine refused preset \/presets\/a\.milk/);
    assert.deepEqual(module.freed, [16]);
});

test('a full heap throws before calling the engine', () => {
    const module = presetDataModule({ mallocResult: 0 });
    assert.throws(() => storePreset(module, '/presets/a.milk', Uint8Array.of(1)), /no WASM heap left/);
    assert.equal(module.ccalls.length, 0);
    assert.deepEqual(module.freed, []);
});

test('an empty preset still gets a valid allocation', () => {
    const module = presetDataModule();
    storePreset(module, '/presets/empty.milk', new Uint8Array(0));
    assert.deepEqual(module.ccalls[0].args, [16, 0, '/presets/empty.milk', 0]);
});

test('an unknown mode throws before anything is written', () => {
    const module = presetDataModule();
    // @ts-expect-error -- not a PresetStoreMode
    assert.throws(() => storePreset(module, '/presets/a.milk', Uint8Array.of(1), 'replace'), /unknown preset store mode/);
    assert.equal(module.ccalls.length, 0);
});

test('a bundle without load_preset_data gets the FS sequence and the path export for each mode', () => {
    /** @type {Array<[import('../../html/projectm-preset-store.js').PresetStoreMode, string | null]>} */
    const cases = [['load', 'load_preset_file'], ['load-hard', 'load_preset_file_hard'], ['add', 'add_preset_file'], ['store', null]];
    for (const [mode, symbol] of cases) {
        const module = fsModule();
        storePreset(module, '/presets/sub/a.milk', Uint8Array.of(5), mode);
        assert.deepEqual(module.dirs, ['/presets/sub'], mode);
        assert.deepEqual(module.written, [['/presets/sub/a.milk', [5]]], mode);
        assert.deepEqual(module.ccalls.map((call) => [call.name, ...call.args]), symbol ? [[symbol, '/presets/sub/a.milk']] : [], mode);
    }
});

test('the export without heap access does not count, and a module with neither path throws', () => {
    const partial = { _load_preset_data: () => 1, ccall: () => 1 };
    assert.equal(hasPresetDataExport(partial), false);
    assert.equal(canStorePresets(partial), false);
    assert.throws(() => storePreset(partial, '/presets/a.milk', Uint8Array.of(1)), /neither load_preset_data nor FS/);
});

test('canStorePresets: no module (the render-worker topology), an FS-only bundle, a load_preset_data bundle', () => {
    assert.equal(canStorePresets(null), false);
    assert.equal(canStorePresets(undefined), false);
    assert.equal(canStorePresets(fsModule()), true);
    assert.equal(canStorePresets(presetDataModule()), true);
    assert.equal(hasPresetDataExport(fsModule()), false);
    assert.equal(hasPresetDataExport(presetDataModule()), true);
});
