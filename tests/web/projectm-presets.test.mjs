// Unit tests for html/projectm-presets.js: preset URL load mocks (fetch +
// Emscripten VFS write + ccall) and API base resolution.
// Run with: node --test tests/web/projectm-presets.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getPresetApiBases,
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
