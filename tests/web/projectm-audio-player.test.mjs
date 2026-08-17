// Run with: node --test tests/web/projectm-audio-player.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FLAC_PLAYER_BASE_URL,
    MOD_PLAYER_BASE_URL,
    createSectionAudioPlayerController,
    isSameOriginUrl,
    openPlayerForPcmFeed,
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

test('isSameOriginUrl distinguishes host-local players from CDN popups', () => {
    const loc = { href: 'https://projectm.1ink.us/?wasm=036', origin: 'https://projectm.1ink.us' };
    assert.equal(isSameOriginUrl('https://projectm.1ink.us/flac-player/?projectm=1', loc), true);
    assert.equal(isSameOriginUrl('./flac-player/', loc), true);
    assert.equal(isSameOriginUrl('https://go.1ink.us/flac-player/', loc), false);
    assert.equal(isSameOriginUrl('https://test.1ink.us/xm-player/', loc), false);
});

test('openPlayerForPcmFeed embeds same-origin players in an iframe (COOP-safe)', () => {
    const frames = [];
    const opened = [];
    const previousLocation = globalThis.location;
    const previousOpen = globalThis.open;
    const previousDocument = globalThis.document;

    globalThis.location = { href: 'https://projectm.1ink.us/', origin: 'https://projectm.1ink.us' };
    globalThis.open = (url, name) => {
        opened.push({ url, name });
        return { name };
    };
    globalThis.document = {
        getElementById() { return null; },
        createElement() {
            return {
                id: '',
                src: '',
                style: { display: '' },
                setAttribute() {},
                getAttribute() { return ''; },
            };
        },
        body: {
            appendChild(node) { frames.push(node); },
        },
    };

    try {
        const frame = openPlayerForPcmFeed(
            'https://projectm.1ink.us/flac-player/?projectm=1',
            'flac-player',
            globalThis.document
        );
        assert.ok(frame);
        assert.equal(frames.length, 1);
        assert.equal(opened.length, 0, 'same-origin must not window.open');
        assert.match(frame.id, /flac-player/);

        openPlayerForPcmFeed('https://go.1ink.us/flac-player/?projectm=1', 'flac-player');
        assert.equal(opened.length, 1, 'cross-origin opens a tab');
        assert.equal(opened[0].name, 'flac-player');
    } finally {
        globalThis.location = previousLocation;
        globalThis.open = previousOpen;
        globalThis.document = previousDocument;
    }
});

test('section controller iframes same-origin FLAC and popups cross-origin MOD', () => {
    const flacFrame = { src: '', getAttribute(name) { return name === 'src' ? this.src : null; } };
    const modFrame = { src: '', getAttribute(name) { return name === 'src' ? this.src : null; } };
    const sections = {
        flacPlayerSection: { style: { display: 'none' }, querySelector: () => flacFrame },
        modPlayerSection: { style: { display: 'none' }, querySelector: () => modFrame },
    };
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousLocation = globalThis.location;
    const previousLocalStorage = globalThis.localStorage;
    const popups = [];

    globalThis.location = { href: 'https://projectm.1ink.us/', origin: 'https://projectm.1ink.us' };
    globalThis.window = { location: globalThis.location };
    globalThis.localStorage = { getItem() { return null; }, setItem() {} };
    globalThis.document = {
        getElementById(id) {
            if (id === 'flacPlayerUrl') return { textContent: './flac-player/' };
            if (id === 'modPlayerUrl') return { textContent: 'https://test.1ink.us/xm-player/' };
            return sections[id] ?? { style: {}, classList: { toggle() {} } };
        },
        querySelector(sel) {
            if (sel === '#flacFrame') return flacFrame;
            if (sel === '#modFrame') return modFrame;
            return null;
        },
        querySelectorAll() {
            return Object.values(sections);
        },
    };

    try {
        const controller = createSectionAudioPlayerController({
            exposeGlobals: false,
            updateUi() {},
            openPopup(url, target) {
                popups.push({ url, target });
                return { name: target };
            },
        });
        controller.showAudioPlayer('flac');
        assert.match(flacFrame.src, /\/flac-player\//);
        assert.equal(sections.flacPlayerSection.style.display, 'block');
        assert.equal(popups.length, 0);

        controller.showAudioPlayer('mod');
        assert.equal(sections.flacPlayerSection.style.display, 'none');
        assert.equal(popups.length, 1);
        assert.match(popups[0].url, /test\.1ink\.us\/xm-player/);
        assert.equal(popups[0].target, 'mod-player');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.location = previousLocation;
        globalThis.localStorage = previousLocalStorage;
    }
});
