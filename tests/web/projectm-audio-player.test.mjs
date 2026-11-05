// Run with: node --test tests/web/projectm-audio-player.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FLAC_PLAYER_BASE_URL,
    FLAC_PLAYER_SHELL_REV,
    MOD_PLAYER_BASE_URL,
    createAudioPlayerController,
    isSameOriginUrl,
    openPlayerForPcmFeed,
    resolveFlacPlayerUrl,
    resolveModPlayerUrl,
    resolvePlayerUrl,
    withProjectMAudioFlag,
} from '../../html/projectm-audio-player.js';
import { createFakeDocument, FakeElement } from './helpers/fake-dom.mjs';

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
        assert.equal(parsed.searchParams.get('rev'), FLAC_PLAYER_SHELL_REV);
    } finally {
        globalThis.window = previousWindow;
    }
});

test('withProjectMAudioFlag versions only the FLAC player shell', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: 'https://projectm.1ink.us/' } };
    try {
        const flac = new URL(withProjectMAudioFlag('./flac-player/index.html'));
        assert.equal(flac.searchParams.get('rev'), FLAC_PLAYER_SHELL_REV);
        const mod = new URL(withProjectMAudioFlag(MOD_PLAYER_BASE_URL));
        assert.equal(mod.searchParams.get('rev'), null);
        assert.equal(mod.searchParams.get('projectm'), '1');
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
        const controller = createAudioPlayerController({
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

test('neither controller publishes anything on window (the legacy shim owns those names)', () => {
    const hadWindow = 'window' in globalThis;
    const previousWindow = globalThis.window;
    const names = [
        'cycleAudioPlayer', 'closeAudioPlayer', 'flacPlayer', 'modPlayer', 'openFlacPlayer', 'openModPlayer',
    ];
    globalThis.window = {};
    try {
        const section = createAudioPlayerController({ updateUi() {} });
        const popup = createAudioPlayerController({ updateUi() {} });

        assert.deepEqual(Object.keys(globalThis.window), []);
        for (const name of names) {
            assert.equal(name in globalThis, false, `${name} must not be created as a side effect`);
        }

        // What the shim needs is on the controller instead.
        assert.equal(typeof section.cycleAudioPlayer, 'function');
        assert.equal(typeof section.closeAudioPlayer, 'function');
        assert.equal(typeof section.showAudioPlayer, 'function');
        assert.equal(typeof popup.openFlacPlayer, 'function');
        assert.equal(typeof popup.openModPlayer, 'function');
    } finally {
        if (hadWindow) globalThis.window = previousWindow;
        else delete globalThis.window;
    }
});

test('audio cycle opens tab/system capture as a popup and closes it on the next source', () => {
    const opened = [];
    const closed = [];
    const focused = [];
    const previousOpen = globalThis.open;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousLocation = globalThis.location;
    const previousLocalStorage = globalThis.localStorage;

    globalThis.location = { href: 'https://projectm.1ink.us/1ink.1ink', origin: 'https://projectm.1ink.us' };
    globalThis.window = { location: globalThis.location };
    globalThis.localStorage = { getItem() { return null; }, setItem() {} };
    const flacFrame = { src: '', getAttribute(name) { return name === 'src' ? this.src : null; } };
    const modFrame = { src: '', getAttribute(name) { return name === 'src' ? this.src : null; } };
    const sections = {
        flacPlayerSection: { style: { display: 'none' }, querySelector: () => flacFrame },
        modPlayerSection: { style: { display: 'none' }, querySelector: () => modFrame },
    };
    globalThis.document = {
        getElementById(id) {
            if (id === 'flacPlayerUrl') return { textContent: './flac-player/' };
            if (id === 'modPlayerUrl') return { textContent: 'https://test.1ink.us/xm-player/' };
            return sections[id] ?? { style: {}, classList: { toggle() {} }, textContent: '' };
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
    globalThis.open = (url, name, features) => {
        const handle = {
            name,
            closed: false,
            close() { this.closed = true; closed.push(name); },
            focus() { focused.push(name); },
        };
        opened.push({ url, name, features });
        return handle;
    };

    try {
        const section = createAudioPlayerController({ updateUi() {} });
        section.cycleAudioPlayer();
        section.cycleAudioPlayer();
        section.cycleAudioPlayer();
        assert.match(flacFrame.src, /\/flac-player\//);
        assert.equal(sections.flacPlayerSection.style.display, 'none');
        const captureOpen = opened.filter((entry) => entry.name === 'projectm-audio-capture');
        assert.equal(captureOpen.length, 1);
        assert.match(captureOpen[0].url, /\/audio-capture\.html/);
        assert.equal(new URL(captureOpen[0].url).searchParams.get('projectm'), '1');
        assert.match(captureOpen[0].features, /popup/);

        section.showAudioPlayer('capture');
        assert.equal(
            opened.filter((entry) => entry.name === 'projectm-audio-capture').length,
            1,
            'an open capture window is focused, not replaced'
        );
        assert.deepEqual(focused, ['projectm-audio-capture']);
        // The MOD tab the cycle opened is owned too, and closed when capture opened.
        assert.deepEqual(closed, ['mod-player']);

        section.showAudioPlayer('flac');
        assert.deepEqual(closed, ['mod-player', 'projectm-audio-capture']);

        const popup = createAudioPlayerController({ updateUi() {} });
        popup.showAudioPlayer('capture');
        assert.equal(opened.filter((entry) => entry.name === 'projectm-audio-capture').length, 2);
        const popupOpen = opened.at(-1);
        assert.match(popupOpen.url, /\/audio-capture\.html/);
        assert.equal(popupOpen.name, 'projectm-audio-capture');
        popup.showAudioPlayer('none');
        assert.deepEqual(closed, ['mod-player', 'projectm-audio-capture', 'projectm-audio-capture']);
    } finally {
        globalThis.open = previousOpen;
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.location = previousLocation;
        globalThis.localStorage = previousLocalStorage;
    }
});

// ---- #310: one controller owns every player it opens -----------------------

/**
 * @param {{ sections: boolean }} options
 */
function installPlayerPage({ sections }) {
    const { document } = createFakeDocument();
    document.querySelector = (selector) => (selector.startsWith('#') ? document.getElementById(selector.slice(1)) : null);
    document.querySelectorAll = (selector) =>
        selector === '.ext-player-section'
            ? [document.getElementById('flacPlayerSection'), document.getElementById('modPlayerSection')].filter(Boolean)
            : [];
    const add = (tag, id) => {
        const element = new FakeElement(tag);
        element.id = id;
        document.body.appendChild(element);
        return element;
    };
    add('button', 'audioPlayerBtn');
    if (sections) {
        for (const [sectionId, frameId] of [['flacPlayerSection', 'flacFrame'], ['modPlayerSection', 'modFrame']]) {
            add('section', sectionId).style.display = 'none';
            const frame = add('iframe', frameId);
            Object.defineProperty(frame, 'src', {
                get: () => frame.getAttribute('src') ?? '',
                set: (value) => {
                    frame.setAttribute('src', value);
                },
            });
        }
    }
    const opened = [];
    const saved = ['document', 'window', 'location', 'localStorage', 'open'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const location = { href: 'https://projectm.1ink.us/1ink.1ink', origin: 'https://projectm.1ink.us' };
    define('document', document);
    define('location', location);
    define('window', { location });
    define('localStorage', { getItem: () => null, setItem() {} });
    define('open', (url, name) => {
        const handle = { name, url, closed: false, close() { this.closed = true; }, focus() {} };
        opened.push(handle);
        return handle;
    });
    return {
        document,
        opened,
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}

test('#310: after FLAC opens, the audio button still moves on to MOD and back (section page)', () => {
    const page = installPlayerPage({ sections: true });
    try {
        const controller = createAudioPlayerController({ updateUi() {}, documentRef: page.document });
        const flac = page.document.getElementById('flacPlayerSection');
        controller.cycleAudioPlayer(); // FLAC
        assert.equal(controller.activeSourceId(), 'flac');
        assert.equal(flac.style.display, 'block');

        controller.cycleAudioPlayer(); // the button again: MOD (cross-origin → tab)
        assert.equal(controller.activeSourceId(), 'mod');
        assert.equal(flac.style.display, 'none', 'the FLAC section must not stay over the panel');
        assert.equal(page.opened.length, 1);
        assert.match(page.opened[0].url, /test\.1ink\.us\/xm-player/);

        controller.showAudioPlayer('flac');
        assert.equal(page.opened[0].closed, true, 'the MOD tab is owned and closed on the switch');
        assert.equal(flac.style.display, 'block');

        controller.closeAudioPlayer();
        assert.equal(flac.style.display, 'none');
    } finally {
        page.restore();
    }
});

test('#310: a docked frame (page without sections) is owned: hidden on the next source', () => {
    const page = installPlayerPage({ sections: false });
    try {
        const controller = createAudioPlayerController({ updateUi() {}, documentRef: page.document });
        controller.showAudioPlayer('flac');
        const dock = page.document.getElementById('pm-player-frame-flac-player');
        assert.ok(dock, 'same-origin FLAC docks in a frame on a page without its section');
        assert.equal(dock.style.display, 'block');
        assert.match(dock.getAttribute('style'), /z-index:var\(--pm-z-player/);

        controller.cycleAudioPlayer(); // MOD
        assert.equal(dock.style.display, 'none');
        controller.dispose();
        assert.equal(page.opened[0].closed, true, 'dispose() closes the windows it opened');
        assert.equal(dock.listenerCount('load'), 0, 'dispose() drops the frame hooks');
    } finally {
        page.restore();
    }
});

test('#310: Escape inside a loaded same-origin player closes it and focus returns to the host', () => {
    const page = installPlayerPage({ sections: true });
    let hostFocused = 0;
    const previousFocus = globalThis.focus;
    globalThis.focus = () => hostFocused++;
    try {
        const controller = createAudioPlayerController({ updateUi() {}, documentRef: page.document });
        controller.showAudioPlayer('flac');
        const frame = page.document.getElementById('flacFrame');
        const playerDoc = new FakeElement('document');
        frame.contentDocument = playerDoc;
        frame.dispatch('load');
        assert.equal(hostFocused, 1);
        assert.equal(playerDoc.listenerCount('keydown'), 1);

        playerDoc.dispatch('keydown', { key: 'a' });
        assert.equal(controller.activeSourceId(), 'flac');
        playerDoc.dispatch('keydown', { key: 'Escape' });
        assert.equal(controller.activeSourceId(), 'none');
        assert.equal(page.document.getElementById('flacPlayerSection').style.display, 'none');

        controller.dispose();
        assert.equal(playerDoc.listenerCount('keydown'), 0);
    } finally {
        globalThis.focus = previousFocus;
        page.restore();
    }
});
