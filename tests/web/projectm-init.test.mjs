import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    PROJECTM_WASM_VERSION,
    buildProjectMLocateFile,
    ensureDefaultWasmQueryParam,
    isUsableWasmScriptResponse,
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
