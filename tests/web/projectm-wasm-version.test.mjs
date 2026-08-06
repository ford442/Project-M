import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_VERSION,
    buildProjectMWasmUrls,
    remapSmokeWasmArtifactName,
} from '../../html/projectm-wasm-version.js';

test('PROJECTM_WASM_BUNDLE matches version constant', () => {
    assert.equal(PROJECTM_WASM_BUNDLE, `projectm-v.${PROJECTM_WASM_VERSION}-thread`);
});

test('buildProjectMWasmUrls pins bundle paths under pm/', () => {
    const urls = buildProjectMWasmUrls('https://cdn.example');
    assert.equal(urls.scriptPm, 'https://cdn.example/pm/projectm-v.035-thread.js');
    assert.equal(urls.wasm, 'https://cdn.example/pm/projectm-v.035-thread.wasm');
});

test('remapSmokeWasmArtifactName rewrites smoke tag to deploy bundle', () => {
    assert.equal(
        remapSmokeWasmArtifactName('projectm-v.030-thread.wasm'),
        'projectm-v.035-thread.wasm'
    );
    assert.equal(
        remapSmokeWasmArtifactName('pm/projectm-v.030-thread.worker.js'),
        'pm/projectm-v.035-thread.worker.js'
    );
    assert.equal(
        remapSmokeWasmArtifactName('projectm-v.035-thread.wasm'),
        'projectm-v.035-thread.wasm'
    );
    assert.equal(
        remapSmokeWasmArtifactName('projectm-v.030-thread.wasm', 'projectm-v.030-thread'),
        'projectm-v.030-thread.wasm'
    );
});
