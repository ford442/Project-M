import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    PROJECTM_WASM_VERSION,
    buildProjectMLocateFile,
    createProjectMModule,
    ensureDefaultWasmQueryParam,
    isUsableWasmScriptResponse,
    loadScript,
    observeModuleSize,
    resetWasmScriptCacheForTests,
    resolveWasmScriptUrl
} from '../../html/projectm-init.js';

test('ensureDefaultWasmQueryParam adds wasm when missing', () => {
    const calls = [];
    const locationRef = {
        pathname: '/1ink.1ink',
        search: '?mode=weeks_on_fire',
        hash: '#panel',
        replace: (url) => calls.push(url),
    };
    assert.equal(
        ensureDefaultWasmQueryParam({ locationRef }),
        true
    );
    assert.deepEqual(calls, ['/1ink.1ink?mode=weeks_on_fire&wasm=032#panel']);
});

test('ensureDefaultWasmQueryParam is a no-op when wasm is present', () => {
    const calls = [];
    const locationRef = {
        pathname: '/1ink.1ink',
        search: '?wasm=034',
        hash: '',
        replace: (url) => calls.push(url),
    };
    assert.equal(ensureDefaultWasmQueryParam({ locationRef }), false);
    assert.deepEqual(calls, []);
});

test('resolveWasmScriptUrl prefers pm/ when available', async () => {
    const fetchFn = async (url, options) => {
        assert.equal(options.method, 'HEAD');
        if (url.endsWith(`/pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.js`)) {
            return {
                ok: true,
                redirected: false,
                url,
                headers: { get: () => 'application/x-javascript; charset=utf-8' }
            };
        }
        return { ok: false };
    };

    const resolved = await resolveWasmScriptUrl({
        baseUrl: 'https://projectm.1ink.us/projectm_panel2.1ink',
        fetchFn,
        forceRefresh: true
    });

    assert.equal(resolved, PROJECTM_WASM_SCRIPT_PM);
});

test('resolveWasmScriptUrl falls back to site root when pm/ is missing', async () => {
    const fetchFn = async () => ({ ok: false });

    const resolved = await resolveWasmScriptUrl({
        baseUrl: 'https://projectm.1ink.us/projectm_panel2.1ink',
        fetchFn,
        forceRefresh: true
    });

    assert.equal(resolved, PROJECTM_WASM_SCRIPT_ROOT);
});

test('resolveWasmScriptUrl ignores soft-404 HTML redirects for missing pm/', async () => {
    const fetchFn = async (url) => {
        if (url.includes('/pm/')) {
            return {
                ok: true,
                redirected: true,
                url: 'https://www.noahcohn.com/404.1ink',
                headers: { get: () => 'text/html; charset=utf-16' }
            };
        }
        return {
            ok: true,
            redirected: false,
            url,
            headers: { get: () => 'application/x-javascript; charset=utf-8' }
        };
    };

    const resolved = await resolveWasmScriptUrl({
        baseUrl: 'https://projectm.1ink.us/projectm_panel2.1ink',
        fetchFn,
        forceRefresh: true
    });

    assert.equal(resolved, PROJECTM_WASM_SCRIPT_ROOT);
});

test('isUsableWasmScriptResponse rejects HTML content types', () => {
    assert.equal(
        isUsableWasmScriptResponse({
            ok: true,
            redirected: false,
            url: 'https://example/x',
            headers: { get: () => 'text/html' }
        }, 'https://example/x'),
        false
    );
});

test('buildProjectMLocateFile remaps smoke wasm next to pm/ script', () => {
    const locateFile = buildProjectMLocateFile();
    assert.equal(
        locateFile('projectm-v.030-thread.wasm', 'https://projectm.1ink.us/pm/'),
        `https://projectm.1ink.us/pm/projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`
    );
    assert.equal(
        locateFile(`projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`, './'),
        `./projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`
    );
});

test('buildProjectMLocateFile wraps a custom locateFile', () => {
    const locateFile = buildProjectMLocateFile({
        locateFile: (path, prefix) => `${prefix}cdn/${path}`
    });
    assert.equal(
        locateFile('projectm-v.030-thread.wasm', 'https://x/'),
        `https://x/cdn/projectm-v.${PROJECTM_WASM_VERSION}-thread.wasm`
    );
});

// ---- Resolve cache (#6) -----------------------------------------------------

const BASE_A = 'https://a.projectm.test/host.html';
const BASE_B = 'https://b.projectm.test/host.html';

function okResponse(url) {
    return {
        ok: true,
        redirected: false,
        url,
        headers: { get: () => 'application/javascript' },
    };
}

/** A fetch whose HEAD requests all succeed, counting how many were made. */
function countingFetch() {
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url);
        return okResponse(url);
    };
    return { fetchFn, calls };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test('a later call for a different bundle does not get the URL resolved for the first', async () => {
    resetWasmScriptCacheForTests();
    const { fetchFn } = countingFetch();
    const first = await resolveWasmScriptUrl({
        baseUrl: BASE_A,
        fetchFn,
        pmScript: 'pm/projectm-v.111-thread.js',
        rootScript: 'projectm-v.111-thread.js',
    });
    assert.equal(first, 'pm/projectm-v.111-thread.js');

    // Only the legacy root layout exists for the second bundle. Answering with
    // the cached pm/ URL from bundle 111 would load the wrong engine.
    const rootOnly = async (url) => (url.includes('/pm/') ? { ok: false } : okResponse(url));
    const second = await resolveWasmScriptUrl({
        baseUrl: BASE_A,
        fetchFn: rootOnly,
        pmScript: 'pm/projectm-v.222-thread.js',
        rootScript: 'projectm-v.222-thread.js',
    });
    assert.equal(second, 'projectm-v.222-thread.js');
});

test('a successful probe is cached per bundle and base, and forceRefresh probes again', async () => {
    resetWasmScriptCacheForTests();
    const { fetchFn, calls } = countingFetch();
    const options = { fetchFn, pmScript: 'pm/x-v.1.js', rootScript: 'x-v.1.js' };

    await resolveWasmScriptUrl({ ...options, baseUrl: BASE_A });
    await resolveWasmScriptUrl({ ...options, baseUrl: BASE_A });
    assert.equal(calls.length, 1, 'same bundle, same base: answered from the cache');

    await resolveWasmScriptUrl({ ...options, baseUrl: BASE_B });
    assert.equal(calls.length, 2, 'the same bundle on another base is a different URL');
    assert.equal(new URL(calls[1]).origin, 'https://b.projectm.test');

    await resolveWasmScriptUrl({ ...options, baseUrl: BASE_A, forceRefresh: true });
    assert.equal(calls.length, 3, 'forceRefresh skips the cache');

    await resolveWasmScriptUrl({ ...options, baseUrl: BASE_A });
    assert.equal(calls.length, 3, 'and its result is still written back');
});

test('a failed probe is not cached, so a later call can find the real layout', async () => {
    resetWasmScriptCacheForTests();
    const options = { baseUrl: BASE_A, pmScript: 'pm/y-v.1.js', rootScript: 'y-v.1.js' };
    let attempts = 0;
    const failing = async () => {
        attempts += 1;
        throw new Error('offline');
    };

    assert.equal(await resolveWasmScriptUrl({ ...options, fetchFn: failing }), 'y-v.1.js');
    assert.equal(attempts, 2, 'both candidates were tried');

    // Network is back. Had the fallback been cached this would still say root.
    const { fetchFn } = countingFetch();
    assert.equal(await resolveWasmScriptUrl({ ...options, fetchFn }), 'pm/y-v.1.js');
});

test('simultaneous resolves for one bundle share a single probe', async () => {
    resetWasmScriptCacheForTests();
    const gate = deferred();
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url);
        await gate.promise;
        return okResponse(url);
    };
    const options = { baseUrl: BASE_A, fetchFn, pmScript: 'pm/z-v.1.js', rootScript: 'z-v.1.js' };

    const a = resolveWasmScriptUrl(options);
    const b = resolveWasmScriptUrl(options);
    gate.resolve();

    assert.deepEqual(await Promise.all([a, b]), ['pm/z-v.1.js', 'pm/z-v.1.js']);
    assert.equal(calls.length, 1, 'one HEAD request, not one per instance');
});

test('resetWasmScriptCacheForTests forgets resolved URLs', async () => {
    resetWasmScriptCacheForTests();
    const { fetchFn, calls } = countingFetch();
    const options = { baseUrl: BASE_A, fetchFn, pmScript: 'pm/r-v.1.js', rootScript: 'r-v.1.js' };

    await resolveWasmScriptUrl(options);
    resetWasmScriptCacheForTests();
    await resolveWasmScriptUrl(options);
    assert.equal(calls.length, 2);
});

test('resolveWasmScriptUrl rejects with AbortError when the signal is already aborted', async () => {
    resetWasmScriptCacheForTests();
    const { fetchFn, calls } = countingFetch();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        resolveWasmScriptUrl({ baseUrl: BASE_A, fetchFn, signal: controller.signal }),
        (error) => error.name === 'AbortError'
    );
    assert.equal(calls.length, 0, 'nothing is probed for a caller that has already gone');
});

test('aborting one resolve caller does not cancel the probe another caller shares', async () => {
    resetWasmScriptCacheForTests();
    const gate = deferred();
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url);
        await gate.promise;
        return okResponse(url);
    };
    const options = { baseUrl: BASE_A, fetchFn, pmScript: 'pm/s-v.1.js', rootScript: 's-v.1.js' };
    const controller = new AbortController();

    const aborted = resolveWasmScriptUrl({ ...options, signal: controller.signal });
    const survivor = resolveWasmScriptUrl(options);
    controller.abort();

    await assert.rejects(aborted, (error) => error.name === 'AbortError');
    gate.resolve();
    assert.equal(await survivor, 'pm/s-v.1.js');
    assert.equal(calls.length, 1);
});

// ---- loadScript: one element per URL, abortable ------------------------------

/**
 * A document that records every appended <script> and lets the test decide when
 * (and whether) each one loads.
 */
function makeDocument() {
    const scripts = [];
    const document = {
        baseURI: 'https://projectm.test/',
        createElement: (tag) => ({
            tag,
            removed: false,
            remove() { this.removed = true; },
        }),
        body: { appendChild: (element) => { scripts.push(element); return element; } },
    };
    return { document, scripts };
}

test('simultaneous loads of one URL share a single script element', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();

    const a = loadScript('pm/glue.js', { documentRef: document });
    const b = loadScript('pm/glue.js', { documentRef: document });
    assert.equal(scripts.length, 1);

    scripts[0].onload();
    const [scriptA, scriptB] = await Promise.all([a, b]);
    assert.equal(scriptA, scripts[0]);
    assert.equal(scriptB, scripts[0]);
});

test('a finished load is forgotten, so a later load of the same URL injects again', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();

    const first = loadScript('pm/glue.js', { documentRef: document });
    scripts[0].onload();
    await first;

    // The glue defines a global; a different bundle (or a reset engine) must be
    // able to load again rather than being handed a promise that already settled.
    const second = loadScript('pm/glue.js', { documentRef: document });
    assert.equal(scripts.length, 2);
    scripts[1].onload();
    await second;
});

test('a load that settles synchronously inside appendChild is not left in the map', async () => {
    resetWasmScriptCacheForTests();
    const scripts = [];
    const document = {
        createElement: () => ({ remove() {} }),
        body: {
            appendChild: (element) => {
                scripts.push(element);
                element.onload();
                return element;
            },
        },
    };

    await loadScript('pm/sync.js', { documentRef: document });
    await loadScript('pm/sync.js', { documentRef: document });
    assert.equal(scripts.length, 2, 'the second call must not be handed the first, finished load');
});

test('a failed load rejects every waiter, drops its element, and can be retried', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();

    const a = loadScript('pm/glue.js', { documentRef: document });
    const b = loadScript('pm/glue.js', { documentRef: document });
    scripts[0].onerror();

    await assert.rejects(a, /Failed to load pm\/glue\.js/);
    await assert.rejects(b, /Failed to load pm\/glue\.js/);
    assert.equal(scripts[0].removed, true, 'the dead element is not left in the page');

    const retry = loadScript('pm/glue.js', { documentRef: document });
    assert.equal(scripts.length, 2, 'the retry gets a fresh element');
    scripts[1].onload();
    assert.equal(await retry, scripts[1]);
});

test('loads in different documents do not share an element', () => {
    resetWasmScriptCacheForTests();
    const one = makeDocument();
    const two = makeDocument();

    loadScript('pm/glue.js', { documentRef: one.document }).catch(() => {});
    loadScript('pm/glue.js', { documentRef: two.document }).catch(() => {});

    assert.equal(one.scripts.length, 1);
    assert.equal(two.scripts.length, 1);
});

test('loadScript rejects without a document', async () => {
    resetWasmScriptCacheForTests();
    await assert.rejects(loadScript('pm/glue.js', { documentRef: undefined }), /document is not available/);
});

test('loadScript with an already-aborted signal creates no element', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        loadScript('pm/glue.js', { documentRef: document, signal: controller.signal }),
        (error) => error.name === 'AbortError'
    );
    assert.equal(scripts.length, 0);
});

test('aborting the only waiter mid-load rejects and removes the script element', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    const controller = new AbortController();

    const pending = loadScript('pm/glue.js', { documentRef: document, signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.equal(scripts[0].removed, true);

    // The abandoned load is forgotten; the next caller starts clean.
    const next = loadScript('pm/glue.js', { documentRef: document });
    assert.equal(scripts.length, 2);
    scripts[1].onload();
    await next;
});

test('the element stays while another caller still wants it, and goes with the last one', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    const first = new AbortController();
    const second = new AbortController();

    const a = loadScript('pm/glue.js', { documentRef: document, signal: first.signal });
    const b = loadScript('pm/glue.js', { documentRef: document, signal: second.signal });
    const c = loadScript('pm/glue.js', { documentRef: document });

    first.abort();
    await assert.rejects(a, (error) => error.name === 'AbortError');
    second.abort();
    await assert.rejects(b, (error) => error.name === 'AbortError');
    assert.equal(scripts[0].removed, false, 'the third caller has no signal and is still waiting');

    scripts[0].onload();
    assert.equal(await c, scripts[0]);
});

// ---- createProjectMModule ---------------------------------------------------

test('two simultaneous boots inject the glue script once and both get a module', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    const windowRef = {};

    const a = createProjectMModule({ scriptSrc: 'pm/glue.js', windowRef, documentRef: document });
    const b = createProjectMModule({ scriptSrc: 'pm/glue.js', windowRef, documentRef: document });
    assert.equal(scripts.length, 1, 'one <script> for two instances booting at once');

    windowRef.createModule = async (config) => ({ config });
    scripts[0].onload();

    const [moduleA, moduleB] = await Promise.all([a, b]);
    assert.ok(moduleA.config.locateFile);
    assert.ok(moduleB.config.locateFile);
});

test('createProjectMModule injects into the caller\'s document, not the global one', async () => {
    resetWasmScriptCacheForTests();
    assert.equal(typeof globalThis.document, 'undefined', 'this test relies on there being no global document');
    const { document, scripts } = makeDocument();
    const windowRef = {};

    const booting = createProjectMModule({ scriptSrc: 'pm/glue.js', windowRef, documentRef: document });
    assert.equal(scripts.length, 1);
    windowRef.createModule = async () => ({});
    scripts[0].onload();
    await booting;
});

test('createProjectMModule skips the script when the factory already exists', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    const windowRef = { createModule: async () => ({ ready: true }) };

    const module = await createProjectMModule({ scriptSrc: 'pm/glue.js', windowRef, documentRef: document });
    assert.deepEqual(module, { ready: true });
    assert.equal(scripts.length, 0);
});

test('createProjectMModule rejects with AbortError when aborted before it starts', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    let invoked = false;
    const windowRef = { createModule: async () => { invoked = true; return {}; } };
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        createProjectMModule({ scriptSrc: 'pm/glue.js', windowRef, documentRef: document, signal: controller.signal }),
        (error) => error.name === 'AbortError'
    );
    assert.equal(invoked, false, 'a factory that was never needed must not run');
    assert.equal(scripts.length, 0);
});

test('aborting while the glue loads rejects and never invokes the factory', async () => {
    resetWasmScriptCacheForTests();
    const { document, scripts } = makeDocument();
    let invoked = false;
    const windowRef = {};
    const controller = new AbortController();

    const booting = createProjectMModule({
        scriptSrc: 'pm/glue.js',
        windowRef,
        documentRef: document,
        signal: controller.signal,
    });
    controller.abort();
    // The script arrives anyway (it cannot be un-fetched) and defines the factory.
    windowRef.createModule = async () => { invoked = true; return {}; };
    scripts[0].onload?.();

    await assert.rejects(booting, (error) => error.name === 'AbortError');
    assert.equal(invoked, false);
});

test('once the factory is running, an abort no longer rejects the boot', async () => {
    resetWasmScriptCacheForTests();
    const { document } = makeDocument();
    const controller = new AbortController();
    const running = deferred();
    const windowRef = { createModule: () => running.promise };

    const booting = createProjectMModule({
        scriptSrc: 'pm/glue.js',
        windowRef,
        documentRef: document,
        signal: controller.signal,
    });
    controller.abort();
    running.resolve({ booted: true });

    // Cancelling a factory in flight is not possible; the caller receives the
    // module and disposes it, rather than this leaking a half-owned one.
    assert.deepEqual(await booting, { booted: true });
});

// ---- observeModuleSize ------------------------------------------------------

function withFakeResizeObserver(body) {
    const original = globalThis.ResizeObserver;
    const instances = [];
    globalThis.ResizeObserver = class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            instances.push(this);
        }
        observe(target) { this.observed.push(target); }
        disconnect() { this.disconnected = true; }
    };
    try {
        return body(instances);
    } finally {
        if (original === undefined) delete globalThis.ResizeObserver;
        else globalThis.ResizeObserver = original;
    }
}

test('observeModuleSize hands sync its options, not the observer entries', () => {
    withFakeResizeObserver((instances) => {
        const container = {};
        const syncCalls = [];
        const seenBefore = [];
        const seenAfter = [];
        const syncOptions = { aspectCorrection: false };

        const observer = observeModuleSize({
            container,
            sync: (...args) => syncCalls.push(args),
            syncOptions,
            beforeSync: (entries) => seenBefore.push(entries),
            onResize: (entries) => seenAfter.push(entries),
        });
        assert.ok(observer);
        assert.deepEqual(instances[0].observed, [container]);

        const entries = [{ target: container }];
        instances[0].callback(entries);

        assert.equal(syncCalls.length, 1);
        assert.equal(syncCalls[0][0], syncOptions, 'aspectCorrection reaches sync intact');
        assert.equal(syncCalls[0].length, 1);
        assert.equal(seenBefore[0], entries, 'beforeSync still sees the entries');
        assert.equal(seenAfter[0], entries, 'onResize still sees the entries');
    });
});

test('observeModuleSize calls sync with no arguments when there are no syncOptions', () => {
    withFakeResizeObserver((instances) => {
        const syncCalls = [];
        observeModuleSize({ container: {}, sync: (...args) => syncCalls.push(args) });

        instances[0].callback([{ target: {} }]);
        assert.deepEqual(syncCalls, [[]], 'the entries array must not leak in as an options object');
    });
});

test('observeModuleSize returns null without a container or a ResizeObserver', () => {
    withFakeResizeObserver(() => {
        assert.equal(observeModuleSize({ container: null }), null);
    });
    const original = globalThis.ResizeObserver;
    delete globalThis.ResizeObserver;
    try {
        assert.equal(observeModuleSize({ container: {} }), null);
    } finally {
        if (original !== undefined) globalThis.ResizeObserver = original;
    }
});
