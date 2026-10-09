// Unit tests for html/projectm-presets.js: preset URL load mocks (fetch +
// Emscripten VFS write + ccall) and API base resolution.
// Run with: node --test tests/web/projectm-presets.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fetchApiPreset,
    FALLBACK_PRESET_API_BASES,
    getConfiguredPresetApiBase,
    getPresetApiBases,
    loadRandomApiPreset,
    loadPresetFromUrl,
} from '../../html/projectm-presets.js';

// loadPresetFromUrl's `windowRef` option defaults to the bare `window` global,
// evaluated whenever the option is omitted (default params are eager) — so it
// must always be supplied under Node's `--test`, even with updateDisplay:false.
const noopWindowRef = /** @type {any} */ ({});

function fakeModule() {
    const written = [];
    const ccalls = [];
    return {
        FS: {
            writeFile: (path, data) => written.push({ path, data }),
        },
        ccall: (name, returnType, argTypes, args) => {
            ccalls.push({ name, args });
            return null;
        },
        written,
        ccalls,
    };
}

test('loadPresetFromUrl fetches the preset, writes it to the VFS, and loads it', async () => {
    const module = fakeModule();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        assert.equal(url, 'https://example.test/preset.milk');
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => bytes.buffer,
        };
    };

    try {
        const result = await loadPresetFromUrl('https://example.test/preset.milk', {
            module,
            windowRef: noopWindowRef,
            updateDisplay: false,
        });

        assert.equal(result.filename, 'preset.milk');
        assert.equal(result.url, 'https://example.test/preset.milk');
        assert.equal(module.written.length, 1);
        assert.equal(module.written[0].path, result.vfsPath);
        assert.deepEqual(Array.from(module.written[0].data), [1, 2, 3, 4]);

        assert.equal(module.ccalls.length, 1);
        assert.equal(module.ccalls[0].name, 'load_preset_file');
        assert.equal(module.ccalls[0].args[0], result.vfsPath);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('loadPresetFromUrl throws (and does not touch the VFS) on a non-OK response', async () => {
    const module = fakeModule();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });

    try {
        await assert.rejects(
            () => loadPresetFromUrl('https://example.test/missing.milk', { module, windowRef: noopWindowRef, updateDisplay: false }),
            /Failed to fetch preset \(404\)/
        );
        assert.equal(module.written.length, 0, 'a failed fetch must not write to the VFS');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('loadPresetFromUrl derives the filename from the URL and strips the query string', async () => {
    const module = fakeModule();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9]).buffer,
    });

    try {
        const result = await loadPresetFromUrl(
            'https://example.test/dir/cool%20preset.milk?v=2',
            { module, windowRef: noopWindowRef, updateDisplay: false }
        );
        assert.equal(result.filename, 'cool%20preset.milk');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('getPresetApiBases dedupes and orders preferred, storage override, then fallbacks', () => {
    const bases = getPresetApiBases({
        preferred: 'https://preferred.example',
        includeStorageOverride: false,
        fallbacks: ['https://fallback-a.example', 'https://preferred.example'],
    });
    assert.deepEqual(bases, ['https://preferred.example', 'https://fallback-a.example']);
});

test('FALLBACK_PRESET_API_BASES no longer lists the dead storage.1ink.us endpoint', () => {
    assert.ok(!FALLBACK_PRESET_API_BASES.some((b) => b.includes('storage.1ink.us')));
});

test('getConfiguredPresetApiBase: query beats window global beats storage beats default', () => {
    const storage = { getItem: () => 'https://stored.test' };
    assert.equal(getConfiguredPresetApiBase({ windowRef: { location: { search: '?presetApi=https://q.test/' } }, storage }), 'https://q.test');
    assert.equal(getConfiguredPresetApiBase({ windowRef: { location: { search: '' }, PROJECTM_PRESET_API_BASE: 'https://g.test' }, storage }), 'https://g.test');
    assert.equal(getConfiguredPresetApiBase({ windowRef: { location: { search: '' } }, storage }), 'https://stored.test');
    assert.equal(getConfiguredPresetApiBase({ windowRef: {}, storage: null }), 'https://storage.noahcohn.com');
});

test('fetchApiPreset rejects up front, without fetching, when there is no VFS and no writeBytes', async () => {
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error('unreachable'); };
    try {
        await assert.rejects(fetchApiPreset({ module: {}, apiBases: ['https://a.test'], presetDir: 'any' }), /writeBytes/);
        assert.equal(fetched, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fetchApiPreset routes bytes through writeBytes when the module has no FS (render worker)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes('/api/presets/random')) {
            return { ok: true, json: async () => ({ url: 'https://cdn.test/x.milk', filename: 'x.milk', dir: 'd' }) };
        }
        return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    };
    const writes = [];
    try {
        const result = await fetchApiPreset({
            module: {},
            apiBases: ['https://a.test'],
            presetDir: 'any',
            writeBytes: (path, bytes) => writes.push({ path, bytes }),
        });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, result.vfsPath);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('loadRandomApiPreset degrades to null on a 404, warning once per base', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
        const opts = { apiBases: ['https://dead-once.test'], presetDir: 'any', writeBytes: () => {} };
        assert.equal(await loadRandomApiPreset(opts), null);
        assert.equal(await loadRandomApiPreset(opts), null);
        assert.equal(warns.filter((w) => String(w[1]).includes('dead-once.test')).length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
    }
});
