// Unit tests for the pure logic in html/projectm-preset-picker.js.
// Run with: node --test tests/web/preset-picker.test.mjs
//
// These cover the load-bearing, browser-independent parts (manifest parsing,
// base fallback, random selection, and the VFS-write → load_preset_file flow)
// with mocked fetch / Module so they run without a browser or WASM build.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    fetchCustomPresetManifest,
    getCustomPresetBases,
    loadCustomPresetFile,
    pickRandomFromList,
    DEFAULT_CUSTOM_PRESET_BASES
} from '../../html/projectm-preset-picker.js';

function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}
function bytesResponse(bytes, ok = true, status = 200) {
    return Promise.resolve({ ok, status, arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer) });
}

function makeModule() {
    const calls = [];
    return {
        calls,
        FS: { writeFile: (path, bytes) => calls.push({ kind: 'write', path, len: bytes.length }) },
        _load_preset_file: () => {},
        ccall: (fn, ret, types, args) => calls.push({ kind: 'ccall', fn, args })
    };
}

test('fetchCustomPresetManifest returns the manifest object with presets[]', async () => {
    // The helper resolves to the whole manifest (callers read `data.presets`
    // alongside sibling metadata), not to a bare array.
    const manifest = await fetchCustomPresetManifest({
        url: 'x',
        fetchImpl: () => jsonResponse({
            generated: '2026-01-01',
            presets: [{ file: 'a.milk', label: 'A', status: 'ok' }]
        })
    });
    assert.equal(manifest.presets.length, 1);
    assert.equal(manifest.presets[0].file, 'a.milk');
    assert.equal(manifest.generated, '2026-01-01');
});

test('fetchCustomPresetManifest rejects malformed manifest', async () => {
    await assert.rejects(
        fetchCustomPresetManifest({ url: 'x', fetchImpl: () => jsonResponse({ nope: true }) }),
        /missing presets/
    );
});

test('getCustomPresetBases includes defaults and dedupes', () => {
    const bases = getCustomPresetBases({ preferred: DEFAULT_CUSTOM_PRESET_BASES[0] });
    assert.ok(bases.includes('https://glsl.1ink.us/custom_milk/'));
    // preferred duplicate of a default must not appear twice
    assert.equal(bases.filter((b) => b === DEFAULT_CUSTOM_PRESET_BASES[0]).length, 1);
});

test('pickRandomFromList honours onlyOk, falls back when no ok presets', () => {
    const list = [
        { file: 'a', status: 'ok' },
        { file: 'b', status: 'broken' }
    ];
    for (let i = 0; i < 20; i++) {
        assert.equal(pickRandomFromList(list, { onlyOk: true }).file, 'a');
    }
    const allBroken = [{ file: 'x', status: 'broken' }];
    assert.equal(pickRandomFromList(allBroken, { onlyOk: true }).file, 'x'); // fallback to full pool
    assert.equal(pickRandomFromList([]), null);
});

test('loadCustomPresetFile falls through bases until one succeeds', async () => {
    const module = makeModule();
    const tried = [];
    // 404 whichever base is attempted first, so the assertion tracks
    // "retries the next base", not a hard-coded base ordering. The load path
    // resolves bases through defaultBasesForBase() in projectm-preset-cache.js
    // (local dirs first, CDN last) — not the picker's DEFAULT_CUSTOM_PRESET_BASES
    // (CDN first), which the two lists disagree about.
    const fetchImpl = (url) => {
        tried.push(url);
        if (tried.length === 1) return bytesResponse([], false, 404); // first base 404s
        return bytesResponse([1, 2, 3, 4]); // next base serves
    };
    const result = await loadCustomPresetFile('milk012.milk', {
        module,
        updateDisplay: false,
        fetchImpl
    });
    assert.equal(tried.length, 2, 'should retry the second base after a 404');
    assert.equal(result.filename, 'milk012.milk');
    // VFS path is /presets/<entry.base>_<sanitised filename>; loadCustomPresetFile
    // pins entry.base to 'custom_milk_fixed'.
    assert.match(result.vfsPath, /^\/presets\/custom_milk_fixed_milk012\.milk$/);
    const write = module.calls.find((c) => c.kind === 'write');
    const load = module.calls.find((c) => c.kind === 'ccall');
    assert.equal(write.len, 4);
    assert.equal(load.fn, 'load_preset_file');
    assert.equal(load.args[0], write.path);
});

test('loadCustomPresetFile rejects when module not ready', async () => {
    await assert.rejects(
        loadCustomPresetFile('a.milk', { module: {}, fetchImpl: () => bytesResponse([1]) }),
        /Module not ready/
    );
});

test('loadCustomPresetFile throws after exhausting all bases', async () => {
    await assert.rejects(
        loadCustomPresetFile('a.milk', {
            module: makeModule(),
            updateDisplay: false,
            bases: ['https://one/', 'https://two/'],
            fetchImpl: () => bytesResponse([], false, 500)
        }),
        /HTTP 500/
    );
});
