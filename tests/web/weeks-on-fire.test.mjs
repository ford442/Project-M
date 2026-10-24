// Run with: node --test tests/web/weeks-on-fire.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    WEEKS_ON_FIRE_MODE,
    applyWeeksOnFireDomConfig,
    createWeeksPresetLoader,
    isWeeksOnFireMode,
    parseMilkDirectoryListing,
    resolveFlacDecoderUrl,
    resolveWeeksPresetBase,
    startWeeksOnFire,
    wireFlacDecoderBridge,
} from '../../html/projectm-weeks-on-fire.js';

test('isWeeksOnFireMode matches mode query param', () => {
    assert.equal(isWeeksOnFireMode('?mode=weeks_on_fire'), true);
    assert.equal(isWeeksOnFireMode('?mode=other'), false);
    assert.equal(isWeeksOnFireMode(new URLSearchParams(`mode=${WEEKS_ON_FIRE_MODE}`)), true);
});

test('applyWeeksOnFireDomConfig sets weeks folder hidden elements', () => {
    const elements = new Map();
    const doc = {
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, { id, textContent: '' });
            }
            return elements.get(id);
        },
    };
    applyWeeksOnFireDomConfig(doc, {
        presets: './weeks_presets/',
        textures: './weeks_textures/',
        songs: './weeks_songs/',
    });
    assert.equal(doc.getElementById('textureDir').textContent, './weeks_textures/');
    assert.equal(doc.getElementById('songDir').textContent, './weeks_songs/');
    assert.equal(doc.getElementById('weeksPresetDir').textContent, './weeks_presets/');
});

test('resolveFlacDecoderUrl prefers same-origin /flac/', () => {
    const doc = {
        getElementById(id) {
            if (id === 'flacDecoderUrl') {
                return { textContent: '' };
            }
            return null;
        },
    };
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://projectm.1ink.us', href: 'https://projectm.1ink.us/projectm_panel2.1ink' },
    });
    try {
        assert.equal(resolveFlacDecoderUrl(doc), 'https://projectm.1ink.us/flac/');
    } finally {
        delete globalThis.openWeeksFlacDecoder;
        delete globalThis.ensureWeeksFlacDecoderFrame;
        delete globalThis.resolveFlacDecoderUrl;
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: previousLocation,
        });
    }
});

test('applyWeeksOnFireDomConfig sets flacDecoderUrl on same origin', () => {
    const elements = new Map();
    const doc = {
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, { id, textContent: '' });
            }
            return elements.get(id);
        },
        body: { appendChild() {} },
    };
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://projectm.1ink.us', href: 'https://projectm.1ink.us/' },
    });
    try {
        applyWeeksOnFireDomConfig(doc);
        assert.equal(doc.getElementById('flacDecoderUrl').textContent, 'https://projectm.1ink.us/flac/');
    } finally {
        delete globalThis.openWeeksFlacDecoder;
        delete globalThis.ensureWeeksFlacDecoderFrame;
        delete globalThis.resolveFlacDecoderUrl;
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: previousLocation,
        });
    }
});

test('wireFlacDecoderBridge exposes openWeeksFlacDecoder without weeks mode', () => {
    const frames = [];
    const opened = [];
    const doc = {
        getElementById(id) {
            if (id === 'flacDecoderUrl') {
                return { id, textContent: './flac/' };
            }
            if (id === 'weeksFlacDecoderFrame') {
                return null;
            }
            return null;
        },
        createElement() {
            return {
                id: '',
                hidden: false,
                src: '',
                setAttribute() {},
                getAttribute() { return ''; },
            };
        },
        body: {
            appendChild(node) {
                frames.push(node);
            },
        },
    };
    const previousLocation = globalThis.location;
    const previousOpen = globalThis.open;
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://projectm.1ink.us', href: 'https://projectm.1ink.us/1ink.1ink' },
    });
    globalThis.open = (url, name) => {
        opened.push({ url, name });
        return { name };
    };
    try {
        wireFlacDecoderBridge(doc);
        assert.equal(typeof globalThis.openWeeksFlacDecoder, 'function');
        assert.equal(frames.length, 0, 'must not auto-embed until openWeeksFlacDecoder()');
        // Default is a same-origin hidden iframe so COOP agent-cluster BroadcastChannel works.
        const result = globalThis.openWeeksFlacDecoder();
        assert.equal(result, null, 'iframe path returns null');
        assert.equal(opened.length, 0, 'must not window.open by default');
        assert.equal(frames.length, 1, 'embeds weeksFlacDecoderFrame');
        assert.equal(frames[0].id, 'weeksFlacDecoderFrame');

        // Opt-out still opens a tab (no window features).
        const tab = globalThis.openWeeksFlacDecoder({ preferIframe: false });
        assert.equal(opened.length, 1);
        assert.match(opened[0].url, /\/flac\/$/);
        assert.equal(opened[0].name, 'flac-decoder');
        assert.ok(tab);
    } finally {
        delete globalThis.openWeeksFlacDecoder;
        globalThis.open = previousOpen;
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: previousLocation,
        });
    }
});

test('parseMilkDirectoryListing extracts milk URLs', () => {
    const html = `<html><body><pre>
      <a href="/">Parent</a>
      <a href="foo.milk">foo</a>
      <a href="bar%20baz.milk">bar</a>
      <a href="readme.txt">readme</a>
    </pre></body></html>`;
    const urls = parseMilkDirectoryListing(html, 'https://projectm.1ink.us/weeks_presets/');
    assert.deepEqual(urls, [
        'https://projectm.1ink.us/weeks_presets/foo.milk',
        'https://projectm.1ink.us/weeks_presets/bar%20baz.milk',
    ]);
});

// ---- the host-side preset loader (what WasmJsBindings.cpp's XHR code used to do) ----

const WEEKS_BASE = 'https://projectm.example/weeks_presets/';
const WEEKS_LISTING = `<pre>
  <a href="?C=N;O=D">Name</a>
  <a href="/">Parent Directory</a>
  <a href="a.milk">a.milk</a>
  <a href="b%20two.milk">b two.milk</a>
  <a href="c.milk">c.milk</a>
  <a href="readme.txt">readme.txt</a>
</pre>`;

/** A fetch serving `routes` ({ url: string }); `listing.url` is set like a real Response. */
function weeksFetch(routes) {
    const requested = [];
    const impl = async (url) => {
        requested.push(String(url));
        if (!(url in routes)) {
            return { ok: false, status: 404, url };
        }
        const body = routes[url];
        return {
            ok: true,
            status: 200,
            url,
            text: async () => body,
            arrayBuffer: async () => new TextEncoder().encode(body).buffer,
        };
    };
    impl.requested = requested;
    return impl;
}

const WEEKS_ROUTES = {
    [WEEKS_BASE]: WEEKS_LISTING,
    [`${WEEKS_BASE}a.milk`]: 'preset a',
    [`${WEEKS_BASE}b%20two.milk`]: 'preset b',
    [`${WEEKS_BASE}c.milk`]: 'preset c',
};

/** Runs `fn` with console output muted; the loader logs and warns by design. */
async function quiet(fn) {
    const saved = { log: console.log, warn: console.warn };
    console.log = console.warn = () => {};
    try {
        return await fn();
    } finally {
        Object.assign(console, saved);
    }
}

function recorder() {
    const writes = [];
    return {
        writes,
        writePreset: (vfsPath, bytes, mode) => writes.push({ vfsPath, text: new TextDecoder().decode(bytes), mode }),
    };
}

test('resolveWeeksPresetBase reads #weeksPresetDir and falls back to weeks_presets/', () => {
    const page = 'https://projectm.example/app/index.html';
    const doc = (text) => ({ getElementById: (id) => (id === 'weeksPresetDir' && text !== null ? { textContent: text } : null) });
    assert.equal(resolveWeeksPresetBase(doc('weeks_presets'), page), 'https://projectm.example/app/weeks_presets/');
    assert.equal(resolveWeeksPresetBase(doc('https://cdn.example/w/'), page), 'https://cdn.example/w/');
    assert.equal(resolveWeeksPresetBase(doc(null), page), 'https://projectm.example/app/weeks_presets/');
    assert.equal(resolveWeeksPresetBase(null, page), 'https://projectm.example/app/weeks_presets/');
});

test('scan lists the .milk files once and caches the result', async () => {
    const fetchImpl = weeksFetch(WEEKS_ROUTES);
    const loader = createWeeksPresetLoader({ writePreset: () => {}, presetBase: WEEKS_BASE, fetchImpl });
    const urls = await quiet(() => loader.scan());
    assert.deepEqual(urls, [`${WEEKS_BASE}a.milk`, `${WEEKS_BASE}b%20two.milk`, `${WEEKS_BASE}c.milk`]);
    await loader.scan();
    assert.deepEqual(fetchImpl.requested, [WEEKS_BASE], 'a second scan does not fetch');
});

test('a failed scan rejects and is tried again on the next call', async () => {
    const routes = {};
    const loader = createWeeksPresetLoader({ writePreset: () => {}, presetBase: WEEKS_BASE, fetchImpl: weeksFetch(routes) });
    await assert.rejects(loader.scan(), /Failed to list weeks presets \(404\)/);
    Object.assign(routes, WEEKS_ROUTES);
    assert.equal((await quiet(() => loader.scan())).length, 3);
});

test('loadRandom writes one preset with a hard cut and reports its name', async () => {
    const { writes, writePreset } = recorder();
    const shown = [];
    const loader = createWeeksPresetLoader({
        writePreset,
        onPresetLoaded: (name) => shown.push(name),
        presetBase: WEEKS_BASE,
        fetchImpl: weeksFetch(WEEKS_ROUTES),
        random: () => 0.5,
    });
    const name = await quiet(() => loader.loadRandom());
    assert.equal(name, 'b two.milk', 'decoded, from the middle of three');
    assert.equal(writes.length, 1);
    assert.match(writes[0].vfsPath, /^\/presets\/weeks_pick_\d+\.milk$/);
    assert.equal(writes[0].text, 'preset b');
    assert.equal(writes[0].mode, 'load-hard');
    assert.deepEqual(shown, ['b two.milk']);
});

test('loadRandom ignores a request while one is still downloading', async () => {
    const { writes, writePreset } = recorder();
    const loader = createWeeksPresetLoader({ writePreset, presetBase: WEEKS_BASE, fetchImpl: weeksFetch(WEEKS_ROUTES), random: () => 0 });
    const [first, second] = await quiet(() => Promise.all([loader.loadRandom(), loader.loadRandom()]));
    assert.equal(first, 'a.milk');
    assert.equal(second, null);
    assert.equal(writes.length, 1);
    assert.equal(await quiet(() => loader.loadRandom()), 'a.milk', 'and the next one after it settled goes through');
});

test('loadRandom resolves null, rather than throwing, when nothing can be loaded', async () => {
    const empty = createWeeksPresetLoader({
        writePreset: () => assert.fail('nothing to write'),
        presetBase: WEEKS_BASE,
        fetchImpl: weeksFetch({ [WEEKS_BASE]: '<pre></pre>' }),
    });
    assert.equal(await quiet(() => empty.loadRandom()), null, 'an empty directory');

    const unlistable = createWeeksPresetLoader({ writePreset: () => assert.fail('nothing to write'), presetBase: WEEKS_BASE, fetchImpl: weeksFetch({}) });
    assert.equal(await quiet(() => unlistable.loadRandom()), null, 'no directory listing');

    const { writes, writePreset } = recorder();
    const routes = { ...WEEKS_ROUTES };
    delete routes[`${WEEKS_BASE}a.milk`];
    const broken = createWeeksPresetLoader({ writePreset, presetBase: WEEKS_BASE, fetchImpl: weeksFetch(routes), random: () => 0 });
    assert.equal(await quiet(() => broken.loadRandom()), null, 'the picked preset 404s');
    assert.deepEqual(writes, []);
    assert.equal(await quiet(() => broken.loadRandom()), null, 'and the in-flight guard was released');
});

test('seed loads the first preset to arrive and adds the rest behind it', async () => {
    const { writes, writePreset } = recorder();
    const shown = [];
    const loader = createWeeksPresetLoader({
        writePreset,
        onPresetLoaded: (name) => shown.push(name),
        presetBase: WEEKS_BASE,
        fetchImpl: weeksFetch(WEEKS_ROUTES),
        random: () => 0,
    });
    const seeded = await quiet(() => loader.seed(2));
    assert.equal(seeded.length, 2);
    assert.deepEqual(writes.map((w) => [w.vfsPath, w.mode]), [
        ['/presets/weeks_0.milk', 'load'],
        ['/presets/weeks_1.milk', 'add'],
    ]);
    assert.deepEqual(shown, [seeded[0]], 'only the preset that was switched to is shown');
});

test('seed takes what exists when asked for more, and survives a download failing', async () => {
    const { writes, writePreset } = recorder();
    const routes = { ...WEEKS_ROUTES };
    delete routes[`${WEEKS_BASE}b%20two.milk`];
    const loader = createWeeksPresetLoader({ writePreset, presetBase: WEEKS_BASE, fetchImpl: weeksFetch(routes), random: () => 0 });
    const seeded = await quiet(() => loader.seed(10));
    assert.equal(seeded.length, 2, 'three in the directory, one of them 404s');
    assert.deepEqual(writes.map((w) => w.mode).sort(), ['add', 'load']);
});

test('startWeeksOnFire seeds, then starts a song after the delay', async () => {
    const { writes, writePreset } = recorder();
    let songs = 0;
    const { loader, ready } = startWeeksOnFire({
        writePreset,
        presetBase: WEEKS_BASE,
        fetchImpl: weeksFetch(WEEKS_ROUTES),
        count: 1,
        songDelayMs: 5,
        playSong: () => { songs += 1; },
    });
    const seeded = await quiet(() => ready);
    assert.equal(seeded.length, 1);
    assert.equal(writes[0].mode, 'load');
    assert.equal(songs, 0, 'not before the delay');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(songs, 1);
    assert.equal(typeof loader.loadRandom, 'function');
});

test('startWeeksOnFire never rejects: no listing is an empty playlist and no song', async () => {
    let songs = 0;
    const { ready } = startWeeksOnFire({
        writePreset: () => assert.fail('nothing to write'),
        presetBase: WEEKS_BASE,
        fetchImpl: weeksFetch({}),
        songDelayMs: 1,
        playSong: () => { songs += 1; },
    });
    assert.deepEqual(await quiet(() => ready), []);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(songs, 0);
});

test('a song that cannot start is a warning, not an unhandled rejection', async () => {
    const warnings = [];
    const saved = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const { ready } = startWeeksOnFire({
            writePreset: () => {},
            presetBase: WEEKS_BASE,
            fetchImpl: weeksFetch(WEEKS_ROUTES),
            count: 1,
            songDelayMs: 1,
            playSong: () => Promise.reject(new Error('autoplay blocked')),
        });
        await ready;
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        Object.assign(console, saved);
    }
    assert.ok(warnings.some((line) => line.includes('could not start a song')), warnings.join('\n'));
});
