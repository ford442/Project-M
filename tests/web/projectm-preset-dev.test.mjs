// html/projectm-preset-dev.js (the ?devPreset=1 hot-reload panel) and
// html/projectm-preset-tweaker.js (its header-parameter sliders).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakePage, installFakePage } from './helpers/fake-page.mjs';
import { setupPresetDevTools } from '../../html/projectm-preset-dev.js';
import {
    PARAMS,
    parseHeaderValue,
    patchHeaderValue,
    setupPresetTweaker,
} from '../../html/projectm-preset-tweaker.js';

const MILK = '[preset00]\nfDecay=0.980000\nzoom=1.010000\nper_frame_1=zoom=zoom;\n';

/** A Module with the VFS and ccall surface the dev panel loads through. */
function makeModule() {
    const calls = [];
    const dirs = new Set();
    return {
        calls,
        dirs,
        FS: {
            mkdir(path) {
                if (dirs.has(path)) throw new Error('EEXIST');
                dirs.add(path);
            },
            writeFile: (path, bytes) => calls.push(['write', path, new TextDecoder().decode(bytes)]),
        },
        ccall: (name, _returns, _types, args) => calls.push(['ccall', name, ...args]),
    };
}

function withPage(body, { search = '' } = {}) {
    const page = createFakePage('<body></body>', { search });
    const restore = installFakePage(page);
    const savedDispatch = globalThis.dispatchEvent;
    globalThis.dispatchEvent = () => true;
    return Promise.resolve()
        .then(() => body(page))
        .finally(() => {
            globalThis.dispatchEvent = savedDispatch;
            restore();
        });
}

// ---- tweaker ----------------------------------------------------------------

test('header values parse and patch in place, or are inserted after [preset00]', () => {
    assert.equal(parseHeaderValue(MILK, 'fDecay'), 0.98);
    assert.equal(parseHeaderValue(MILK, 'warp'), null);
    // per_frame `zoom=` is not a header line: only a value at line start counts.
    assert.equal(parseHeaderValue('per_frame_1=zoom=zoom;\n', 'zoom'), null);

    const patched = patchHeaderValue(MILK, 'fDecay', 0.96);
    assert.match(patched, /^fDecay=0\.96$/m, 'six decimals, trailing zeros dropped');
    assert.doesNotMatch(patched, /fDecay=0\.98/);
    assert.match(patchHeaderValue(MILK, 'zoom', 1), /^zoom=1$/m);
    assert.match(patchHeaderValue(MILK, 'rot', -0.05), /^\[preset00\]\nrot=-0\.05\n/);
    assert.equal(patchHeaderValue('per_frame_1=x;\n', 'warp', 0.01), 'warp=0.01\nper_frame_1=x;\n');
});

test('the tweaker builds one slider per parameter and applies them all to the source', async () => {
    await withPage(async () => {
        const applied = [];
        const tweaker = setupPresetTweaker({ onApply: (text) => applied.push(text), getSource: () => MILK });
        const root = document.getElementById('pm-preset-tweaker');
        assert.equal(root, null, 'without a dev panel the strip is not attached anywhere');

        tweaker.syncFromMilk(MILK);
        const devPanel = document.createElement('div');
        devPanel.id = 'pm-preset-dev-panel';
        document.body.appendChild(devPanel);
        const attached = setupPresetTweaker({ onApply: (text) => applied.push(text), getSource: () => MILK });
        const strip = document.getElementById('pm-preset-tweaker');
        assert.ok(strip && devPanel.children.includes(strip));
        const rows = strip.children.filter((child) => child.tagName === 'DIV');
        assert.equal(rows.length, PARAMS.length);

        // Sync from the milk, nudge one slider, apply.
        attached.syncFromMilk(MILK);
        const [, decayInput, decayLabel] = rows[0].children;
        assert.equal(decayInput.value, '0.98');
        decayInput.value = '0.9';
        decayInput.dispatch('input');
        assert.equal(decayLabel.textContent, '0.9');
        strip.children.find((child) => child.tagName === 'BUTTON').click();
        await Promise.resolve();
        const text = applied.at(-1);
        assert.match(text, /^fDecay=0\.9$/m);
        assert.match(text, /^zoom=1\.01$/m);
        for (const p of PARAMS) assert.match(text, new RegExp(`^${p.key}=`, 'm'), `${p.key} written`);
    });
});

test('the tweaker does nothing for an empty source', async () => {
    await withPage(async () => {
        const applied = [];
        const devPanel = document.createElement('div');
        devPanel.id = 'pm-preset-dev-panel';
        document.body.appendChild(devPanel);
        setupPresetTweaker({ onApply: (text) => applied.push(text) });
        const strip = document.getElementById('pm-preset-tweaker');
        strip.children.find((child) => child.tagName === 'BUTTON').click();
        assert.deepEqual(applied, [], 'the default source is the (empty) dev editor');
    });
});

// ---- dev panel ----------------------------------------------------------------

test('the dev panel is off without ?devPreset=1 or ?localPresets=1', async () => {
    await withPage(async () => {
        assert.deepEqual(setupPresetDevTools(/** @type {any} */ (makeModule())), { enabled: false });
        assert.equal(document.getElementById('pm-preset-dev-panel'), null);
    });
});

test('Apply writes the editor text into the VFS and loads it', async () => {
    await withPage(async () => {
        const module = makeModule();
        let transitions = 0;
        const dev = setupPresetDevTools(/** @type {any} */ (module), {
            params: new URLSearchParams('devPreset=1'),
            startTransitionWhenReady: async () => { transitions += 1; return true; },
        });
        assert.equal(dev.enabled, true);
        const panel = document.getElementById('pm-preset-dev-panel');
        assert.ok(panel, 'panel mounted');
        assert.ok(document.getElementById('pm-preset-dev-style'), 'styles injected once');

        panel.querySelector('#pm-dev-editor').value = MILK;
        panel.querySelector('#pm-dev-apply').click();
        await new Promise((resolve) => setImmediate(resolve));

        const write = module.calls.find((call) => call[0] === 'write');
        assert.ok(write, 'written to the VFS');
        assert.equal(write[2], MILK);
        assert.ok(module.dirs.size > 0, 'the directory chain was created');
        assert.ok(module.calls.some((call) => call[0] === 'ccall' && call[1] === 'load_preset_file' && call[2] === write[1]));
        assert.equal(transitions, 1);
        assert.match(panel.querySelector('#pm-dev-status').textContent, /^Reloaded dev_edit\.milk/);

        // Ctrl+S does the same; the second load reuses the directories.
        const editor = panel.querySelector('#pm-dev-editor');
        let prevented = false;
        editor.dispatch('keydown', { ctrlKey: true, key: 's', preventDefault: () => { prevented = true; } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(prevented);
        assert.equal(module.calls.filter((call) => call[0] === 'write').length, 2);

        // The tweaker's Apply writes through the same reload.
        const tweakerApply = document.getElementById('pm-preset-tweaker');
        assert.ok(tweakerApply, 'the tweaker strip is mounted in the panel');
        dev.dispose();
    });
});

test('a module without a VFS reports the failure in the panel', async () => {
    await withPage(async () => {
        setupPresetDevTools(/** @type {any} */ ({}), { params: new URLSearchParams('localPresets=1') });
        const panel = document.getElementById('pm-preset-dev-panel');
        panel.querySelector('#pm-dev-apply').click();
        await new Promise((resolve) => setImmediate(resolve));
        const status = panel.querySelector('#pm-dev-status');
        assert.match(status.textContent, /Module not ready/);
        assert.ok(status.classList.contains('err'));
    });
});

test('Fetch loads a URL once; Poll reloads only when the preset changed', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await withPage(async () => {
        const module = makeModule();
        let body = MILK;
        let etag = 'a';
        const fetched = [];
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            fetched.push([url, init?.cache]);
            return { ok: true, status: 200, text: async () => body, headers: { get: () => etag } };
        };
        try {
            const dev = setupPresetDevTools(/** @type {any} */ (module), {
                params: new URLSearchParams('devPreset=1&devPresetUrl=https://dev.test/a.milk&devPollMs=100'),
            });
            const panel = document.getElementById('pm-preset-dev-panel');
            assert.equal(panel.querySelector('#pm-dev-url').value, 'https://dev.test/a.milk');

            panel.querySelector('#pm-dev-fetch').click();
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(fetched, [['https://dev.test/a.milk', 'no-store']]);
            assert.equal(panel.querySelector('#pm-dev-editor').value, MILK);
            const writes = () => module.calls.filter((call) => call[0] === 'write').length;
            assert.equal(writes(), 1);

            const poll = panel.querySelector('#pm-dev-poll-toggle');
            poll.click();
            assert.equal(poll.textContent, 'Stop');
            assert.match(panel.querySelector('#pm-dev-status').textContent, /every 500ms/, 'clamped to 500 ms');
            t.mock.timers.tick(500);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(writes(), 1, 'unchanged preset: no reload');

            body = `${MILK}\n`;
            etag = 'b';
            t.mock.timers.tick(500);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(writes(), 2, 'changed preset: reloaded');

            poll.click();
            assert.equal(poll.textContent, 'Poll');
            assert.equal(panel.querySelector('#pm-dev-status').textContent, 'Polling stopped');
            dev.dispose();
        } finally {
            globalThis.fetch = savedFetch;
        }
    });
});

test('?devPoll=1 starts polling by itself, and Fetch/Poll need a URL', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await withPage(async () => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '', headers: { get: () => null } });
        try {
            const dev = setupPresetDevTools(/** @type {any} */ (makeModule()), {
                params: new URLSearchParams('devPreset=1&devPoll=1&devPresetUrl=https://dev.test/b.milk'),
            });
            const panel = document.getElementById('pm-preset-dev-panel');
            t.mock.timers.tick(500);
            assert.equal(panel.querySelector('#pm-dev-poll-toggle').textContent, 'Stop');
            t.mock.timers.tick(2000);
            await new Promise((resolve) => setImmediate(resolve));
            assert.match(panel.querySelector('#pm-dev-status').textContent, /Poll error: Error: HTTP 404/);
            dev.dispose();

            panel.querySelector('#pm-dev-url').value = '  ';
            panel.querySelector('#pm-dev-fetch').click();
            assert.equal(panel.querySelector('#pm-dev-status').textContent, 'Enter a URL');
        } finally {
            globalThis.fetch = savedFetch;
        }
    });
});
