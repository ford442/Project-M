import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROJECTM_WASM_SCRIPT_PM,
    PROJECTM_WASM_SCRIPT_ROOT,
    resolveWasmScriptUrl
} from '../../html/projectm-init.js';

test('resolveWasmScriptUrl prefers pm/ when available', async () => {
    const fetchFn = async (url, options) => {
        assert.equal(options.method, 'HEAD');
        if (url.endsWith('/pm/projectm-v.035-thread.1ijs')) {
            return { ok: true };
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
