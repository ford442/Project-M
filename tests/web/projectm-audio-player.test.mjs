// Run with: node --test tests/web/projectm-audio-player.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FLAC_PLAYER_BASE_URL,
    MOD_PLAYER_BASE_URL,
    resolveFlacPlayerUrl,
    resolveModPlayerUrl,
    resolvePlayerUrl,
    withProjectMAudioFlag,
} from '../../html/projectm-audio-player.js';

test('resolvePlayerUrl prefers localStorage then DOM then default', () => {
    const storage = new Map();
    const doc = {
        getElementById(id) {
            if (id === 'flacPlayerUrl') {
                return { textContent: './flac-player/' };
            }
            return null;
        },
    };
    const previousWindow = globalThis.window;
    globalThis.window = {
        location: { href: 'https://projectm.1ink.us/projectm-core.html' },
    };
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
        getItem(key) { return storage.get(key) ?? null; },
        setItem(key, value) { storage.set(key, value); },
    };
    const previousDocument = globalThis.document;
    globalThis.document = doc;
    try {
        assert.equal(
            resolvePlayerUrl('flacPlayerUrl', 'flacPlayerUrl', FLAC_PLAYER_BASE_URL, doc),
            'https://projectm.1ink.us/flac-player/'
        );
        storage.set('flacPlayerUrl', 'https://custom.example/flac/');
        assert.equal(resolveFlacPlayerUrl(), 'https://custom.example/flac/');
        assert.equal(resolveModPlayerUrl(), 'https://test.1ink.us/xm-player/');
    } finally {
        globalThis.window = previousWindow;
        globalThis.localStorage = previousLocalStorage;
        globalThis.document = previousDocument;
    }
});

test('withProjectMAudioFlag adds projectm and optional track url', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: 'https://projectm.1ink.us/' } };
    try {
        const url = withProjectMAudioFlag('./flac-player/', {
            trackUrl: 'https://example.com/song.flac',
        });
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/flac-player/');
        assert.equal(parsed.searchParams.get('projectm'), '1');
        assert.equal(parsed.searchParams.get('url'), 'https://example.com/song.flac');
    } finally {
        globalThis.window = previousWindow;
    }
});

test('default player bases', () => {
    assert.equal(FLAC_PLAYER_BASE_URL, './flac-player/');
    assert.equal(MOD_PLAYER_BASE_URL, 'https://test.1ink.us/xm-player/');
});
