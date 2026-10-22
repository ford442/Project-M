// The WASM glue (src/wasm/) does not scrape the page. It used to: it read
// `#milkPath` and `#textureDir` with innerHTML, downloaded presets, shaders and
// textures with XMLHttpRequest, and wrote `#stat` with innerHTML -- and several
// of those writes had no null check, so a host page without a `#stat` element
// (projectm_panel2.1ink is one) threw. Fetching and status text are the host
// page's job now (html/projectm-presets.js, projectm-textures.js,
// projectm-weeks-on-fire.js); the engine reports through the callback bus.
//
// Two layers, because a regex over C++ can say the legacy entry points are gone
// but only running the bodies can say a missing element cannot throw:
//   1. static: no EM_JS / EM_ASM body anywhere in src/wasm/ downloads, writes
//      innerHTML, or looks up a hard-coded selector; the remaining querySelector
//      calls take a selector the host passed in;
//   2. dynamic: the two bodies that used to touch the DOM run against a page
//      whose `document` throws on any property access.
//
// Run with: node --test tests/web/wasm-glue-dom.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findLegacyDomReads } from '../wasm-smoke/host_contract_names.mjs';
import { extractEmJs, stripJsComments } from './helpers/em-js.mjs';

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/wasm');
const sources = readdirSync(wasmDir)
    .filter((file) => /\.(cpp|hpp)$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(wasmDir, file), 'utf8') }));

/** Every EM_JS / EM_ASM body in src/wasm/, comments stripped. */
const blocks = sources.flatMap(({ file, text }) =>
    extractEmJs(text).map((block) => ({ ...block, file, body: stripJsComments(block.body) })));

const bindings = blocks.filter((block) => block.file === 'WasmJsBindings.cpp');

test('the extractor finds the glue it is meant to guard', () => {
    assert.ok(blocks.length >= 10, `only ${blocks.length} EM_JS/EM_ASM bodies found; the scanner is broken`);
    const names = bindings.map((block) => block.name).sort();
    assert.deepEqual(names, [
        'js_init_projectm_glue',
        'js_notify_init_error',
        'js_notify_init_success',
        'js_report_preset_switch_failed',
        'js_update_preset_name',
    ]);
});

test('no EM_JS/EM_ASM body downloads with XMLHttpRequest or writes status text', () => {
    for (const { file, name, macro, body } of blocks) {
        const where = `${file} ${name || macro}`;
        assert.doesNotMatch(body, /XMLHttpRequest/, `${where}: downloads belong in the host page`);
        assert.doesNotMatch(body, /\binnerHTML\b/, `${where}: status text belongs in the host page`);
        assert.doesNotMatch(body, /#stat\b/, `${where}: #stat belongs to the host page`);
        assert.doesNotMatch(body, /#milkPath/, `${where}: the engine does not read page config`);
    }
});

test('no EM_JS/EM_ASM body looks up a hard-coded selector', () => {
    for (const { file, name, macro, body } of blocks) {
        assert.doesNotMatch(body, /querySelector(All)?\(\s*['"`]/, `${file} ${name || macro}: a selector literal`);
        assert.doesNotMatch(body, /getElementById\(/, `${file} ${name || macro}: getElementById`);
    }
});

test('the glue bindings touch no DOM at all: no lookups, no fetching, no styling', () => {
    for (const { name, body } of bindings) {
        assert.doesNotMatch(body, /querySelector|getElementsBy|DOMParser|\.style\b|\bfetch\(/, `${name}`);
    }
});

test('what is left of querySelector takes the host-supplied selector and guards document', () => {
    const lookups = blocks.filter(({ body }) => /querySelector\(/.test(body));
    assert.ok(lookups.length > 0, 'expected the canvas/element-source selector lookups to remain');
    for (const { file, name, macro, body } of lookups) {
        const where = `${file} ${name || macro}`;
        assert.match(body, /querySelector\(\s*[A-Za-z_$][\w$]*\s*\)/, `${where}: the selector is a variable`);
        assert.match(body, /globalThis\.document/, `${where}: resolves document from globalThis`);
        assert.match(body, /!\s*doc\b/, `${where}: returns when there is no document`);
    }
});

test('the linked-glue check (CI: host_contract_names.mjs) flags a page selector and ignores the canvases', () => {
    assert.deepEqual(findLegacyDomReads('querySelector("#stat").innerHTML="x"'), ['stat']);
    assert.deepEqual(findLegacyDomReads("pmDoc.querySelector('#milkPath')"), ['milkPath']);
    assert.deepEqual(findLegacyDomReads('`#textureDir`'), ['textureDir']);
    assert.deepEqual(findLegacyDomReads('{canvas:"#mcanvas",secondary:"#scanvas"} "#status-bar"'), []);
});

// ---- running the bodies --------------------------------------------------------

/** A page that blows up if the glue so much as looks at `document`. */
function hostileDocument() {
    return new Proxy({}, {
        get(_target, property) {
            throw new Error(`the glue read document.${String(property)}`);
        },
    });
}

/**
 * Compile an EM_JS body the way Emscripten does: a function of its C++
 * parameters, with the runtime's helpers in scope.
 */
function compile(name, runtime) {
    const block = bindings.find((candidate) => candidate.name === name);
    assert.ok(block, `${name} not found`);
    const helpers = Object.keys(runtime);
    return new Function(...helpers, ...block.params, block.body).bind(null, ...helpers.map((key) => runtime[key]));
}

/** Runs `fn` with `globalThis` properties set, then puts every one back. */
async function withGlobals(overrides, fn) {
    const saved = new Map();
    for (const key of Object.keys(overrides)) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: overrides[key] });
    }
    const consoleSaved = { log: console.log, warn: console.warn };
    console.log = console.warn = () => {};
    try {
        return await fn();
    } finally {
        Object.assign(console, consoleSaved);
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

const utf8 = { UTF8ToString: (text) => text };

test('a preset switch failure cannot throw on a page with no #stat (or no document)', async () => {
    const report = compile('js_report_preset_switch_failed', utf8);
    const calls = [];
    for (const document of [undefined, hostileDocument(), { querySelector: () => null }]) {
        calls.length = 0;
        await withGlobals({
            document,
            projectMPresetSwitchFailed: undefined,
            projectMPresetSwitchFailure: undefined,
            pmOnPresetSwitchFailed: (...args) => calls.push(args),
        }, () => {
            report(7, '/presets/bad.milk', 'warp shader failed');
            assert.deepEqual(calls, [[7, '/presets/bad.milk', 'warp shader failed']], 'reaches the callback bus');
            assert.equal(globalThis.projectMPresetSwitchFailed, true, 'the polled flag stays for smoke tests');
            assert.deepEqual(globalThis.projectMPresetSwitchFailure, { preset: '/presets/bad.milk', message: 'warp shader failed' });
        });
    }
});

test('a preset switch failure with no subscriber and no names is still just a warning', async () => {
    const report = compile('js_report_preset_switch_failed', utf8);
    await withGlobals({ document: hostileDocument(), pmOnPresetSwitchFailed: undefined }, () => {
        report(0, null, null);
        assert.deepEqual(globalThis.projectMPresetSwitchFailure, { preset: '(unknown preset)', message: '' });
    });
});

/** A BroadcastChannel that records itself instead of holding the event loop open. */
function fakeBroadcastChannel(registry) {
    return class FakeBroadcastChannel {
        constructor(name) {
            this.name = name;
            this.listeners = [];
            this.posted = [];
            registry.push(this);
        }
        addEventListener(type, listener) { this.listeners.push([type, listener]); }
        postMessage(message) { this.posted.push(message); }
    };
}

function fakeVfs() {
    const files = new Map();
    const dirs = [];
    return {
        files,
        dirs,
        FS: {
            stat: (path) => { if (!files.has(path)) throw new Error('ENOENT'); },
            mkdir: (path) => { dirs.push(path); },
            writeFile: (path, bytes) => { files.set(path, bytes); },
            unlink: (path) => { files.delete(path); },
        },
    };
}

test('the glue init sets up the VFS and the song hook without reading the page', async () => {
    const channels = [];
    const { files, dirs, FS } = fakeVfs();
    const ccalls = [];
    const timers = [];
    const init = compile('js_init_projectm_glue', { FS, Module: { ccall: (...args) => ccalls.push(args) } });

    // Two songs inside one millisecond would share a file name.
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => (clock += 1);
    try {
        await withGlobals({
            document: hostileDocument(),
            BroadcastChannel: fakeBroadcastChannel(channels),
            setTimeout: (fn) => { timers.push(fn); return 0; },
            projectMGlueInitialized: undefined,
            projectMLastSongPath: undefined,
        }, () => {
            init();
            assert.deepEqual(dirs, ['/presets', '/textures', '/snd']);
            assert.deepEqual(channels.map((channel) => channel.name), ['file']);

            // The legacy FLAC decoder posts a decoded WAV: it lands in /snd, the host
            // safety net learns the path, and pl() is called once the timer fires.
            const [, listener] = channels[0].listeners.find(([type]) => type === 'message');
            listener({ data: { data: new Uint8Array([1, 2, 3]).buffer } });
            const [firstPath] = [...files.keys()];
            assert.match(firstPath, /^\/snd\/song_\d+\.wav$/);
            assert.equal(globalThis.projectMLastSongPath, firstPath);
            assert.deepEqual(ccalls, [], 'pl() waits for the timer');
            timers.shift()();
            assert.deepEqual(ccalls, [['pl', null, ['string'], [firstPath]]]);
            const shutDown = channels.find((channel) => channel.name === 'shutDown');
            assert.deepEqual(shutDown?.posted, [{ data: 222 }], 'and the decoder is told to shut down');

            // A second song replaces the first rather than piling up in the VFS.
            listener({ data: { data: new Uint8Array([4]).buffer } });
            assert.equal(files.size, 1, 'the previous song file was unlinked');
            assert.equal(files.has(firstPath), false);
            assert.equal(globalThis.projectMLastSongPath, [...files.keys()][0]);

            // Idempotent: a second init() on the same page must not add a second listener.
            init();
            assert.equal(channels.filter((channel) => channel.name === 'file').length, 1);
        });
    } finally {
        Date.now = realNow;
    }
});

test('the glue init is a no-op in a worker, where there is no document', async () => {
    const channels = [];
    const { dirs, FS } = fakeVfs();
    const init = compile('js_init_projectm_glue', { FS, Module: {} });
    await withGlobals({
        document: undefined,
        BroadcastChannel: fakeBroadcastChannel(channels),
        projectMGlueInitialized: undefined,
    }, () => {
        init();
        assert.deepEqual(dirs, []);
        assert.deepEqual(channels, []);
        assert.equal(globalThis.projectMGlueInitialized, undefined);
    });
});
