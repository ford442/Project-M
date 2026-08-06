import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_VERSION,
    buildProjectMWasmUrls,
    buildWasmBundlePaths,
    normalizeWasmVersion,
    remapSmokeWasmArtifactName,
} from '../../html/projectm-wasm-version.js';
import { resolveSelectedWasmVersion } from '../../html/projectm-init.js';

test('PROJECTM_WASM_BUNDLE matches version constant', () => {
    assert.equal(PROJECTM_WASM_BUNDLE, `projectm-v.${PROJECTM_WASM_VERSION}-thread`);
});

test('buildProjectMWasmUrls pins bundle paths under pm/', () => {
    const urls = buildProjectMWasmUrls('https://cdn.example');
    assert.equal(urls.scriptPm, 'https://cdn.example/pm/projectm-v.035-thread.js');
    assert.equal(urls.wasm, 'https://cdn.example/pm/projectm-v.035-thread.wasm');
});

test('normalizeWasmVersion accepts tags and full bundle names', () => {
    assert.equal(normalizeWasmVersion('033'), '033');
    assert.equal(normalizeWasmVersion('v.030b'), '030b');
    assert.equal(normalizeWasmVersion('projectm-v.034-thread'), '034');
    assert.equal(normalizeWasmVersion('999'), null);
});

test('buildWasmBundlePaths prefers .js for canonical version and .1ijs for older tags', () => {
    assert.deepEqual(buildWasmBundlePaths('035'), {
        version: '035',
        bundle: 'projectm-v.035-thread',
        glueExt: 'js',
        pmScript: './pm/projectm-v.035-thread.js',
        rootScript: './projectm-v.035-thread.js',
    });
    assert.equal(buildWasmBundlePaths('030').glueExt, '1ijs');
    assert.equal(buildWasmBundlePaths('030').pmScript, './pm/projectm-v.030-thread.1ijs');
});

test('resolveSelectedWasmVersion prefers ?wasm= over storage', () => {
    const storage = {
        getItem: () => '032',
    };
    assert.equal(
        resolveSelectedWasmVersion({ searchParams: '?wasm=034', storage }),
        '034'
    );
    assert.equal(
        resolveSelectedWasmVersion({ searchParams: '', storage }),
        '032'
    );
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
