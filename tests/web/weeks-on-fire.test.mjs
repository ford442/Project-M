// Run with: node --test tests/web/weeks-on-fire.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    WEEKS_ON_FIRE_MODE,
    applyWeeksOnFireDomConfig,
    isWeeksOnFireMode,
    parseMilkDirectoryListing,
    resolveFlacDecoderUrl,
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
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://projectm.1ink.us', href: 'https://projectm.1ink.us/1ink.1ink' },
    });
    try {
        wireFlacDecoderBridge(doc);
        assert.equal(typeof globalThis.openWeeksFlacDecoder, 'function');
        assert.equal(frames.length, 1);
        assert.match(frames[0].src, /\/flac\/$/);
    } finally {
        delete globalThis.openWeeksFlacDecoder;
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
