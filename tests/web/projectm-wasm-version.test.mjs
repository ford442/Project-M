import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_BUNDLE,
    PROJECTM_WASM_DEFAULT_VERSION,
    PROJECTM_WASM_SELECTABLE_VERSIONS,
    PROJECTM_WASM_VERSION,
    buildProjectMWasmUrls,
    buildWasmBundlePaths,
    getDefaultWasmVersion,
    getSelectableWasmVersions,
    getWasmBuildsManifest,
    normalizeWasmVersion,
    parseWasmBuildsManifest,
    remapSmokeWasmArtifactName,
    setWasmBuildsManifest,
    wasmBuildHasApi,
} from '../../html/projectm-wasm-version.js';
import { resolveSelectedWasmVersion } from '../../html/projectm-init.js';

test('PROJECTM_WASM_BUNDLE matches version constant', () => {
    assert.equal(PROJECTM_WASM_BUNDLE, `projectm-v.${PROJECTM_WASM_VERSION}-thread`);
});

test('host default is a selectable version (may lag the latest bundle)', () => {
    assert.equal(PROJECTM_WASM_DEFAULT_VERSION, '039');
    assert.equal(PROJECTM_WASM_SELECTABLE_VERSIONS.includes(PROJECTM_WASM_DEFAULT_VERSION), true);
});

test('buildProjectMWasmUrls pins bundle paths under pm/', () => {
    const urls = buildProjectMWasmUrls('https://cdn.example');
    assert.equal(urls.scriptPm, `https://cdn.example/pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.js`);
    assert.equal(urls.wasm, `https://cdn.example/pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`);
});

test('normalizeWasmVersion accepts tags and full bundle names', () => {
    assert.equal(normalizeWasmVersion('033'), '033');
    assert.equal(normalizeWasmVersion('v.030b'), '030b');
    assert.equal(normalizeWasmVersion('projectm-v.034-thread'), '034');
    assert.equal(normalizeWasmVersion('999'), null);
});

test('buildWasmBundlePaths prefers .js for canonical version and .1ijs for older tags', () => {
    assert.deepEqual(buildWasmBundlePaths(PROJECTM_WASM_VERSION), {
        version: PROJECTM_WASM_VERSION,
        bundle: `projectm-v.${PROJECTM_WASM_VERSION}-thread`,
        glueExt: 'js',
        pmScript: `./pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.js`,
        rootScript: `./projectm-v.${PROJECTM_WASM_VERSION}-thread.js`,
        source: 'builtin',
        api: null,
        status: null,
    });
    assert.equal(buildWasmBundlePaths('034').glueExt, '1ijs');
    assert.equal(buildWasmBundlePaths('034').pmScript, './pm/projectm-v.034-thread.1ijs');
    assert.equal(buildWasmBundlePaths('030b').glueExt, '1ijs');
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
    assert.equal(
        resolveSelectedWasmVersion({
            searchParams: '',
            storage: { getItem: () => null },
        }),
        PROJECTM_WASM_DEFAULT_VERSION
    );
});

test('remapSmokeWasmArtifactName rewrites smoke tag to deploy bundle', () => {
    assert.equal(
        remapSmokeWasmArtifactName('projectm-v.030-thread.wasm'),
        `projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`
    );
    assert.equal(
        remapSmokeWasmArtifactName('pm/projectm-v.030-thread.worker.js'),
        `pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.worker.js`
    );
    assert.equal(
        remapSmokeWasmArtifactName(`projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`),
        `projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`
    );
    assert.equal(
        remapSmokeWasmArtifactName('projectm-v.030-thread.wasm', 'projectm-v.030-thread'),
        'projectm-v.030-thread.wasm'
    );
});

test('the built-in table uses UTF-8 .js where production has it (030, 035-039)', () => {
    assert.equal(buildWasmBundlePaths('039').pmScript, './pm/projectm-v.039-thread.js');
    for (const version of ['030', '035', '036', '037', '038']) {
        assert.equal(buildWasmBundlePaths(version).glueExt, 'js', version);
    }
    for (const version of ['030b', '032', '033', '034']) {
        assert.equal(buildWasmBundlePaths(version).glueExt, '1ijs', version);
    }
});

/** A manifest as scripts/generate_wasm_builds_manifest.mjs writes it. */
function sampleManifest() {
    return {
        schema: 1,
        generatedAt: '2026-10-16T00:00:00.000Z',
        default: '039',
        latest: '040',
        builds: {
            '034': { glue: 'pm/projectm-v.034-thread.js', wasm: 'pm/projectm-v.034-thread.wasm', worker: null, sha256: { glue: 'a', wasm: 'b' }, api: ['init'], status: 'legacy' },
            '039': { glue: 'pm/projectm-v.039-thread.js', wasm: 'pm/projectm-v.039-thread.wasm', worker: null, sha256: {}, api: ['init', 'set_rhythm_events'], status: 'stable' },
            '040': { glue: 'pm/projectm-v.040-thread.js', wasm: 'pm/projectm-v.040-thread.wasm', worker: 'pm/projectm-v.040-thread.worker.js', sha256: {}, status: 'beta' },
            '031': { glue: 'pm/projectm-v.031-thread.js', wasm: 'pm/projectm-v.031-thread.wasm', status: 'withdrawn' },
        },
    };
}

test('parseWasmBuildsManifest keeps valid builds and drops unsafe or malformed ones', () => {
    const raw = sampleManifest();
    raw.builds['666'] = { glue: 'https://evil.example/x.js', wasm: 'pm/x.wasm' };
    raw.builds['667'] = { glue: '../outside.js', wasm: 'pm/x.wasm' };
    raw.builds['668'] = { glue: '/pm/abs.js', wasm: 'pm/x.wasm' };
    raw.builds['not-a-version'] = { glue: 'pm/x.js', wasm: 'pm/x.wasm' };
    const manifest = parseWasmBuildsManifest(raw);
    assert.ok(manifest);
    assert.deepEqual(Object.keys(manifest.builds).sort(), ['031', '034', '039', '040']);
    assert.equal(manifest.default, '039');
    assert.equal(manifest.latest, '040');
    assert.equal(manifest.builds['040'].api, null, 'no api list means unknown, not empty');
    assert.equal(manifest.builds['040'].worker, 'pm/projectm-v.040-thread.worker.js');
});

test('parseWasmBuildsManifest rejects other schemas and empty manifests', () => {
    assert.equal(parseWasmBuildsManifest(null), null);
    assert.equal(parseWasmBuildsManifest('<html>404</html>'), null);
    assert.equal(parseWasmBuildsManifest({ ...sampleManifest(), schema: 2 }), null);
    assert.equal(parseWasmBuildsManifest({ schema: 1, builds: {} }), null);
});

test('parseWasmBuildsManifest falls back to the latest build for a default it does not list', () => {
    const manifest = parseWasmBuildsManifest({ ...sampleManifest(), default: '099', latest: undefined });
    assert.equal(manifest?.latest, '040');
    assert.equal(manifest?.default, '040');
});

test('a registered manifest drives paths, selectable versions and the default', () => {
    const manifest = parseWasmBuildsManifest(sampleManifest());
    setWasmBuildsManifest(manifest);
    try {
        assert.equal(getWasmBuildsManifest(), manifest);
        // 040 is newer than the built-in list but deployed: selectable now.
        assert.equal(normalizeWasmVersion('040'), '040');
        assert.equal(normalizeWasmVersion('projectm-v.040-thread'), '040');
        const paths = buildWasmBundlePaths('040');
        assert.equal(paths.source, 'manifest');
        assert.equal(paths.pmScript, './pm/projectm-v.040-thread.js');
        assert.equal(paths.rootScript, paths.pmScript, 'no root-layout guess');
        assert.equal(paths.glueExt, 'js');
        assert.equal(paths.status, 'beta');
        // 034 is a transcoded legacy build: the manifest's UTF-8 glue wins over the table.
        assert.equal(buildWasmBundlePaths('034').pmScript, './pm/projectm-v.034-thread.js');
        assert.deepEqual(buildWasmBundlePaths('039').api, ['init', 'set_rhythm_events']);
        // Withdrawn builds still resolve (an old link keeps working) but are not offered.
        assert.deepEqual(getSelectableWasmVersions(), ['040', '039', '034']);
        assert.equal(getDefaultWasmVersion(), '039');
        const urls = buildProjectMWasmUrls('https://cdn.example/', '040');
        assert.equal(urls.wasm, 'https://cdn.example/pm/projectm-v.040-thread.wasm');
        assert.equal(urls.worker, 'https://cdn.example/pm/projectm-v.040-thread.worker.js');
        // A version the manifest does not list falls back to the built-in table.
        assert.equal(buildWasmBundlePaths('033').source, 'builtin');
    } finally {
        setWasmBuildsManifest(null);
    }
    assert.equal(normalizeWasmVersion('040'), null);
    assert.equal(getSelectableWasmVersions(), PROJECTM_WASM_SELECTABLE_VERSIONS);
    assert.equal(getDefaultWasmVersion(), PROJECTM_WASM_DEFAULT_VERSION);
});

test('wasmBuildHasApi gates on the export list and allows everything when it is unknown', () => {
    const build = { api: ['init', 'set_rhythm_events'] };
    assert.equal(wasmBuildHasApi(build, 'set_rhythm_events'), true);
    assert.equal(wasmBuildHasApi(build, '_set_rhythm_events'), true);
    assert.equal(wasmBuildHasApi(build, 'get_rhythm_bpm'), false);
    assert.equal(wasmBuildHasApi({ api: null }, 'anything'), true);
    assert.equal(wasmBuildHasApi(null, 'anything'), true);
});
