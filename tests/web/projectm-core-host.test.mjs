// html/projectm-core-host.js — the script of html/projectm-core.html, booted
// against a fake of that page's own markup.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakePage, installFakePage } from './helpers/fake-page.mjs';
import { getHostConfig } from '../../html/projectm-host-config.js';

const htmlRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'html');
const PAGE = readFileSync(join(htmlRoot, 'projectm-core.html'), 'utf8');

// Imported with no document, so the page's self-start does not run; each test
// boots its own fake page through startCoreHost().
const { CORE_HOST_ACTIONS, coreHostContextOptions, startCoreHost } = await import('../../html/projectm-core-host.js');

test('the page is a thin shell: markup, the stylesheet and one module', () => {
    assert.ok(PAGE.split('\n').length <= 100, `projectm-core.html is ${PAGE.split('\n').length} lines`);
    assert.match(PAGE, /<script type="module" src="\.\/projectm-core-host\.js"><\/script>/);
    assert.match(PAGE, /<link rel="stylesheet" href="\.\/projectm-core\.css">/);
    assert.equal((PAGE.match(/<script/g) ?? []).length, 1, 'no inline scripts');
    assert.equal((PAGE.match(/<style/g) ?? []).length, 0, 'no inline styles');
    // Inline handlers resolve against page globals, which is how seven of the
    // panel's buttons ended up calling functions that did not exist.
    assert.doesNotMatch(PAGE, /\son[a-z]+=/i, 'no inline on* handlers');
});

test('every data-action on the page has a handler, and every handler is used', () => {
    const named = new Set([...PAGE.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...named].sort(), [...CORE_HOST_ACTIONS].sort());
});

test('ids are unique', () => {
    const ids = [...PAGE.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('flags become ProjectMContext options', () => {
    const config = getHostConfig({
        search: '?aa=1&capture=1&depth=1&fboPrecision=byte&targetFps=30&governor=0&meshQuality=low&switchOn=bars&switchBars=8&transitionBeats=2&bpm=128',
        storage: null,
        globals: null,
    });
    const options = coreHostContextOptions(config, { isBezelMode: false, isTransparencyMode: true, isPresetLocked: true });
    assert.deepEqual(options, {
        aspectCorrection: false,
        transparent: true,
        contextAlpha: true,
        transparencyThreshold: 0.01,
        presetLocked: true,
        presetDuration: { seconds: 27, randomExtra: 30 },
        antialias: true,
        preserveDrawingBuffer: true,
        fboPrecision: 'byte',
        depth: true,
        stencil: true,
        targetFps: 30,
        qualityGovernor: false,
        meshQuality: 'low',
        presetSwitchPolicy: 'bars',
        presetSwitchBars: 8,
        transitionBeats: 2,
        rhythmHint: 128,
    });
    // `auto` is decided here: the worker has no navigator of its own.
    const auto = coreHostContextOptions(getHostConfig({ search: '', storage: null, globals: null }),
        { isBezelMode: true, isTransparencyMode: false, isPresetLocked: false });
    assert.ok(auto.meshQuality === 'low' || auto.meshQuality === 'high');
    assert.equal(auto.contextAlpha, true, 'transparency is toggled at run time, so the canvas always has alpha');
});

/**
 * Boots the host against a fresh fake page with a fake ProjectMContext.
 *
 * @param {{ search?: string, storage?: Record<string, string> }} [options]
 */
function bootPage({ search = '', storage = {} } = {}) {
    const page = createFakePage(PAGE, { search });
    for (const [key, value] of Object.entries(storage)) page.localStorage.setItem(key, value);
    const restore = installFakePage(page);
    const created = [];
    const calls = [];
    const fakeContext = (options) => {
        const context = {
            options,
            module: null,
            transport: {
                workerHandle: null,
                onPerfFrame: () => () => {},
                onPerfHudEnabled: () => () => {},
                setPerfHud() {},
                call: async () => 0,
                callVoid: () => {},
                supports: () => false,
                writePreset: (path) => calls.push(['writePreset', path]),
            },
            renderScale: 1,
            start: async () => context,
            on: () => () => {},
            setLocked: (locked) => calls.push(['setLocked', locked]),
            setTransparent: (enabled) => calls.push(['setTransparent', enabled]),
            setTransparencyThreshold: () => {},
            resize: () => calls.push(['resize']),
            nextPreset: () => calls.push(['nextPreset']),
            loadPresetFile: async () => {},
            addPreset: () => {},
        };
        created.push(context);
        return context;
    };
    const host = startCoreHost({
        config: getHostConfig({ search, storage: page.localStorage, globals: null }),
        createContext: /** @type {any} */ (fakeContext),
        initDelayMs: 60_000,
        loadSongLoader: () => Promise.reject(new Error('not in this test')),
        setupPicker: /** @type {any} */ (() => ({ ready: Promise.resolve([]), pickRandom() {}, toggle() {} })),
    });
    return { page, host, created, calls, restore };
}

test('panel buttons are wired to their handlers', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    const { page, restore } = bootPage();
    try {
        const lock = page.document.getElementById('lockPresetBtn');
        lock.click();
        assert.equal(page.localStorage.getItem('projectm:presetLocked'), '1');
        assert.ok(lock.classList.contains('engaged'));
        assert.ok(page.document.body.classList.contains('has-lock'));
        lock.click();
        assert.equal(page.localStorage.getItem('projectm:presetLocked'), '0');

        // Both glass buttons toggle once per click (the panel one used to fire twice).
        const glass = page.document.getElementById('transparencyBtn');
        const glassLayer = page.document.getElementById('glassLayerBtn');
        glass.click();
        assert.equal(page.localStorage.getItem('projectm:transparencyMode'), '1');
        assert.ok(glass.classList.contains('engaged') && glassLayer.classList.contains('engaged'));
        glassLayer.click();
        assert.equal(page.localStorage.getItem('projectm:transparencyMode'), '0');

        page.document.getElementById('hidePanelBtn').click();
        t.mock.timers.tick(300);
        assert.equal(page.document.getElementById('panel-container').style.display, 'none');
        assert.ok(!page.document.getElementById('show-btn').classList.contains('hidden'));
        page.document.getElementById('show-btn').click();
        assert.equal(page.document.getElementById('panel-container').style.display, 'block');

        page.document.getElementById('toggleBezelBtn').click();
        assert.equal(page.document.getElementById('contain1').style.position, 'fixed', 'full window layout');
        page.document.getElementById('toggleBezelBtn').click();
        assert.equal(page.document.getElementById('contain1').style.position, 'absolute', 'bezel layout');

        // Locked: random presets are refused with a toast.
        page.document.getElementById('lockPresetBtn').click();
        page.document.getElementById('randomPresetBtn').click();
        page.document.getElementById('customMilkBtn').click();
        assert.match(page.document.getElementById('stat').textContent, /Preset locked/);
    } finally {
        console.warn = warn;
        console.log = log;
        restore();
    }
});

test('the console API goes through the legacy-globals shim', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { restore } = bootPage();
    try {
        for (const name of ['updatePresetDisplay', 'presetPicker', 'toggleTransparencyMode', 'openAudioCapture',
            'feedPCMToModuleForDebug', 'startLocalProjectMTestSender', 'stopLocalProjectMTestSender',
            'cycleAudioPlayer', 'openFlacPlayer', 'openModPlayer']) {
            assert.ok(name in globalThis, `${name} is published`);
        }
    } finally {
        restore();
    }
});

test('init creates one context from the flags and page state, then loads startup presets', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const info = console.info;
    const error = console.error;
    const errors = [];
    console.info = () => {};
    console.error = (...args) => errors.push(args);
    const fetches = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        fetches.push(String(url));
        return { ok: false, status: 503, json: async () => ({}) };
    };
    const { host, created, restore } = bootPage({
        search: '?targetFps=24&transparent=1',
        storage: { 'projectm:presetLocked': '1' },
    });
    try {
        await host.attemptInit();
        await host.attemptInit();
        assert.equal(created.length, 1, 'a second attempt reuses the context');
        const options = created[0].options;
        assert.equal(options.targetFps, 24);
        assert.equal(options.transparent, true);
        assert.equal(options.presetLocked, true);
        assert.equal(options.primaryCanvasSelector, '#mcanvas');
        assert.equal(options.canvas.id, 'mcanvas');
        assert.equal(options.audioSource, 'none');
        assert.ok(options.audioRouter, 'the page shares its router with the context');
        assert.deepEqual(errors, []);
        assert.ok(fetches.length > 0, `startup presets were requested from the API (${fetches})`);
        assert.deepEqual(errors, []);
    } finally {
        globalThis.fetch = savedFetch;
        console.info = info;
        console.error = error;
        restore();
    }
});
