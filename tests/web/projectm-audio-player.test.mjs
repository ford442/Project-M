// Run with: node --test tests/web/projectm-audio-player.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FLAC_PLAYER_BASE_URL,
    FLAC_PLAYER_SHELL_REV,
    MOD_PLAYER_BASE_URL,
    createPopupAudioPlayerController,
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
        const controller = createSectionAudioPlayerController({
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
        const section = createSectionAudioPlayerController({ updateUi() {} });
        const popup = createPopupAudioPlayerController({ updateUi() {} });

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
        const section = createSectionAudioPlayerController({ updateUi() {} });
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
        assert.equal(closed.length, 0);

        section.showAudioPlayer('flac');
        assert.deepEqual(closed, ['projectm-audio-capture']);

        const popup = createPopupAudioPlayerController({ updateUi() {} });
        popup.showAudioPlayer('capture');
        assert.equal(opened.filter((entry) => entry.name === 'projectm-audio-capture').length, 2);
        const popupOpen = opened.at(-1);
        assert.match(popupOpen.url, /\/audio-capture\.html/);
        assert.equal(popupOpen.name, 'projectm-audio-capture');
        popup.showAudioPlayer('none');
        assert.deepEqual(closed, ['projectm-audio-capture', 'projectm-audio-capture']);
    } finally {
        globalThis.open = previousOpen;
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.location = previousLocation;
        globalThis.localStorage = previousLocalStorage;
    }
});

/**
 * Just enough page for the controllers: a window.open that records what it was
 * given, and a document whose iframe feeders can be told apart when removed.
 * Returns the recorders and a restore().
 */
function installPlayerPage() {
    const saved = {
        open: globalThis.open,
        document: globalThis.document,
        window: globalThis.window,
        location: globalThis.location,
        localStorage: globalThis.localStorage,
    };
    const windows = [];
    const frames = [];
    const sections = {
        flacPlayerSection: { style: { display: 'none' }, querySelector: () => null },
        modPlayerSection: { style: { display: 'none' }, querySelector: () => null },
    };

    globalThis.location = { href: 'https://projectm.1ink.us/projectm-core.html', origin: 'https://projectm.1ink.us' };
    globalThis.window = { location: globalThis.location };
    globalThis.localStorage = { getItem() { return null; }, setItem() {} };
    globalThis.open = (url, name) => {
        const handle = {
            name,
            url,
            closed: false,
            close() { this.closed = true; },
            focus() {},
        };
        windows.push(handle);
        return handle;
    };
    globalThis.document = {
        getElementById(id) {
            if (id === 'flacPlayerUrl') return { textContent: './flac-player/' };
            if (id === 'modPlayerUrl') return { textContent: 'https://test.1ink.us/xm-player/' };
            return frames.find((frame) => frame.id === id) ?? sections[id] ?? null;
        },
        querySelector() { return null; },
        querySelectorAll() { return Object.values(sections); },
        createElement() {
            return {
                id: '',
                src: '',
                style: { display: '' },
                removed: false,
                setAttribute() {},
                getAttribute() { return ''; },
                remove() { this.removed = true; },
            };
        },
        body: { appendChild(node) { frames.push(node); } },
    };

    return {
        windows,
        frames,
        sections,
        restore() {
            globalThis.open = saved.open;
            globalThis.document = saved.document;
            globalThis.window = saved.window;
            globalThis.location = saved.location;
            globalThis.localStorage = saved.localStorage;
        },
    };
}

test('the section controller disposes the capture popup it opened, once', () => {
    const page = installPlayerPage();
    try {
        const section = createSectionAudioPlayerController({ updateUi() {} });
        assert.equal(typeof section.dispose, 'function');

        section.showAudioPlayer('capture');
        assert.equal(page.windows.length, 1);
        assert.equal(page.windows[0].closed, false);
        page.sections.flacPlayerSection.style.display = 'block';

        section.dispose();
        assert.equal(page.windows[0].closed, true);
        assert.equal(
            page.sections.flacPlayerSection.style.display,
            'block',
            'the page owns its inline sections; disposal leaves them alone'
        );

        // Nothing is tracked any more: a second dispose must not touch a handle
        // the page has since reused for something else.
        page.windows[0].closed = false;
        section.dispose();
        assert.equal(page.windows[0].closed, false);
    } finally {
        page.restore();
    }
});

test('the popup controller disposes every window and feeder frame it opened', () => {
    const page = installPlayerPage();
    try {
        const popup = createPopupAudioPlayerController({ updateUi() {} });
        assert.equal(typeof popup.dispose, 'function');

        popup.showAudioPlayer('flac'); // same-origin: an iframe feeder, never a window
        assert.equal(page.frames.length, 1);
        assert.equal(page.windows.length, 0);

        popup.showAudioPlayer('mod'); // cross-origin: a real window; the flac frame is only hidden
        assert.equal(page.windows.length, 1);
        assert.equal(page.frames[0].style.display, 'none');
        assert.equal(page.frames[0].removed, false, 'switching sources keeps the feeder loaded');

        popup.showAudioPlayer('capture');
        assert.equal(page.windows.length, 2);
        assert.equal(page.windows[0].closed, true, 'switching sources closes the previous window');
        const captureWindow = page.windows[1];

        popup.dispose();
        assert.equal(captureWindow.closed, true);
        assert.equal(
            page.frames[0].removed,
            true,
            'disposal removes a feeder that was only hidden by an earlier switch, not just the live one'
        );

        // Idempotent: a second call finds nothing left to release.
        page.frames[0].removed = false;
        popup.dispose();
        assert.equal(page.frames[0].removed, false);
    } finally {
        page.restore();
    }
});

test('showing a popup source again focuses its window rather than replacing it', () => {
    const page = installPlayerPage();
    try {
        const popup = createPopupAudioPlayerController({ updateUi() {} });
        popup.showAudioPlayer('capture');
        popup.showAudioPlayer('capture');
        assert.equal(page.windows.length, 1);
        assert.equal(page.windows[0].closed, false);

        // The shared release loop must still track the reused window.
        popup.dispose();
        assert.equal(page.windows[0].closed, true);
    } finally {
        page.restore();
    }
});
