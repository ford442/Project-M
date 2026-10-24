// Unit tests for the user-sprite surface: the projectm_sprite_* / create_sprite
// exports as the generated wrapper and both render transports see them,
// ProjectMContext's sprite methods (html/context/sprites.js), and the
// experimental bridge's sprite and in-place depth-texture paths.
//
// The first tests are manifest-drift checks in the style of the worker
// protocol test: cmake/WasmApiManifest.cmake is the only place a sprite
// export's name and signature are written, and the generated wrapper, the
// link's export list and the worker transport's ccall must all agree with it.
//
// Run with: node --test tests/web/projectm-user-sprites.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as wasmApi from '../../html/generated/projectm-wasm-api.js';
import { WASM_API_SIGNATURES, WASM_API_SYMBOLS, PUBLIC_WASM_API } from '../../html/generated/projectm-wasm-api.js';
import { createModuleTransport, createWorkerTransport } from '../../html/projectm-render-transport.js';
import { createSpriteOn, destroySpriteOn, getSpriteVarOn, setSpriteVarOn } from '../../html/context/sprites.js';
import {
    bindDepthBytes,
    buildDepthSpriteCode,
    seedDepthTexture,
    spawnDepthSprite,
} from '../../html/projectm-experimental-bridge.js';

const MANIFEST = readFileSync(fileURLToPath(new URL('../../cmake/WasmApiManifest.cmake', import.meta.url)), 'utf8');
const EXPORTS = readFileSync(fileURLToPath(new URL('../../cmake/EmscriptenWasmFlags.cmake', import.meta.url)), 'utf8');

/** The sprite API of projectM-4/user_sprites.h, by generated wrapper name. */
const SPRITE_CALLS = {
    createSprite: 'create_sprite',
    projectmSpriteCreate: 'projectm_sprite_create',
    projectmSpriteDestroy: 'projectm_sprite_destroy',
    projectmSpriteDestroyAll: 'projectm_sprite_destroy_all',
    projectmSpriteGetSpriteCount: 'projectm_sprite_get_sprite_count',
    projectmSpriteGetSpriteIds: 'projectm_sprite_get_sprite_ids',
    projectmSpriteSetMaxSprites: 'projectm_sprite_set_max_sprites',
    projectmSpriteGetMaxSprites: 'projectm_sprite_get_max_sprites',
    projectmSpriteGetVar: 'projectm_sprite_get_var',
    projectmSpriteSetVar: 'projectm_sprite_set_var',
};

/** @param {string} symbol */
function manifestEntry(symbol) {
    const line = MANIFEST.split('\n').find((l) => l.trim().startsWith(`"${symbol}|`));
    assert.ok(line, `${symbol} is in cmake/WasmApiManifest.cmake`);
    const [name, visibility, binding, returns, args] = line.trim().slice(1).split('|');
    return { name, visibility, binding, returns, args };
}

/** An engine with sprites, reachable both as a module and through a fake worker handle. */
function fakeSpriteEngine({ handle = 4096 } = {}) {
    /** @type {Map<number, Map<string, number>>} */
    const sprites = new Map();
    let nextId = 1;
    /** @type {Array<{ symbol: string, args: unknown[] }>} */
    const calls = [];
    const checkHandle = (pm) => assert.equal(pm, handle, 'every sprite call carries the engine handle');

    /** @type {Record<string, (...args: any[]) => unknown>} */
    const impl = {
        get_projectm_handle: () => handle,
        projectm_sprite_create: (pm, type, code) => {
            checkHandle(pm);
            if (type !== 'milkdrop' || !String(code).includes('img=')) return 0;
            const id = nextId++;
            sprites.set(id, new Map([['x', 0.5]]));
            return id;
        },
        projectm_sprite_destroy: (pm, id) => { checkHandle(pm); sprites.delete(id); },
        projectm_sprite_get_var: (pm, id, name) => { checkHandle(pm); return sprites.get(id)?.get(name) ?? 0; },
        projectm_sprite_set_var: (pm, id, name, value) => { checkHandle(pm); sprites.get(id)?.set(name, value); },
        projectm_sprite_get_sprite_count: (pm) => { checkHandle(pm); return sprites.size; },
        create_sprite: (type, code) => impl.projectm_sprite_create(handle, type, code),
    };
    const invoke = (symbol, args) => {
        calls.push({ symbol, args });
        const fn = impl[symbol];
        if (!fn) throw new Error(`no export ${symbol}`);
        return fn(...args);
    };

    const module = { ccall: (symbol, _ret, _types, args) => invoke(symbol, args) };
    for (const symbol of Object.keys(impl)) {
        module[`_${symbol}`] = (...args) => invoke(symbol, args);
    }
    const workerHandle = {
        posted: /** @type {unknown[]} */ ([]),
        ccall(symbol, returnType, argTypes, args) {
            this.posted.push({ symbol, returnType, argTypes, args });
            // The worker answers a throwing ccall with a rejection, not silence.
            try {
                return Promise.resolve(invoke(symbol, args));
            } catch (error) {
                return Promise.reject(error);
            }
        },
        ccallVoid(symbol, argTypes, args) {
            this.posted.push({ symbol, argTypes, args });
            invoke(symbol, args);
        },
    };
    return { sprites, calls, module, workerHandle };
}

// ---- manifest drift ------------------------------------------------------------

test('every sprite export is in the manifest, the link export list and the generated wrapper, under one name', () => {
    for (const [jsName, symbol] of Object.entries(SPRITE_CALLS)) {
        const entry = manifestEntry(symbol);
        assert.equal(entry.visibility, 'public', `${symbol} is part of the embed API`);
        assert.match(EXPORTS, new RegExp(`^\\s+_${symbol}$`, 'm'), `_${symbol} is exported by the link`);
        assert.equal(WASM_API_SYMBOLS[jsName], symbol);
        assert.equal(WASM_API_SIGNATURES[jsName].symbol, symbol);
        assert.equal(typeof wasmApi[jsName], 'function', `generated wrapper ${jsName}()`);
        assert.ok(PUBLIC_WASM_API.includes(wasmApi[jsName]), `${jsName} is listed as public`);
        // Generated arity: the module, then one parameter per manifest argument.
        const argCount = entry.args ? entry.args.split(',').length : 0;
        assert.equal(wasmApi[jsName].length, 1 + argCount, `${jsName}(module, ...${argCount} args)`);
        assert.equal(WASM_API_SIGNATURES[jsName].argTypes.length, argCount);
    }
    assert.equal(manifestEntry('get_projectm_handle').visibility, 'public', 'the handle the sprite calls take is reachable');
});

test('the zero-argument demo create_sprite() is gone from the shipped surface', () => {
    const entry = manifestEntry('create_sprite');
    assert.equal(entry.args, 'type:string,code:string');
    assert.equal(entry.returns, 'number');
    assert.deepEqual(WASM_API_SIGNATURES.createSprite.argTypes, ['string', 'string']);
    assert.equal(WASM_API_SIGNATURES.createSprite.returnType, 'number');

    const wrapper = readFileSync(fileURLToPath(new URL('../../src/wasm/projectM_emscripten.cpp', import.meta.url)), 'utf8');
    assert.match(wrapper, /uint32_t create_sprite\(const char\* type, const char\* code\)/);
    assert.doesNotMatch(wrapper, /rv_IP_20250421_060250/, 'the hard-coded magenta sprite lives in a test fixture now');
});

test('the worker transport posts each sprite call as a ccall under the generated symbol and types', async () => {
    const engine = fakeSpriteEngine();
    const worker = createWorkerTransport(engine.workerHandle);
    const main = createModuleTransport(engine.module);

    const id = await worker.call('projectmSpriteCreate', 4096, 'milkdrop', 'img=x');
    await worker.call('projectmSpriteSetVar', 4096, id, 'x', 0.25);
    assert.equal(await worker.call('projectmSpriteGetVar', 4096, id, 'x'), 0.25);
    assert.equal(await main.call('projectmSpriteGetVar', 4096, id, 'x'), 0.25, 'the module transport reaches the same export');

    for (const message of /** @type {Array<{ symbol: string, returnType: unknown, argTypes: string[] }>} */ (engine.workerHandle.posted)) {
        const [jsName] = Object.entries(SPRITE_CALLS).find(([, symbol]) => symbol === message.symbol) ?? [];
        assert.ok(jsName, `${message.symbol} is a manifest sprite symbol`);
        assert.deepEqual(message.argTypes, WASM_API_SIGNATURES[jsName].argTypes);
        assert.equal(message.returnType, WASM_API_SIGNATURES[jsName].returnType);
    }
});

// ---- ProjectMContext sprite methods ------------------------------------------------

for (const topology of ['main', 'worker']) {
    test(`createSprite / setSpriteVar / getSpriteVar / destroySprite round-trip (${topology} topology)`, async () => {
        const engine = fakeSpriteEngine();
        const transport = topology === 'main'
            ? createModuleTransport(engine.module)
            : createWorkerTransport(engine.workerHandle);

        const id = await createSpriteOn(transport, buildDepthSpriteCode(), 'milkdrop');
        assert.equal(id, 1);
        assert.equal(await getSpriteVarOn(transport, id, 'x'), 0.5);
        await setSpriteVarOn(transport, id, 'px', 0.75);
        assert.equal(await getSpriteVarOn(transport, id, 'px'), 0.75);
        await destroySpriteOn(transport, id);
        assert.equal(engine.sprites.size, 0);
        assert.equal(await getSpriteVarOn(transport, id, 'px'), 0, 'a destroyed sprite reads as 0');

        // Never the old-bundle-ambiguous create_sprite(): only projectm_sprite_* tell bundles apart.
        assert.ok(!engine.calls.some((call) => call.symbol === 'create_sprite'));
    });
}

test('the sprite methods reject before start(), on an old bundle, and when the engine refuses', async () => {
    await assert.rejects(createSpriteOn(null, 'img=x', 'milkdrop'), /has not started/);

    const engine = fakeSpriteEngine();
    delete engine.module._projectm_sprite_create;
    await assert.rejects(createSpriteOn(createModuleTransport(engine.module), 'img=x', 'milkdrop'), /predates the user-sprite exports/);
    await assert.rejects(getSpriteVarOn(createModuleTransport(engine.module), 1, 'x'), /predates/);

    const refusing = fakeSpriteEngine();
    await assert.rejects(createSpriteOn(createModuleTransport(refusing.module), 'no image line', 'milkdrop'), /refused/);

    const uninitialized = fakeSpriteEngine({ handle: 0 });
    await assert.rejects(setSpriteVarOn(createModuleTransport(uninitialized.module), 1, 'x', 1), /not initialized/);
});

test('a worker whose bundle lacks the export rejects instead of hanging', async () => {
    const engine = fakeSpriteEngine();
    const realCcall = engine.workerHandle.ccall.bind(engine.workerHandle);
    engine.workerHandle.ccall = (symbol, ...rest) => (symbol === 'projectm_sprite_get_var'
        ? Promise.reject(new Error('ccall projectm_sprite_get_var failed: missing export'))
        : realCcall(symbol, ...rest));
    await assert.rejects(getSpriteVarOn(createWorkerTransport(engine.workerHandle), 1, 'x'), /missing export/);
});

// ---- experimental bridge -----------------------------------------------------------

/** A module with a VFS and, optionally, reload_texture(). */
function fakeBridgeModule({ reload = /** @type {number | null} */ (1), existing = false } = {}) {
    const ccalls = /** @type {Array<{ name: string, args: unknown[] }>} */ ([]);
    const files = new Map();
    if (existing) files.set('/textures/pm_depth_map.png', new Uint8Array([1]));
    const module = {
        ccalls,
        files,
        FS: {
            mkdir() {},
            writeFile(path, bytes) { files.set(path, bytes); },
            analyzePath(path) { return { exists: files.has(path) }; },
        },
        ccall(name, _ret, _types, args) {
            ccalls.push({ name, args });
            return name === 'reload_texture' ? reload : 0;
        },
    };
    if (reload !== null) module._reload_texture = () => reload;
    return module;
}

test('a new depth map updates the loaded texture in place instead of reloading the preset', () => {
    const module = fakeBridgeModule({ reload: 1 });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    assert.equal(bindDepthBytes(module, bytes, { reloadPresetPath: '/presets/depth.milk' }), 'in-place');
    assert.equal(module.files.get('/textures/pm_depth_map.png'), bytes);
    assert.deepEqual(module.ccalls, [{ name: 'reload_texture', args: ['pm_depth_map'] }]);
});

test('without an in-place update the preset is reloaded, as before', () => {
    for (const reload of [0, null]) {
        const module = fakeBridgeModule({ reload });
        assert.equal(bindDepthBytes(module, new Uint8Array([1]), { reloadPresetPath: '/presets/depth.milk' }), 'preset-reload');
        assert.deepEqual(module.ccalls.at(-1), { name: 'load_preset_file', args: ['/presets/depth.milk'] });
    }
    const module = fakeBridgeModule({ reload: 0 });
    assert.equal(bindDepthBytes(module, new Uint8Array([1])), 'written', 'no preset to reload');
});

test('the seed depth map is a 1x1 PNG, written only when none exists', () => {
    const fresh = fakeBridgeModule();
    assert.equal(seedDepthTexture(fresh), true);
    const seed = fresh.files.get('/textures/pm_depth_map.png');
    assert.deepEqual([...seed.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
    assert.equal(new DataView(seed.buffer, seed.byteOffset).getUint32(16), 1, 'width');
    assert.equal(new DataView(seed.buffer, seed.byteOffset).getUint32(20), 1, 'height');

    const existing = fakeBridgeModule({ existing: true });
    assert.equal(seedDepthTexture(existing), false);
    assert.deepEqual([...existing.files.get('/textures/pm_depth_map.png')], [1], 'a real depth map is never overwritten');
    assert.equal(seedDepthTexture(null), false);
});

test('spawnDepthSprite creates the overlay through create_sprite() only on a bundle with the sprite exports', () => {
    const engine = fakeSpriteEngine();
    assert.equal(spawnDepthSprite(engine.module), 1);
    assert.equal(engine.calls.at(-1)?.symbol, 'create_sprite');

    const old = fakeSpriteEngine();
    delete old.module._projectm_sprite_create;
    assert.equal(spawnDepthSprite(old.module), 0, 'an old create_sprite() would ignore the code and draw its demo');
    assert.equal(old.calls.length, 0);
});

test('the depth sprite code is in the format MilkdropSprite parses', () => {
    const lines = buildDepthSpriteCode({ scale: 1.5, blendmode: 2 }).split('\n');
    assert.equal(lines[0], '[img01]');
    assert.ok(lines.includes('img=pm_depth_map'), 'a texture base name, no path or extension');
    assert.ok(lines.some((l) => l.startsWith('init_1=') && l.includes('blendmode=2') && l.includes('sx=1.5')));
    assert.ok(lines.some((l) => l.startsWith('code_1=') && l.includes('bass_att')));
    assert.ok(!lines.some((l) => /per_frame_|per_pixel_/.test(l)), 'preset keys mean nothing to a sprite');
});
