// Run with: node --test tests/web/projectm-textures.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TEXTURE_EXTENSIONS,
    bundleScansAssets,
    isCaptureMode,
    isTextureFile,
    loadPageTextures,
    loadTextureDirectory,
    parseTextureListing,
    resolveTextureDirectory,
    textureFileName,
} from '../../html/projectm-textures.js';

const BASE = 'https://projectm.example/textures/';

// What an Apache auto-index looks like: sort-column and "Parent Directory" links
// first, then the files. Skipping those by position (the old EM_JS did, by magic
// index 5) breaks on any other server, so the parser keys on the extension.
const APACHE_LISTING = `
<html><body><h1>Index of /textures</h1><pre>
<a href="?C=N;O=D">Name</a> <a href="?C=M;O=A">Last modified</a>
<a href="/">Parent Directory</a>
<a href="clouds.PNG">clouds.PNG</a>
<a href="paper%20grain.jpg">paper grain.jpg</a>
<a href="notes.txt">notes.txt</a>
<a href="clouds.PNG">clouds.PNG</a>
<a href="sub/">sub/</a>
<a href='noise.dds?v=2'>noise.dds</a>
</pre></body></html>`;

/** A fetch that serves `routes` ({ url: string | Uint8Array }) and records what it was asked for. */
function fakeFetch(routes) {
    const requested = [];
    const impl = async (url) => {
        requested.push(String(url));
        if (!(url in routes)) {
            return { ok: false, status: 404 };
        }
        const body = routes[url];
        return {
            ok: true,
            status: 200,
            text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
            arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body).buffer.slice(0),
        };
    };
    impl.requested = requested;
    return impl;
}

test('isTextureFile keys on the extension, ignoring case and query strings', () => {
    for (const ext of TEXTURE_EXTENSIONS) {
        assert.equal(isTextureFile(`a.${ext}`), true, ext);
        assert.equal(isTextureFile(`a.${ext.toUpperCase()}`), true, ext);
    }
    assert.equal(isTextureFile('noise.dds?v=2'), true);
    assert.equal(isTextureFile('notes.txt'), false);
    assert.equal(isTextureFile('sub/'), false);
    assert.equal(isTextureFile('png'), false, 'no extension');
    assert.equal(isTextureFile('?C=N;O=D'), false);
});

test('parseTextureListing returns each texture once, as an absolute URL', () => {
    assert.deepEqual(parseTextureListing(APACHE_LISTING, BASE), [
        `${BASE}clouds.PNG`,
        `${BASE}paper%20grain.jpg`,
        `${BASE}noise.dds?v=2`,
    ]);
    assert.deepEqual(parseTextureListing('<p>no links</p>', BASE), []);
});

test('textureFileName decodes the last path segment and refuses anything that is not a plain name', () => {
    assert.equal(textureFileName(`${BASE}paper%20grain.jpg`), 'paper grain.jpg');
    assert.equal(textureFileName(`${BASE}noise.dds?v=2`), 'noise.dds');
    assert.equal(textureFileName(`${BASE}bad%E0%A4%A.png`), 'bad%E0%A4%A.png', 'malformed escape: keep the raw segment');
    assert.equal(textureFileName(`${BASE}..%2Fescape.png`), null, 'a decoded slash would write outside /textures');
    assert.equal(textureFileName(`${BASE}a%5Cb.png`), null, 'backslash');
    assert.equal(textureFileName(BASE), null, 'a directory has no file name');
});

test('resolveTextureDirectory reads #textureDir, appends the slash and resolves against the page', () => {
    const page = 'https://projectm.example/app/index.html';
    const doc = (text) => ({ getElementById: (id) => (id === 'textureDir' && text !== null ? { textContent: text } : null) });
    assert.equal(resolveTextureDirectory(doc('weeks_textures'), page), 'https://projectm.example/app/weeks_textures/');
    assert.equal(resolveTextureDirectory(doc('  ./weeks_textures/ \n'), page), 'https://projectm.example/app/weeks_textures/');
    assert.equal(resolveTextureDirectory(doc('https://cdn.example/t/'), page), 'https://cdn.example/t/');
    assert.equal(resolveTextureDirectory(doc(''), page), 'https://projectm.example/app/textures/', 'empty: default');
    assert.equal(resolveTextureDirectory(doc(null), page), 'https://projectm.example/app/textures/', 'no element: default');
    assert.equal(resolveTextureDirectory(null, page), 'https://projectm.example/app/textures/', 'no document: default');
});

test('isCaptureMode honours the flag and ?capture=1|true', () => {
    assert.equal(isCaptureMode({ __projectMCaptureMode: true }), true);
    assert.equal(isCaptureMode({ location: { search: '?capture=1' } }), true);
    assert.equal(isCaptureMode({ location: { search: '?x=1&capture=true' } }), true);
    assert.equal(isCaptureMode({ location: { search: '?capture=0' } }), false);
    assert.equal(isCaptureMode({}), false);
    assert.equal(isCaptureMode(null), false);
});

test('bundleScansAssets recognises a bundle whose glue still downloads for the page', () => {
    assert.equal(bundleScansAssets({}), false);
    assert.equal(bundleScansAssets({ loadRandomWeeksPreset() {} }), true);
    assert.equal(bundleScansAssets({ loadRandomWeeksPreset: 'nope' }), false);
});

test('loadTextureDirectory writes every texture and keeps going past one that fails', async () => {
    const fetchImpl = fakeFetch({
        [BASE]: APACHE_LISTING,
        [`${BASE}clouds.PNG`]: new Uint8Array([1, 2, 3]),
        // paper grain.jpg: 404
        [`${BASE}noise.dds?v=2`]: new Uint8Array([9]),
    });
    const written = [];
    const warn = console.warn;
    console.warn = () => {};
    const log = console.log;
    console.log = () => {};
    try {
        const result = await loadTextureDirectory({
            baseUrl: BASE,
            fetchImpl,
            writeFile: (name, bytes) => written.push([name, [...bytes]]),
        });
        assert.equal(result.urls.length, 3);
        assert.equal(result.loaded, 2);
        assert.equal(result.failed, 1);
    } finally {
        console.warn = warn;
        console.log = log;
    }
    assert.deepEqual(written.sort(), [['clouds.PNG', [1, 2, 3]], ['noise.dds', [9]]]);
});

test('loadTextureDirectory treats a missing directory as "no textures"', async () => {
    const debug = console.debug;
    console.debug = () => {};
    try {
        const result = await loadTextureDirectory({
            baseUrl: BASE,
            fetchImpl: fakeFetch({}),
            writeFile: () => assert.fail('nothing to write'),
        });
        assert.deepEqual(result, { urls: [], loaded: 0, failed: 0 });
    } finally {
        console.debug = debug;
    }
});

test('a write that throws counts as a failed texture, not a failed scan', async () => {
    const fetchImpl = fakeFetch({ [BASE]: '<a href="a.png">a</a>', [`${BASE}a.png`]: new Uint8Array([1]) });
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
        const result = await loadTextureDirectory({
            baseUrl: BASE,
            fetchImpl,
            writeFile: () => { throw new Error('FS full'); },
        });
        assert.equal(result.failed, 1);
        assert.equal(result.loaded, 0);
    } finally {
        console.warn = warn;
        console.log = log;
    }
});

function silenced(fn) {
    return async () => {
        const saved = { log: console.log, warn: console.warn, debug: console.debug };
        console.log = console.warn = console.debug = () => {};
        try {
            await fn();
        } finally {
            Object.assign(console, saved);
        }
    };
}

test('loadPageTextures fills /textures through module.FS', silenced(async () => {
    const files = new Map();
    const dirs = [];
    const module = {
        FS: {
            mkdirTree: (path) => dirs.push(path),
            writeFile: (path, bytes) => files.set(path, [...bytes]),
        },
    };
    const doc = { getElementById: (id) => (id === 'textureDir' ? { textContent: BASE } : null) };
    const result = await loadPageTextures({
        module,
        documentRef: doc,
        windowRef: {},
        fetchImpl: fakeFetch({ [BASE]: '<a href="a.png">a</a>', [`${BASE}a.png`]: new Uint8Array([7, 8]) }),
    });
    assert.equal(result?.loaded, 1);
    assert.deepEqual(dirs, ['/textures']);
    assert.deepEqual([...files], [['/textures/a.png', [7, 8]]]);
}));

test('loadPageTextures does nothing where there is nothing to do', silenced(async () => {
    const fetchImpl = fakeFetch({});
    const module = { FS: { writeFile: () => assert.fail('no writes') } };
    assert.equal(await loadPageTextures({ module, windowRef: { __projectMCaptureMode: true }, fetchImpl }), null, 'capture page');
    assert.equal(await loadPageTextures({ module, windowRef: { loadRandomWeeksPreset() {} }, fetchImpl }), null, 'the bundle scans for itself');
    assert.equal(await loadPageTextures({ module: null, windowRef: {}, fetchImpl }), null, 'render worker: no VFS on this thread');
    assert.equal(await loadPageTextures({ module: {}, windowRef: {}, fetchImpl }), null, 'module without FS');
    assert.deepEqual(fetchImpl.requested, [], 'none of those touched the network');
}));

test('loadPageTextures never rejects: a network failure is a null result', silenced(async () => {
    const module = { FS: { writeFile() {} } };
    const result = await loadPageTextures({
        module,
        documentRef: null,
        windowRef: {},
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    assert.equal(result, null);
}));
