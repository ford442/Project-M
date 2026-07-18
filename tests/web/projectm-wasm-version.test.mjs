import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_VERSION,
    buildProjectMWasmUrls,
} from '../../html/projectm-wasm-version.js';

test('PROJECTM_WASM_BUNDLE matches version constant', () => {
    assert.equal(PROJECTM_WASM_BUNDLE, `projectm-v.${PROJECTM_WASM_VERSION}-thread`);
});

test('buildProjectMWasmUrls pins bundle paths under pm/', () => {
    const urls = buildProjectMWasmUrls('https://cdn.example');
    assert.equal(urls.scriptPm, 'https://cdn.example/pm/projectm-v.035-thread.1ijs');
    assert.equal(urls.wasm, 'https://cdn.example/pm/projectm-v.035-thread.wasm');
});
