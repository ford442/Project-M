// Unit tests for html/projectm-preset-cache.js — the IndexedDB store behind
// preset bytes and the transpiled-GLSL cache. Run with:
//   node --test tests/web/projectm-preset-cache.test.mjs
//
// Everything here goes through tests/web/helpers/fake-indexeddb.mjs; see that
// file for which parts of the IndexedDB contract are modelled and why.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PRESET_STORE,
    SHADER_STORE,
    cachePreset,
    defaultBasesForBase,
    getCachedPreset,
    openPresetCacheDb,
    preloadFavoritePresets,
    preloadFeaturedPack,
    touchShaderCacheEntry,
} from '../../html/projectm-preset-cache.js';
import {
    fakeStoreContents,
    installFakeIndexedDb,
    resetFakeIndexedDb,
} from './helpers/fake-indexeddb.mjs';

const DB_NAME = 'projectm-preset-cache';

/** Runs `fn` with a clean fake IndexedDB installed. */
async function withFakeDb(fn, options) {
    resetFakeIndexedDb();
    const restore = installFakeIndexedDb(options);
    try {
        return await fn();
    } finally {
        restore();
        resetFakeIndexedDb();
    }
}

test('defaultBasesForBase tries local dirs before the CDN', () => {
    assert.deepEqual(defaultBasesForBase('custom_milk_fixed'), [
        '../custom_milk_fixed/',
        './custom_milk_fixed/',
        'https://glsl.1ink.us/custom_milk/',
    ]);
    // Unknown bases fall back to the custom_milk list rather than 404ing on a
    // directory that does not exist.
    assert.deepEqual(defaultBasesForBase(undefined), defaultBasesForBase('nonsense'));
    assert.deepEqual(defaultBasesForBase('weeks_presets'), [
        '../weeks_presets/',
        './weeks_presets/',
        'https://glsl.1ink.us/weeks_presets/',
    ]);
});

test('openPresetCacheDb rejects when the environment has no IndexedDB', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    if (previous) delete globalThis.indexedDB;
    try {
        await assert.rejects(openPresetCacheDb(), /IndexedDB unavailable/);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    }
});

test('openPresetCacheDb rejects when the open request errors', async () => {
    await withFakeDb(async () => {
        await assert.rejects(openPresetCacheDb(), /fake indexedDB open failure/);
    }, { failOpen: true });
});

test('openPresetCacheDb creates both stores on first open', async () => {
    await withFakeDb(async () => {
        const db = await openPresetCacheDb();
        assert.equal(db.objectStoreNames.contains(PRESET_STORE), true);
        assert.equal(db.objectStoreNames.contains(SHADER_STORE), true);
        db.close();
    });
});

test('cachePreset then getCachedPreset round-trips the bytes and bumps the LRU stamp', async () => {
    await withFakeDb(async () => {
        const bytes = new Uint8Array([0x6d, 0x69, 0x6c, 0x6b]);
        assert.equal(await cachePreset('custom_milk_fixed::a.milk', bytes, { label: 'A' }), true);

        const stored = fakeStoreContents(DB_NAME, PRESET_STORE).get('custom_milk_fixed::a.milk');
        const firstUsedAt = stored.lastUsedAt;
        assert.deepEqual(stored.meta, { label: 'A' });

        // A read is a write: the row's lastUsedAt has to advance, or the LRU
        // eviction order in the shader store's sibling logic is meaningless.
        await new Promise((resolve) => setTimeout(resolve, 2));
        const row = await getCachedPreset('custom_milk_fixed::a.milk');
        assert.deepEqual(row.bytes, bytes);
        assert.ok(
            fakeStoreContents(DB_NAME, PRESET_STORE).get('custom_milk_fixed::a.milk').lastUsedAt > firstUsedAt,
            'getCachedPreset should refresh lastUsedAt',
        );
    });
});

test('getCachedPreset resolves null for a miss', async () => {
    await withFakeDb(async () => {
        assert.equal(await getCachedPreset('custom_milk_fixed::absent.milk'), null);
    });
});

test('touchShaderCacheEntry refreshes an existing row and ignores a missing one', async () => {
    await withFakeDb(async () => {
        const db = await openPresetCacheDb();
        await new Promise((resolve) => {
            const tx = db.transaction(SHADER_STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.objectStore(SHADER_STORE).put({ id: 'shader::1', lastUsedAt: 1 });
        });
        db.close();

        await touchShaderCacheEntry('shader::1');
        assert.ok(fakeStoreContents(DB_NAME, SHADER_STORE).get('shader::1').lastUsedAt > 1);

        // No row, no throw — callers fire-and-forget this one.
        await touchShaderCacheEntry('shader::missing');
        assert.equal(fakeStoreContents(DB_NAME, SHADER_STORE).has('shader::missing'), false);
    });
});

test('preloadFeaturedPack fetches uncached presets from the first base that answers', async () => {
    await withFakeDb(async () => {
        /** @type {string[]} */
        const requested = [];
        const fetchImpl = async (url) => {
            requested.push(url);
            // First base 404s, second serves — the loop must keep going.
            if (url.startsWith('../')) return { ok: false, status: 404 };
            return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
        };

        /** @type {Array<[number, number, string, string]>} */
        const progress = [];
        const count = await preloadFeaturedPack(
            { presets: [{ file: 'sub dir/a.milk', base: 'custom_milk_fixed' }] },
            {
                fetchImpl,
                onProgress: (done, total, entry, status) => progress.push([done, total, entry.file, status]),
            },
        );

        assert.equal(count, 1);
        assert.deepEqual(requested, [
            '../custom_milk_fixed/sub%20dir/a.milk',
            './custom_milk_fixed/sub%20dir/a.milk',
        ]);
        assert.deepEqual(progress, [[1, 1, 'sub dir/a.milk', 'stored']]);
        assert.deepEqual(
            fakeStoreContents(DB_NAME, PRESET_STORE).get('custom_milk_fixed::sub dir/a.milk').bytes,
            new Uint8Array([1, 2]),
        );
    });
});

test('preloadFeaturedPack reports cached entries without refetching, and misses without storing', async () => {
    await withFakeDb(async () => {
        await cachePreset('custom_milk_fixed::cached.milk', new Uint8Array([9]));

        let fetches = 0;
        const fetchImpl = async () => {
            fetches += 1;
            throw new Error('network down');
        };

        /** @type {string[]} */
        const statuses = [];
        const count = await preloadFeaturedPack(
            { presets: [{ file: 'cached.milk' }, { file: 'gone.milk' }] },
            { fetchImpl, onProgress: (_done, _total, _entry, status) => statuses.push(status) },
        );

        assert.equal(count, 2);
        assert.deepEqual(statuses, ['cached', 'miss']);
        // Only the uncached entry hit the network, once per candidate base.
        assert.equal(fetches, defaultBasesForBase(undefined).length);
        assert.equal(fakeStoreContents(DB_NAME, PRESET_STORE).has('custom_milk_fixed::gone.milk'), false);
    });
});

test('preloadFeaturedPack tolerates a null manifest', async () => {
    await withFakeDb(async () => {
        assert.equal(await preloadFeaturedPack(null), 0);
        assert.equal(await preloadFeaturedPack({}), 0);
    });
});

test('preloadFavoritePresets only preloads the favorited ids', async () => {
    await withFakeDb(async () => {
        const all = [
            { file: 'fav.milk', base: 'custom_milk_fixed' },
            { file: 'other.milk', base: 'custom_milk_fixed' },
        ];
        /** @type {string[]} */
        const requested = [];
        const fetchImpl = async (url) => {
            requested.push(url);
            return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([7]).buffer };
        };

        const count = await preloadFavoritePresets(all, ['custom_milk_fixed::fav.milk'], { fetchImpl });
        assert.equal(count, 1);
        assert.deepEqual(requested, ['../custom_milk_fixed/fav.milk']);

        // A Set is accepted as well as an array, and an empty selection short-circuits.
        assert.equal(await preloadFavoritePresets(all, new Set(), { fetchImpl }), 0);
        assert.equal(await preloadFavoritePresets(null, ['x'], { fetchImpl }), 0);
    });
});
