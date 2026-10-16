// html/projectm-host-config.js — the one reader of the host pages' URL flags.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_PRESET_API_BASE,
    getHostConfig,
    HOST_FLAGS,
    readHostFlag,
    renderHostFlagsTable,
} from '../../html/projectm-host-config.js';
import { DEFAULT_PRESET_API_BASE as PRESETS_DEFAULT } from '../../html/projectm-presets.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {Record<string, string>} entries */
const storageOf = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });
const none = { search: '', storage: null, globals: null };

test('defaults when no tier has a value', () => {
    const config = getHostConfig(none);
    for (const [name, spec] of Object.entries(HOST_FLAGS)) {
        assert.deepEqual(config[name], spec.default, name);
    }
    assert.equal(config.presetApi, DEFAULT_PRESET_API_BASE);
    assert.equal(PRESETS_DEFAULT, DEFAULT_PRESET_API_BASE, 'projectm-presets.js re-exports the same default');
});

test('query beats attribute beats global beats storage', () => {
    const element = { getAttribute: (name) => (name === 'data-x' ? 'attr' : null) };
    // presetApi has query, global and storage tiers.
    const all = {
        search: '?presetApi=https://q.example/',
        element,
        globals: { PROJECTM_PRESET_API_BASE: 'https://g.example' },
        storage: storageOf({ apiBase: 'https://s.example' }),
    };
    assert.equal(readHostFlag('presetApi', all), 'https://q.example', 'trailing slashes stripped');
    assert.equal(readHostFlag('presetApi', { ...all, search: '' }), 'https://g.example');
    assert.equal(readHostFlag('presetApi', { ...all, search: '', globals: {} }), 'https://s.example');
});

test('an unaccepted value falls through to the next tier instead of the default', () => {
    const storage = storageOf({ targetFps: '30', meshQuality: 'low', qualityGovernor: '0', renderWorker: '0' });
    const config = getHostConfig({ search: '?targetFps=abc&meshQuality=medium&governor=maybe&renderWorker=yes', storage, globals: null });
    assert.equal(config.targetFps, 30);
    assert.equal(config.meshQuality, 'low');
    assert.equal(config.governor, false);
    assert.equal(config.renderWorker, false);
    // An accepted query value still wins over storage.
    assert.equal(readHostFlag('targetFps', { search: 'targetFps=120', storage }), 120);
    assert.equal(readHostFlag('governor', { search: '?governor=true', storage }), true);
});

test('parsers', () => {
    const q = (search) => getHostConfig({ search, storage: null, globals: null });
    assert.equal(q('?aa=true').aa, true);
    assert.equal(q('?aa=0').aa, false);
    assert.equal(q('?fboPrecision=HIGH').fboPrecision, 'high');
    assert.equal(q('?fboPrecision=quad').fboPrecision, 'half');
    assert.equal(q('?blurPath=Copy&copyPath=shader&perPixelEval=cpu').blurPath, 'copy');
    assert.equal(q('?copyPath=shader').copyPath, 'shader');
    assert.equal(q('?perPixelEval=gpu').perPixelEval, 'default');
    assert.equal(q('?presetDuration=4').presetDuration, 40, 'below the 5 s floor is rejected');
    assert.equal(q('?presetDuration=12.5').presetDuration, 12.5);
    assert.equal(q('?switchOn=section&switchBars=32&transitionBeats=0.5&bpm=128').switchOn, 'section');
    assert.equal(q('?switchBars=32').switchBars, 32);
    assert.equal(q('?transitionBeats=-1').transitionBeats, 0);
    assert.equal(q('?bpm=128').bpm, 128);
    assert.deepEqual(q('?crossfadePresets=a.milk, b.milk,,').crossfadePresets, ['a.milk', 'b.milk']);
    assert.deepEqual(q('?crossfadePresets=,').crossfadePresets, []);
    assert.equal(q('?debugSender').debugSender, true);
    assert.equal(q('?perfhud=true').perfhud, false, "on-flags take '1' only, as before");
    assert.equal(q('?wasm=v.039').wasm, '039');
    assert.equal(q('?wasm=not-a-version').wasm, null);
    assert.equal(q('?mode=weeks_on_fire').mode, 'weeks_on_fire');
    assert.equal(q('?presetApi=').presetApi, DEFAULT_PRESET_API_BASE);
});

test('page globals are stringified, so `true` reads like ?capture=true', () => {
    assert.equal(readHostFlag('capture', { search: '', globals: { __projectMCaptureMode: true }, storage: null }), true);
    assert.equal(readHostFlag('capture', { search: '', globals: { __projectMCaptureMode: false }, storage: null }), false);
});

test('URLSearchParams sources are accepted as-is', () => {
    assert.equal(readHostFlag('perfhud', { search: new URLSearchParams('perfhud=1') }), true);
});

test('a storage that throws on read is skipped', () => {
    const storage = { getItem() { throw new Error('SecurityError'); } };
    assert.equal(readHostFlag('targetFps', { search: '', storage }), 60);
});

test('default sources are location.search and localStorage', () => {
    const saved = Object.getOwnPropertyDescriptors(globalThis);
    try {
        globalThis.location = { search: '?pcmhud=1' };
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get: () => storageOf({ targetFps: '24' }),
        });
        const config = getHostConfig();
        assert.equal(config.pcmhud, true);
        assert.equal(config.targetFps, 24);

        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get: () => { throw new Error('sandboxed'); },
        });
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            get: () => { throw new Error('no location'); },
        });
        assert.equal(readHostFlag('targetFps'), 60);
    } finally {
        for (const key of ['location', 'localStorage']) {
            if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
            else delete globalThis[key];
        }
    }
});

test('every registry entry is documented and names its readers', () => {
    for (const [name, spec] of Object.entries(HOST_FLAGS)) {
        assert.ok(spec.query || spec.attribute || spec.global || spec.storage, `${name} has no source`);
        assert.ok(spec.doc && spec.values, `${name} needs doc and values`);
        assert.ok(spec.readBy.length, `${name} has no reader`);
        for (const file of spec.readBy) {
            const source = readFileSync(join(repoRoot, 'html', file), 'utf8');
            assert.match(source, new RegExp(`['"]${name}['"]|\\.${name}\\b`), `${file} is listed as reading ${name} but never names it`);
        }
    }
});

test('no html module parses the page query itself', () => {
    // The point of the registry: a flag read anywhere else is a flag nobody can find.
    // projectm-wasm-default-redirect.js is a classic script that runs before any
    // module and rewrites the URL; projectm-init.js edits ?wasm= to build a URL.
    const exempt = new Set([
        'projectm-host-config.js',
        'projectm-wasm-default-redirect.js',
        'projectm-init.js',
    ]);
    const offenders = [];
    for (const file of readdirSync(join(repoRoot, 'html'))) {
        if (!/^projectm-.*\.js$/.test(file) || exempt.has(file)) continue;
        const source = readFileSync(join(repoRoot, 'html', file), 'utf8');
        if (/new URLSearchParams\([^)]*location/.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'read flags with readHostFlag()/getHostConfig() from projectm-host-config.js');
});

test('docs/HOST_FLAGS.md carries the generated table', () => {
    const docPath = join(repoRoot, 'docs', 'HOST_FLAGS.md');
    const doc = readFileSync(docPath, 'utf8');
    const begin = '<!-- host-flags:begin -->';
    const end = '<!-- host-flags:end -->';
    const start = doc.indexOf(begin);
    const stop = doc.indexOf(end);
    assert.ok(start >= 0 && stop > start, 'docs/HOST_FLAGS.md lost its table markers');
    const expected = `${begin}\n${renderHostFlagsTable()}\n${end}`;
    const actual = doc.slice(start, stop + end.length);
    if (actual !== expected && process.env.UPDATE_HOST_FLAGS_DOC === '1') {
        writeFileSync(docPath, doc.slice(0, start) + expected + doc.slice(stop + end.length));
        return;
    }
    assert.equal(actual, expected,
        'docs/HOST_FLAGS.md is stale: UPDATE_HOST_FLAGS_DOC=1 node --test tests/web/projectm-host-config.test.mjs');
});
