import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    isUsableWasmScriptResponse,
    resolveWasmScriptUrl
} from '../../html/projectm-init.js';

test('resolveWasmScriptUrl prefers pm/ when available', async () => {
    const fetchFn = async (url, options) => {
        assert.equal(options.method, 'HEAD');
        if (url.endsWith('/pm/projectm-v.035-thread.1ijs')) {
            return {
                ok: true,
                redirected: false,
                url,
                headers: { get: () => 'application/x-javascript; charset=utf-16' }
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
            headers: { get: () => 'application/x-javascript; charset=utf-16' }
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
