// Unit tests for html/projectm-preset-library.js — manifest filtering,
// favorites-weighted random selection, and the multi-base preset load path.
// Run with: node --test tests/web/projectm-preset-library.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_FEATURED_MANIFEST_URL,
    collectTags,
    fetchFeaturedManifest,
    filterPresets,
    loadPresetEntry,
    matchFilters,
    pickWeightedRandom,
    presetId,
} from '../../html/projectm-preset-library.js';
import { cachePreset } from '../../html/projectm-preset-cache.js';
import { installFakeIndexedDb, resetFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

/** A module handle that satisfies canLoadPresets() and records what it is told. */
function fakeModule() {
    /** @type {Array<{ path: string, data: Uint8Array }>} */
    const written = [];
    /** @type {Array<{ name: string, args: unknown[] }>} */
    const ccalls = [];
    return {
        FS: { writeFile: (path, data) => written.push({ path, data }) },
        ccall: (name, _returnType, _argTypes, args) => { ccalls.push({ name, args }); return null; },
        written,
        ccalls,
    };
}

function okResponse(bytes) {
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
}

test('collectTags returns the sorted unique tag set', () => {
    assert.deepEqual(
        collectTags([
            { tags: ['warp', 'bass'] },
            { tags: ['bass'] },
            {},
        ]),
        ['bass', 'warp'],
    );
    assert.deepEqual(collectTags([]), []);
});

test('matchFilters searches label, file, tags, author, project, tier and reactivity', () => {
    const preset = {
        label: 'Aurora',
        file: 'aurora.milk',
        tags: ['warp'],
        author: 'Flexi',
        project: 'signature',
        tier: 'gold',
        reactivity: 'high',
    };
    for (const query of ['aurora', 'MILK', 'warp', 'flexi', 'signature', 'gold', 'high']) {
        assert.equal(matchFilters(preset, { query }, new Set()), true, `query ${query} should match`);
    }
    assert.equal(matchFilters(preset, { query: 'nothing' }, new Set()), false);
    // A blank / whitespace query is not a filter.
    assert.equal(matchFilters(preset, { query: '   ' }, new Set()), true);
});

test('matchFilters applies the tag, tier, reactivity and pack filters', () => {
    const preset = { file: 'a.milk', tags: ['warp'], tier: 'gold', reactivity: 'high', featured: true };
    assert.equal(matchFilters(preset, { tag: 'warp' }, new Set()), true);
    assert.equal(matchFilters(preset, { tag: 'bass' }, new Set()), false);
    assert.equal(matchFilters(preset, { tag: 'all' }, new Set()), true);
    assert.equal(matchFilters(preset, { tier: 'silver' }, new Set()), false);
    assert.equal(matchFilters(preset, { reactivity: 'low' }, new Set()), false);
    assert.equal(matchFilters(preset, { pack: 'featured' }, new Set()), true);
    assert.equal(matchFilters({ file: 'b.milk' }, { pack: 'featured' }, new Set()), false);

    assert.equal(matchFilters(preset, { pack: 'favorites' }, new Set()), false);
    assert.equal(
        matchFilters(preset, { pack: 'favorites' }, new Set([presetId(preset)])),
        true,
    );
});

test('matchFilters drops broken presets under onlyOk / excludeBroken', () => {
    const broken = { file: 'b.milk', status: 'broken' };
    assert.equal(matchFilters(broken, {}, new Set()), true);
    assert.equal(matchFilters(broken, { onlyOk: true }, new Set()), false);
    assert.equal(matchFilters(broken, { excludeBroken: true }, new Set()), false);
});

test('filterPresets keeps manifest order', () => {
    const presets = [
        { file: 'a.milk', tags: ['warp'] },
        { file: 'b.milk', tags: ['bass'] },
        { file: 'c.milk', tags: ['warp'] },
    ];
    assert.deepEqual(
        filterPresets(presets, { tag: 'warp' }).map((p) => p.file),
        ['a.milk', 'c.milk'],
    );
});

test('pickWeightedRandom weights favorites and known-good presets above the rest', () => {
    const plain = { file: 'plain.milk' };
    const good = { file: 'good.milk', status: 'ok' };
    const favorite = { file: 'fav.milk' };
    const favorites = new Set([presetId(favorite)]);

    // Weights: plain 5, good 5+3=8, favorite 5+4=9 (total 22). Driving
    // Math.random() by hand turns the cumulative walk into an exact assertion.
    const originalRandom = Math.random;
    try {
        const pickAt = (fraction) => {
            Math.random = () => fraction;
            return pickWeightedRandom([plain, good, favorite], { favorites });
        };
        assert.equal(pickAt(0).file, 'plain.milk');
        assert.equal(pickAt(4 / 22).file, 'plain.milk');
        assert.equal(pickAt(6 / 22).file, 'good.milk');
        assert.equal(pickAt(12 / 22).file, 'good.milk');
        assert.equal(pickAt(14 / 22).file, 'fav.milk');
        // Float error at the very top of the range must still return a preset.
        Math.random = () => 0.999999999;
        assert.ok(pickWeightedRandom([plain, good, favorite], { favorites }));
    } finally {
        Math.random = originalRandom;
    }
});

test('pickWeightedRandom falls back rather than returning null when filters empty the pool', () => {
    const broken = { file: 'broken.milk', status: 'broken' };
    const unknown = { file: 'unknown.milk' };

    // onlyOk leaves nothing, so the non-broken presets come back...
    assert.equal(pickWeightedRandom([broken, unknown], { onlyOk: true, favorites: new Set() }).file, 'unknown.milk');
    // ...and when every preset is broken, the caller still gets one.
    assert.equal(pickWeightedRandom([broken], { onlyOk: true, favorites: new Set() }).file, 'broken.milk');
    assert.equal(pickWeightedRandom([], { favorites: new Set() }), null);
});

test('fetchFeaturedManifest reads the default URL and rejects on HTTP failure', async () => {
    /** @type {string[]} */
    const urls = [];
    const fetchImpl = async (url) => {
        urls.push(url);
        if (url === DEFAULT_FEATURED_MANIFEST_URL) {
            return { ok: true, status: 200, json: async () => ({ presets: [{ file: 'a.milk' }] }) };
        }
        return { ok: false, status: 503 };
    };

    const manifest = await fetchFeaturedManifest({ fetchImpl });
    assert.deepEqual(manifest.presets, [{ file: 'a.milk' }]);
    assert.deepEqual(urls, [DEFAULT_FEATURED_MANIFEST_URL]);

    await assert.rejects(
        fetchFeaturedManifest({ url: './missing.json', fetchImpl }),
        /Featured pack manifest HTTP 503/,
    );
});

test('loadPresetEntry rejects before touching the network when the module is not ready', async () => {
    await assert.rejects(loadPresetEntry({ file: 'a.milk' }, {}), /Module not ready/);
    await assert.rejects(loadPresetEntry({ file: 'a.milk' }, { module: { FS: {} } }), /Module not ready/);
});

test('loadPresetEntry falls forward through the base list and writes the preset into the VFS', async () => {
    const module = fakeModule();
    const bytes = new Uint8Array([1, 2, 3]);
    /** @type {string[]} */
    const requested = [];
    const fetchImpl = async (url) => {
        requested.push(url);
        if (url.startsWith('../')) throw new Error('offline');
        if (url.startsWith('./')) return { ok: false, status: 404 };
        return okResponse(bytes);
    };

    const result = await loadPresetEntry(
        { file: 'nested/Aurora Beam.milk', base: 'custom_milk_fixed', label: 'Aurora' },
        { module, fetchImpl, updateDisplay: false, startTransitionWhenReady: null },
    );

    // Only the basename is fetched and written — the manifest path is not a URL path.
    assert.deepEqual(requested, [
        '../custom_milk_fixed/Aurora%20Beam.milk',
        './custom_milk_fixed/Aurora%20Beam.milk',
        'https://glsl.1ink.us/custom_milk/Aurora%20Beam.milk',
    ]);
    assert.equal(result.filename, 'Aurora Beam.milk');
    // The VFS name is sanitised: spaces and other characters become '_'.
    assert.equal(result.vfsPath, '/presets/custom_milk_fixed_Aurora_Beam.milk');
    assert.deepEqual(module.written, [{ path: result.vfsPath, data: bytes }]);
    assert.deepEqual(
        module.ccalls.map((c) => c.name),
        ['load_preset_file'],
    );
    assert.deepEqual(module.ccalls[0].args, [result.vfsPath]);
});

test('loadPresetEntry rejects with the last fetch error when every base fails', async () => {
    const module = fakeModule();
    await assert.rejects(
        loadPresetEntry({ file: 'a.milk' }, {
            module,
            updateDisplay: false,
            startTransitionWhenReady: null,
            fetchImpl: async () => ({ ok: false, status: 500 }),
        }),
        /HTTP 500/,
    );
    assert.deepEqual(module.written, []);
});

test('loadPresetEntry honours an explicit base list', async () => {
    const module = fakeModule();
    /** @type {string[]} */
    const requested = [];
    await loadPresetEntry({ file: 'a.milk' }, {
        module,
        bases: ['https://example.test/presets'],
        updateDisplay: false,
        startTransitionWhenReady: null,
        fetchImpl: async (url) => {
            requested.push(url);
            return okResponse(new Uint8Array([4]));
        },
    });
    // No trailing slash on the base: the separator is inserted.
    assert.deepEqual(requested, ['https://example.test/presets/a.milk']);
});

test('loadPresetEntry serves a cached preset without fetching, and starts the transition', async () => {
    resetFakeIndexedDb();
    const restoreIdb = installFakeIndexedDb();
    try {
        const module = fakeModule();
        const bytes = new Uint8Array([5, 6]);
        await cachePreset(presetId({ file: 'a.milk' }), bytes);

        /** @type {Array<Record<string, unknown>>} */
        const transitions = [];
        const result = await loadPresetEntry({ file: 'a.milk' }, {
            module,
            updateDisplay: false,
            transitionDurationSec: 2.5,
            startTransitionWhenReady: async (opts) => { transitions.push(opts); return true; },
            fetchImpl: async () => { throw new Error('should not fetch a cached preset'); },
        });

        assert.deepEqual(module.written, [{ path: result.vfsPath, data: bytes }]);
        assert.equal(transitions.length, 1);
        assert.equal(transitions[0].durationSec, 2.5);
    } finally {
        restoreIdb();
        resetFakeIndexedDb();
        delete globalThis.pmOnTranspiledShaderStored;
    }
});
