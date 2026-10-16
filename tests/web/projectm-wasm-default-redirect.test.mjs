// html/projectm-wasm-default-redirect.js — the classic script the .1ink hosts
// load first, which adds ?wasm=<default> to a URL that has none.
//
// It is a parse-time side effect with no exports, so it is evaluated with
// node:vm against a sandbox `window`/`fetch`, the way the render-worker suite
// drives that classic script. The filename is the real path, so V8 coverage
// attributes the run to the module.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'html', 'projectm-wasm-default-redirect.js');
const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const VERSION_SOURCE = readFileSync(join(dirname(SCRIPT_PATH), 'projectm-wasm-version.js'), 'utf8');

/**
 * Run the script once against a fake page.
 *
 * @param {object} options
 * @param {string} [options.search]
 * @param {string} [options.hash]
 * @param {((url: string, init: object) => Promise<unknown>) | null} [options.fetch] null = no fetch API
 * @param {boolean} [options.replaceThrows]
 */
function runRedirect({ search = '', hash = '', fetch = null, replaceThrows = false } = {}) {
    const replaced = [];
    const timers = [];
    const fetches = [];
    const window = {
        location: {
            search,
            hash,
            pathname: '/projectm_panel2.1ink',
            replace(url) {
                if (replaceThrows) throw new Error('navigation blocked');
                replaced.push(url);
            },
        },
    };
    const sandbox = {
        window,
        URLSearchParams,
        setTimeout: (fn, ms) => {
            timers.push({ fn, ms });
            return timers.length;
        },
        clearTimeout: (id) => {
            if (timers[id - 1]) timers[id - 1].cleared = true;
        },
    };
    if (fetch) {
        sandbox.fetch = (url, init) => {
            fetches.push({ url, init });
            return fetch(url, init);
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: SCRIPT_PATH });
    return {
        window,
        replaced,
        timers,
        fetches,
        defaultVersion: sandbox.DEFAULT_WASM_VERSION,
        /** Fire the manifest-timeout fallback, if still armed. */
        fireTimeout() {
            for (const timer of timers) {
                if (!timer.cleared) timer.fn();
            }
        },
    };
}

/** @param {unknown} body @param {{ ok?: boolean, type?: string }} [options] */
function jsonResponse(body, { ok = true, type = 'application/json' } = {}) {
    return Promise.resolve({
        ok,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
        json: () => Promise.resolve(body),
    });
}

const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));

test('the fallback version matches PROJECTM_WASM_DEFAULT_VERSION', () => {
    const match = VERSION_SOURCE.match(/PROJECTM_WASM_DEFAULT_VERSION\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(match, 'projectm-wasm-version.js no longer declares PROJECTM_WASM_DEFAULT_VERSION');
    assert.equal(runRedirect({ search: '?wasm=1' }).defaultVersion, match[1]);
});

test('a URL that already names ?wasm= is left alone', async () => {
    const run = runRedirect({ search: '?wasm=035&aa=1', fetch: () => jsonResponse({}) });
    await flush();
    assert.deepEqual(run.replaced, []);
    assert.deepEqual(run.fetches, []);
    assert.equal(run.window.__projectMWasmRedirectPending, undefined, 'no redirect pending, so the host boots');
});

test('the manifest default is used when it names a listed build', async () => {
    const run = runRedirect({
        search: '?aa=1',
        hash: '#x',
        fetch: () => jsonResponse({ schema: 1, default: '041', builds: { '041': {} } }),
    });
    assert.equal(run.window.__projectMWasmRedirectPending, true, 'hosts must see the pending navigation before booting');
    assert.equal(run.fetches[0].url, './pm/builds.json');
    assert.equal(run.fetches[0].init.credentials, 'omit');
    await flush();
    assert.deepEqual(run.replaced, ['/projectm_panel2.1ink?aa=1&wasm=041#x']);
    assert.ok(run.timers.every((timer) => timer.cleared), 'the timeout fallback is disarmed');
    run.fireTimeout();
    assert.equal(run.replaced.length, 1, 'redirects at most once');
});

for (const [label, response] of [
    ['an unlisted default', () => jsonResponse({ schema: 1, default: '099', builds: { '041': {} } })],
    ['a wrong schema', () => jsonResponse({ schema: 2, default: '041', builds: { '041': {} } })],
    ['a non-JSON response (an HTML 404 page)', () => jsonResponse('<html>', { type: 'text/html' })],
    ['a failed response', () => jsonResponse({}, { ok: false })],
    ['a network error', () => Promise.reject(new Error('offline'))],
]) {
    test(`${label} falls back to the built-in default`, async () => {
        const run = runRedirect({ fetch: response });
        await flush();
        assert.deepEqual(run.replaced, [`/projectm_panel2.1ink?wasm=${run.defaultVersion}`]);
    });
}

test('a manifest slower than the timeout redirects to the built-in default', async () => {
    const run = runRedirect({ fetch: () => new Promise(() => {}) });
    assert.equal(run.timers[0].ms, 1200);
    run.fireTimeout();
    assert.deepEqual(run.replaced, [`/projectm_panel2.1ink?wasm=${run.defaultVersion}`]);
});

test('without fetch the redirect is immediate', () => {
    const run = runRedirect({ search: '?x=1' });
    assert.deepEqual(run.replaced, [`/projectm_panel2.1ink?x=1&wasm=${run.defaultVersion}`]);
});

test('a refused navigation clears the pending flag so the host still boots', () => {
    const run = runRedirect({ replaceThrows: true });
    assert.equal(run.window.__projectMWasmRedirectPending, false);
});

test('a page whose location cannot be parsed is left alone', () => {
    const sandbox = { window: { get location() { throw new Error('sandboxed'); } }, URLSearchParams };
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: SCRIPT_PATH });
    assert.equal(sandbox.window.__projectMWasmRedirectPending, undefined);
});
