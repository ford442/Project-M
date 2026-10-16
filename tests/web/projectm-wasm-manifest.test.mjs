import assert from 'node:assert/strict';
import test from 'node:test';
import {
    loadWasmBuildsManifest,
    resetWasmBuildsManifestCache,
    wasmBuildsManifestUrl,
} from '../../html/projectm-wasm-manifest.js';
import {
    buildWasmBundlePaths,
    getWasmBuildsManifest,
    setWasmBuildsManifest,
} from '../../html/projectm-wasm-version.js';
import { createWorkerTransport } from '../../html/projectm-render-transport.js';

const MANIFEST = {
    schema: 1,
    default: '039',
    latest: '040',
    builds: {
        '039': { glue: 'pm/projectm-v.039-thread.js', wasm: 'pm/projectm-v.039-thread.wasm', api: ['set_rhythm_events'], status: 'stable' },
        '040': { glue: 'pm/projectm-v.040-thread.js', wasm: 'pm/projectm-v.040-thread.wasm', api: [], status: 'beta' },
    },
};

/**
 * @param {{ status?: number, type?: string, body?: unknown, delayMs?: number }} [reply]
 */
function fakeFetch({ status = 200, type = 'application/json; charset=utf-8', body = MANIFEST, delayMs = 0 } = {}) {
    const calls = [];
    const impl = (url, init) => {
        calls.push({ url, init });
        const response = {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
            json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        };
        if (!delayMs) return Promise.resolve(response);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(response), delayMs);
            init?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
        });
    };
    return { impl, calls };
}

function fresh() {
    resetWasmBuildsManifestCache();
    setWasmBuildsManifest(null);
}

test('wasmBuildsManifestUrl resolves pm/builds.json against the site root or page', () => {
    assert.equal(wasmBuildsManifestUrl('https://projectm.1ink.us/1ink.1ink?wasm=039'), 'https://projectm.1ink.us/pm/builds.json');
    assert.equal(wasmBuildsManifestUrl('https://test.1ink.us/projectm.1ink.us/projectm-context.js'), 'https://test.1ink.us/projectm.1ink.us/pm/builds.json');
});

test('a fetched manifest is registered and drives bundle paths', async () => {
    fresh();
    const { impl, calls } = fakeFetch();
    const manifest = await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl });
    assert.equal(manifest?.default, '039');
    assert.equal(getWasmBuildsManifest(), manifest);
    assert.equal(calls[0].url, 'https://cdn.test/pm/builds.json');
    assert.equal(calls[0].init.cache, 'no-cache');
    assert.equal(buildWasmBundlePaths('040').pmScript, './pm/projectm-v.040-thread.js');
    fresh();
});

test('concurrent and repeated loads share one request; force starts another', async () => {
    fresh();
    const { impl, calls } = fakeFetch();
    const [a, b] = await Promise.all([
        loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl }),
        loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl }),
    ]);
    assert.equal(a, b);
    await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl });
    assert.equal(calls.length, 1);
    await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl, force: true });
    assert.equal(calls.length, 2);
    fresh();
});

test('soft 404s, bad JSON and failed requests resolve null and keep the built-in table', async () => {
    for (const reply of [
        { status: 404 },
        { type: 'text/html; charset=utf-16', body: {} },
        { body: '{not json' },
        { body: { schema: 99, builds: {} } },
    ]) {
        fresh();
        const { impl } = fakeFetch(reply);
        assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl }), null, JSON.stringify(reply));
        assert.equal(getWasmBuildsManifest(), null);
        assert.equal(buildWasmBundlePaths('039').source, 'builtin');
    }
    fresh();
    const rejecting = () => Promise.reject(new TypeError('network down'));
    assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: rejecting }), null);
    assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: undefined }), null);
});

test('a failed load is not cached: the next call tries again', async () => {
    fresh();
    let fail = true;
    let calls = 0;
    const impl = (url, init) => {
        calls += 1;
        return fail ? Promise.reject(new TypeError('offline')) : fakeFetch().impl(url, init);
    };
    assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl }), null);
    fail = false;
    assert.ok(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl }));
    assert.equal(calls, 2);
    fresh();
});

test('a slow manifest times out to null', async () => {
    fresh();
    const { impl } = fakeFetch({ delayMs: 1000 });
    const started = Date.now();
    assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://slow.test/', fetchImpl: impl, timeoutMs: 20 }), null);
    assert.ok(Date.now() - started < 900, 'did not wait for the response');
    fresh();
});

test('an aborted caller stops waiting while the shared request carries on', async () => {
    fresh();
    const { impl } = fakeFetch({ delayMs: 30 });
    const controller = new AbortController();
    const aborted = loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl, signal: controller.signal });
    const other = loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl });
    controller.abort();
    assert.equal(await aborted, null);
    assert.equal((await other)?.default, '039');
    const preAborted = new AbortController();
    preAborted.abort();
    assert.equal(await loadWasmBuildsManifest({ baseUrl: 'https://cdn.test/', fetchImpl: impl, signal: preAborted.signal }), null);
    fresh();
});

test('worker transport supports() answers from the build export list when it has one', () => {
    const handle = { ccall() {}, ccallVoid() {}, feedPcm() {}, postPreset() {}, worker: { terminate() {} } };
    const gated = createWorkerTransport(/** @type {any} */ (handle), { exports: ['set_rhythm_events', 'set_context_config'] });
    assert.equal(gated.supports('setRhythmEvents'), true);
    assert.equal(gated.supports('getRhythmBpm'), false, '038 has no rhythm exports');
    const open = createWorkerTransport(/** @type {any} */ (handle));
    assert.equal(open.supports('getRhythmBpm'), true, 'unknown export list: assume available');
});
