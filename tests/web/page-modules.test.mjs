// The small page modules that replaced inline scripts: the redirect stub, the
// audio-capture popup, the embed demo, the FLAC player's preboot / boot, the
// B3HD bezel and the PCM test sender. Plus the rule that made them modules:
// no deployed first-party page carries an inline script over ten lines, so
// `npm run typecheck` and `npm run lint` see every line of JavaScript that
// ships.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { bootAudioCapturePage } from '../../html/projectm-audio-capture-page.js';
import { createBezel } from '../../html/projectm-bezel.js';
import { createPcmTestSender } from '../../html/projectm-pcm-test-sender.js';
import { bootFlacPlayer, FLAC_PLAYER_BUNDLE } from '../../html/flac-player/boot.js';
import { installLifecycleEnv } from './helpers/lifecycle-env.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = join(repoRoot, 'html');

// ---- the inline-script budget -------------------------------------------------

/**
 * The pages deploy.py ships (DEPLOY_HTML_GLOBS), minus third-party builds.
 * html/xm-player/ is the external mod-player's build output, deployed as-is.
 */
function deployedPages() {
    const top = readdirSync(html)
        .filter((name) => /^projectm.*\.1ink$/.test(name) || ['projectm-core.html', 'embed-demo.html', 'audio-capture.html'].includes(name))
        .map((name) => join(html, name));
    const flac = readdirSync(join(html, 'flac-player'))
        .filter((name) => name.endsWith('.html'))
        .map((name) => join(html, 'flac-player', name));
    return [...top, ...flac];
}

test('no deployed first-party page has an inline script longer than ten lines', () => {
    const pages = deployedPages();
    assert.ok(pages.length >= 8, `found the deployed pages (${pages.length})`);
    for (const page of pages) {
        const source = readFileSync(page, 'utf8');
        for (const match of source.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
            const body = match[2].replace(/^\n+|\s+$/g, '');
            if (!body) continue;
            const lines = body.split('\n').length;
            assert.ok(lines <= 10, `${relative(repoRoot, page)}: a ${lines}-line inline <script${match[1]}> — move it into a module`);
        }
    }
});

test('the two full hosts boot the shared shell, and nothing else', () => {
    for (const [page, profile] of [['projectm-core.html', 'core'], ['projectm_panel2.1ink', 'panel2']]) {
        const source = readFileSync(join(html, page), 'utf8');
        assert.match(source, new RegExp(`<body data-pm-shell="${profile}">`), `${page} names its profile`);
        assert.match(source, /import \{ boot \} from '\.\/projectm-app-shell\.js';\s*boot\(document\);/);
        assert.doesNotMatch(source, /\bon(click|change|contextmenu)=/, `${page} has an inline event handler left`);
        const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${page} repeats an id`);
    }
    const panel2 = readFileSync(join(html, 'projectm_panel2.1ink'), 'utf8');
    assert.match(panel2, /^<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">/, 'panel2: doctype, then <html>, then charset first in <head>');
    assert.equal((panel2.match(/<title>/g) ?? []).length, 1, 'panel2 has one <title>');
});

// ---- the redirect stub (classic script) -------------------------------------

/** Runs projectm-redirect-stub.js in a vm context for one script tag. */
function runRedirectStub({ target, set, search = '', hash = '' }) {
    const replaced = [];
    const dataset = { target };
    if (set !== undefined) dataset.set = set;
    const location = { search, hash, replace: (url) => replaced.push(url), href: '' };
    const context = vm.createContext({
        URLSearchParams,
        document: { currentScript: { dataset } },
        window: { location },
    });
    vm.runInContext(readFileSync(join(html, 'projectm-redirect-stub.js'), 'utf8'), context);
    return { replaced, location };
}

test('redirect stub: forwards to data-target, keeping the query and hash', () => {
    assert.deepEqual(runRedirectStub({ target: './projectm_panel2.1ink', search: '?wasm=038', hash: '#x' }).replaced, ['./projectm_panel2.1ink?wasm=038#x']);
    assert.deepEqual(runRedirectStub({ target: './projectm-core.html', set: 'experimental=1', search: '?aa=1' }).replaced, ['./projectm-core.html?aa=1&experimental=1']);
    assert.deepEqual(runRedirectStub({ target: './projectm-core.html', set: 'experimental=1' }).replaced, ['./projectm-core.html?experimental=1']);
    assert.deepEqual(runRedirectStub({ target: '' }).replaced, [], 'no target, no redirect');
});

test('redirect stub pages use it', () => {
    for (const page of ['projectm.1ink', 'projectm_new.1ink', 'projectm_panel.1ink']) {
        assert.match(readFileSync(join(html, page), 'utf8'), /<script src="\.\/projectm-redirect-stub\.js" data-target="[^"]+"/, page);
    }
});

// ---- the FLAC player shell ------------------------------------------------------

test('flac-player preboot: Node-ish globals, and audio-only mode from ?projectm=1 or the popup name', () => {
    const run = (search, name = '') => {
        const attributes = {};
        const window = { location: { search }, name };
        vm.runInContext(readFileSync(join(html, 'flac-player', 'preboot.js'), 'utf8'), vm.createContext({
            window,
            URLSearchParams,
            document: { documentElement: { setAttribute: (key, value) => { attributes[key] = value; } } },
        }));
        return { window, attributes };
    };
    const embedded = run('?projectm=1');
    assert.equal(embedded.window.global, embedded.window);
    // Built in the vm's realm: compare its shape, not its prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(embedded.window.process)), { env: {}, browser: true });
    assert.equal(embedded.window.__projectMAudioOnly, true);
    assert.equal(embedded.attributes['data-projectm-audio-only'], '1');
    assert.equal(run('', 'flac-player').window.__projectMEmbed, true);
    const standalone = run('');
    assert.equal(standalone.window.__projectMAudioOnly, false);
    assert.deepEqual(standalone.attributes, {});
});

test('flac-player boot: polyfill, guard and bridge, then the bundle', async () => {
    const appended = [];
    const documentRef = {
        head: { appendChild: (node) => appended.push(node) },
        createElement: (tag) => ({ tagName: tag }),
        getElementById: () => null,
    };
    // No ?rev=: a cache-busting query would load second copies of the guard
    // and bridge modules under new URLs.
    const windowRef = { location: { search: '' }, opener: null, parent: null };
    windowRef.parent = windowRef;
    const savedBuffer = globalThis.Buffer;
    const warn = console.warn;
    console.warn = () => {};
    try {
        await bootFlacPlayer(documentRef, { windowRef });
    } finally {
        console.warn = warn;
        globalThis.Buffer = savedBuffer;
    }
    assert.ok(windowRef.Buffer, 'the Buffer polyfill loaded from vendor/');
    assert.equal(typeof windowRef.__projectMFlacDecodeGuard, 'function', 'the decode guard installed (and returned its undo)');
    assert.equal(windowRef.__projectMPcmBridge?.installed, false, 'a standalone page installs no PCM bridge');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].src, FLAC_PLAYER_BUNDLE);
    assert.equal(appended[0].defer, true);
});

// ---- audio-capture.html ---------------------------------------------------------

/** A button / element with just enough of EventTarget. */
function fakeNode() {
    const listeners = new Map();
    return {
        dataset: {},
        disabled: false,
        textContent: '',
        listeners,
        addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
        fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn({ type })),
    };
}

test('audio-capture page: start, status, stats, stop and dispose', async () => {
    const nodes = { startBtn: fakeNode(), stopBtn: fakeNode(), status: fakeNode(), stats: fakeNode() };
    const documentRef = { getElementById: (id) => nodes[id] ?? null };
    const windowRef = fakeNode();
    let stopped = 0;
    let onStatus = null;
    const page = bootAudioCapturePage(documentRef, {
        windowRef,
        startCapture: async (options) => {
            onStatus = options.onStatus;
            onStatus({ state: 'capturing', message: 'Capturing' });
            return {
                stop: () => {
                    stopped += 1;
                    onStatus({ state: 'stopped', message: 'Stopped' });
                },
                stats: () => ({ captureKind: 'audio-worklet', sampleRate: 48000, blocks: 3, frames: 96000, via: 'opener' }),
            };
        },
    });

    nodes.startBtn.fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.status.dataset.state, 'capturing');
    assert.equal(nodes.startBtn.disabled, true);
    assert.equal(nodes.stopBtn.disabled, false);
    assert.match(nodes.stats.textContent, /audio-worklet · 48000 Hz · 3 blocks · 2\.0s sent via opener/);

    nodes.stopBtn.fire('click');
    assert.equal(stopped, 1);
    assert.equal(nodes.status.dataset.state, 'stopped');
    assert.equal(nodes.startBtn.disabled, false);

    page.dispose();
    for (const node of [nodes.startBtn, nodes.stopBtn, windowRef]) {
        for (const list of node.listeners.values()) assert.equal(list.length, 0, 'dispose removed its listeners');
    }
});

test('audio-capture page: a page without its controls does nothing', () => {
    assert.doesNotThrow(() => bootAudioCapturePage({ getElementById: () => null }, { windowRef: fakeNode() }).dispose());
});

// ---- embed-demo.html ------------------------------------------------------------

test('embed demo: the status line follows the element', async () => {
    const env = installLifecycleEnv({ withCustomElements: true });
    try {
        const { bootEmbedDemo } = await import('../../html/projectm-embed-demo.js');
        const status = env.document.createElement('div');
        status.id = 'status';
        env.document.body.appendChild(status);
        const viz = env.document.createElement('project-m-visualizer');
        viz.tagName = 'PROJECT-M-VISUALIZER';
        env.document.body.appendChild(viz);
        const demo = bootEmbedDemo(env.document);
        viz.dispatch('pm-ready');
        assert.equal(status.textContent, 'Ready');
        viz.dispatch('pm-preset-changed', { detail: { name: 'a.milk' } });
        assert.equal(status.textContent, 'Preset: a.milk');
        viz.dispatch('pm-fps', { detail: { fps: 59.6 } });
        assert.equal(status.dataset.fps, '60');
        const error = console.error;
        console.error = () => {};
        try {
            viz.dispatch('pm-error', { detail: { message: 'boom' } });
        } finally {
            console.error = error;
        }
        assert.equal(status.textContent, 'Error: boom');
        demo.dispose();
        assert.equal(viz._listeners.get('pm-ready').size, 0);
        assert.doesNotThrow(() => bootEmbedDemo({ getElementById: () => null, querySelector: () => null }).dispose());
    } finally {
        env.restore();
    }
});

// ---- the bezel ------------------------------------------------------------------

/** A 2D context that records what was drawn. */
function fake2d() {
    const ops = [];
    return {
        ops,
        beginPath() {},
        arc(x, y, r) { ops.push(['arc', r]); },
        fill() {},
        fillRect() { ops.push(['fillRect']); },
        drawImage() { ops.push(['drawImage']); },
        createPattern: () => ({}),
        set globalCompositeOperation(value) { ops.push(['op', value]); },
        set fillStyle(_) {},
    };
}

function bezelPage({ loaded = true, shut = '2', lns = '1' } = {}) {
    const ctx = fake2d();
    const listeners = [];
    const img = (naturalWidth) => ({
        complete: loaded,
        naturalWidth: loaded ? naturalWidth : 0,
        naturalHeight: loaded ? 1000 : 0,
        style: {},
        addEventListener: (type, fn) => listeners.push(['add', type, fn]),
        removeEventListener: (type, fn) => listeners.push(['remove', type, fn]),
    });
    const nodes = {
        circle: { getContext: () => ctx, width: 0, height: 0 },
        frm: img(2000),
        gl: img(1000),
        tcan: { getContext: () => fake2d(), width: 0, height: 0 },
        shut: { textContent: shut },
        lns: { textContent: lns },
    };
    const frames = new Map();
    let next = 1;
    let now = 0;
    const windowRef = {
        innerWidth: 1600,
        innerHeight: 800,
        performance: { now: () => now },
        requestAnimationFrame: (fn) => {
            frames.set(next, fn);
            return next++;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
    };
    const advance = (ms) => {
        now += ms;
        const pending = [...frames.entries()];
        frames.clear();
        for (const [, fn] of pending) fn();
    };
    return { documentRef: { getElementById: (id) => nodes[id] ?? null }, windowRef, nodes, ctx, frames, advance, listeners };
}

test('bezel: draws the frame with a hole, then opens the iris once', () => {
    const page = bezelPage();
    const bezel = createBezel(page.documentRef, { windowRef: page.windowRef });
    bezel.draw();
    assert.equal(page.nodes.circle.width, 1600);
    assert.equal(page.nodes.circle.height, 800);
    assert.equal(page.nodes.gl.width, Math.round(800 * 1.133));
    assert.match(page.nodes.gl.style.cssText, /display:block;position:absolute/);
    assert.ok(page.ctx.ops.some(([op]) => op === 'drawImage') === false, 'the frame is drawn on the scratch canvas, not here');
    assert.equal(page.nodes.lns.textContent, '2', 'the iris is marked open');
    assert.equal(page.frames.size, 1, 'the iris animates');

    page.advance(400); // 200 px of a 400 px radius
    assert.equal(page.frames.size, 1);
    page.advance(800);
    assert.equal(page.frames.size, 0, 'the iris finished');

    // A redraw keeps it open instead of animating again.
    bezel.draw();
    assert.equal(page.frames.size, 0);
    bezel.dispose();
});

test('bezel: waits for its images; dispose cancels the iris and the waits', () => {
    const page = bezelPage({ loaded: false });
    const bezel = createBezel(page.documentRef, { windowRef: page.windowRef });
    bezel.draw();
    bezel.draw();
    assert.equal(page.listeners.filter(([kind]) => kind === 'add').length, 2, 'one load listener per image, however often draw() runs');
    bezel.dispose();
    assert.equal(page.listeners.filter(([kind]) => kind === 'remove').length, 2);

    const animating = bezelPage();
    const second = createBezel(animating.documentRef, { windowRef: animating.windowRef });
    second.draw();
    assert.equal(animating.frames.size, 1);
    second.dispose();
    assert.equal(animating.frames.size, 0, 'dispose cancelled the iris frame');
    second.draw();
    assert.equal(animating.frames.size, 0, 'draw() after dispose() does nothing');
});

test('bezel: a page without the bezel elements gets a no-op', () => {
    const bezel = createBezel({ getElementById: () => null }, { windowRef: {} });
    assert.doesNotThrow(() => {
        bezel.draw();
        bezel.dispose();
    });
});

// ---- the PCM test sender -----------------------------------------------------------

test('PCM test sender: posts tone blocks to the opener and the channel; stop releases everything', async () => {
    const posted = [];
    const channels = [];
    const savedChannel = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class {
        constructor(name) {
            this.name = name;
            this.closed = false;
            this.messages = [];
            channels.push(this);
        }
        postMessage(message) { this.messages.push(message); }
        close() { this.closed = true; }
    };
    let closedContexts = 0;
    const node = () => ({ connect() {}, start() {}, frequency: {}, gain: {}, type: '' });
    class FakeAudioContext {
        createAnalyser() { return { ...node(), fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(0.25); } }; }
        createOscillator() { return node(); }
        createGain() { return node(); }
        createBiquadFilter() { return node(); }
        async close() { closedContexts += 1; }
    }
    const frames = new Map();
    let next = 1;
    const windowRef = {
        AudioContext: FakeAudioContext,
        opener: { postMessage: (message) => posted.push(message) },
        parent: null,
        requestAnimationFrame: (fn) => {
            frames.set(next, fn);
            return next++;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
    };
    windowRef.parent = windowRef;
    const log = console.log;
    console.log = () => {};
    try {
        const sender = createPcmTestSender({ windowRef });
        await sender.start(false);
        assert.equal(sender.running(), true);
        for (const [id, fn] of [...frames]) {
            frames.delete(id); // a frame runs once, as in a browser
            fn();
        }
        assert.equal(posted.length, 1);
        assert.equal(posted[0].type, 'pcm');
        assert.equal(posted[0].channels, 1);
        assert.equal(posted[0].buffer[0], 0.25);
        assert.equal(channels[0].name, 'projectm-audio');
        assert.equal(channels[0].messages.length, 1);

        sender.dispose();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(sender.running(), false);
        assert.equal(frames.size, 0, 'the frame loop stopped');
        assert.equal(channels[0].closed, true);
        assert.equal(closedContexts, 1);
    } finally {
        console.log = log;
        globalThis.BroadcastChannel = savedChannel;
    }
});
