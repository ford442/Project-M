// Tests for html/projectm-app-shell.js (+ projectm-app-shell-ui.js): the shell
// projectm-core.html and projectm_panel2.1ink boot. Each test builds the parts
// of the page markup the shell reads into the lifecycle fake DOM, boots a real
// ProjectMContext on a fake Module, drives the page through its buttons, and
// checks that dispose() leaves nothing behind.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    boot,
    resolveContextAttributes,
    resolvePresetAutoSwitchMs,
    resolveRenderConfig,
    resolveShellProfile,
    SHELL_PROFILES,
} from '../../html/projectm-app-shell.js';
import { hideInitError } from '../../html/projectm-init-errors.js';
import { installLifecycleEnv, makeFakeModule } from './helpers/lifecycle-env.mjs';

/** A Storage over a Map. */
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
    };
}

/**
 * The markup the shell looks for, built into the fake document.
 * @param {ReturnType<typeof installLifecycleEnv>} env
 * @param {'core' | 'panel2'} profile
 */
function buildPage(env, profile) {
    const doc = env.document;
    const el = (tag, attrs = {}, parent = doc.body) => {
        const node = doc.createElement(tag);
        const { dataset, className, ...rest } = attrs;
        Object.assign(node, rest);
        if (className) node.className = className;
        if (dataset) Object.assign(node.dataset, dataset);
        parent.appendChild(node);
        return node;
    };
    doc.body.dataset.pmShell = profile;

    const wrap = el('div', { id: 'wrap' });
    el('canvas', { id: 'circle', getContext: () => null }, wrap);
    const contain = el('div', { id: 'contain1' }, wrap);
    el('canvas', { id: 'mcanvas' }, contain);
    el('canvas', { id: 'scanvas' }, contain);

    const panel = el('div', { id: 'panel-container' });
    const button = (id, action) => el('button', { id, className: 'clickable-button', dataset: { pmAction: action } }, panel);
    const buttons = {
        lock: button('lockPresetBtn', 'lockPreset'),
        random: button('randomPresetBtn', 'randomPreset'),
        custom: button('customMilkBtn', 'randomCustom'),
        bezel: button('toggleBezelBtn', 'fullWindow'),
        hide: button('hidePanelBtn', 'hidePanel'),
        missing: button('missingBtn', 'noSuchAction'),
    };
    if (profile === 'core') buttons.glass = button('transparencyBtn', 'toggleTransparencyMode');
    el('div', { id: 'knob' }, panel);
    el('span', { className: 'led led--beat' }, panel);
    el('button', { id: 'show-btn', className: 'hidden', dataset: { pmAction: 'showPanel' } });
    el('div', { id: 'stat' });
    el('div', { id: 'preset-name' });
    el('img', { id: 'splash1' });
    el('img', { id: 'splash2' });
    if (profile === 'panel2') {
        el('select', { id: 'wasmVersionSelect' });
        el('img', { id: 'frm', complete: false, naturalWidth: 0 });
        el('img', { id: 'gl', complete: false, naturalWidth: 0 });
        el('canvas', { id: 'tcan' });
        el('div', { id: 'shut', textContent: '2' });
        el('div', { id: 'lns', textContent: '1' });
    }
    return buttons;
}

/** Window members the shell reads that the lifecycle env does not model. */
function decorateWindow(env, storage) {
    Object.assign(env.window, {
        localStorage: storage,
        innerWidth: 1280,
        innerHeight: 720,
        navigator: { hardwareConcurrency: 8 },
        matchMedia: () => ({ matches: true }), // reduced motion: no LED interval / wobble
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        open: () => null,
    });
    env.window.location.hostname = 'projectm.test';
}

/** Click as the browser would: an event on the button that bubbles to the document. */
function click(env, element) {
    env.document.dispatch('click', { target: element, preventDefault() {} });
}

/**
 * Boots a shell in a fresh environment and always tears both down.
 * @param {{ profile: 'core' | 'panel2', storage?: object, search?: string }} setup
 * @param {(t: { env: any, shell: any, module: any, buttons: any, storage: any }) => Promise<void>} body
 */
async function withShell({ profile, storage = fakeStorage(), search = '', bootOptions = {} }, body) {
    const env = installLifecycleEnv();
    const savedFetch = globalThis.fetch;
    // Every preset API / manifest request fails: the shell must cope.
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    env.window.location.search = search;
    decorateWindow(env, storage);
    const buttons = buildPage(env, profile);
    const module = makeFakeModule();
    const warn = console.warn;
    const info = console.info;
    console.warn = () => {};
    console.info = () => {};
    let shell = null;
    try {
        shell = boot(env.document, {
            windowRef: env.window,
            initDelayMs: 0,
            contextOptions: { sharedModule: module },
            baseUrl: 'https://projectm.test/projectm-app-shell.js',
            ...bootOptions,
        });
        await shell.ready;
        await body({ env, shell, module, buttons, storage });
    } finally {
        shell?.dispose();
        console.warn = warn;
        console.info = info;
        hideInitError();
        globalThis.fetch = savedFetch;
        delete globalThis.__projectMSongLoaderInstalled;
        delete globalThis.__projectMWeeksOnFire;
        delete globalThis.__projectMWeeksPaths;
        env.restore();
    }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const moduleCalls = (module, name) => module.calls.filter((call) => call.name === name);

// ---- profiles and URL policy -----------------------------------------------

test('the body names the profile; an unknown one falls back to core', () => {
    const doc = (pmShell) => ({ body: { dataset: { pmShell } } });
    assert.equal(resolveShellProfile(doc('panel2')).name, 'panel2');
    assert.equal(resolveShellProfile(doc(undefined)).name, 'core');
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(resolveShellProfile(doc('nope')).name, 'core');
    } finally {
        console.warn = warn;
    }
    assert.equal(resolveShellProfile(doc('core'), 'panel2'), SHELL_PROFILES.panel2, 'an explicit profile wins');
});

test('context attributes come from the query, then localStorage', () => {
    const storage = fakeStorage({ canvasAA: '1' });
    assert.deepEqual(resolveContextAttributes(new URLSearchParams(''), storage, {}), {
        antialias: true,
        preserveDrawingBuffer: false,
        fboPrecision: 'half',
        depth: false,
        stencil: false,
    });
    const fromQuery = resolveContextAttributes(new URLSearchParams('aa=0&capture=1&fboPrecision=HIGH&depth=true'), storage, {});
    assert.equal(fromQuery.antialias, false, '?aa=0 beats localStorage');
    assert.equal(fromQuery.preserveDrawingBuffer, true);
    assert.equal(fromQuery.fboPrecision, 'high');
    assert.equal(fromQuery.stencil, true, 'stencil follows depth');
    assert.equal(resolveContextAttributes(new URLSearchParams(''), null, { __projectMCaptureMode: true }).preserveDrawingBuffer, true);
});

test('render config: governor, mesh quality and musical scheduling', () => {
    const defaults = resolveRenderConfig(new URLSearchParams(''), null, 2);
    assert.equal(defaults.targetFps, 60);
    assert.equal(defaults.qualityGovernor, true);
    assert.equal(defaults.meshQuality, 'low', 'auto picks low on a 2-core machine');
    assert.equal(defaults.presetSwitchPolicy, 'timer');
    assert.equal(defaults.presetSwitchBars, 16);

    const tuned = resolveRenderConfig(new URLSearchParams('targetFps=30&governor=0&switchOn=bars&switchBars=32&transitionBeats=1&bpm=128&rhythmDebug=1'), null, 8);
    assert.equal(tuned.targetFps, 30);
    assert.equal(tuned.qualityGovernor, false);
    assert.equal(tuned.meshQuality, 'high');
    assert.equal(tuned.presetSwitchPolicy, 'bars');
    assert.equal(tuned.presetSwitchBars, 32);
    assert.equal(tuned.transitionBeats, 1);
    assert.equal(tuned.rhythmHint, 128);
    assert.equal(tuned.rhythmDebug, true);

    assert.equal(resolveRenderConfig(new URLSearchParams(''), fakeStorage({ targetFps: '45', meshQuality: 'high' }), 1).targetFps, 45);
});

test('?presetDuration= sets the auto-switch period, with a 5 s floor', () => {
    assert.equal(resolvePresetAutoSwitchMs(new URLSearchParams('')), 40_000);
    assert.equal(resolvePresetAutoSwitchMs(new URLSearchParams('presetDuration=12')), 12_000);
    assert.equal(resolvePresetAutoSwitchMs(new URLSearchParams('presetDuration=1')), 40_000);
});

// ---- the core page ------------------------------------------------------------

test('core: boot starts an engine and the page buttons drive it', async () => {
    await withShell({ profile: 'core' }, async ({ env, shell, module, buttons, storage }) => {
        const context = shell.context();
        assert.ok(context?.ready, 'the context started');
        assert.equal(env.window.projectMContext, context, 'the console handle is published');
        // The preset library builds its panel from innerHTML, which this fake
        // DOM does not parse: it fails to build, and the page boots without it.
        assert.equal(env.window.presetPicker, undefined);
        assert.equal(typeof env.window.toggleTransparencyMode, 'function');

        click(env, buttons.lock);
        assert.ok(env.document.body.classList.contains('has-lock'));
        assert.ok(buttons.lock.classList.contains('engaged'));
        assert.equal(storage.getItem('projectm:presetLocked'), '1', 'core remembers the lock');
        assert.deepEqual(moduleCalls(module, '_set_preset_locked').at(-1)?.args, [1], 'the engine was locked');

        // Locked: Random shows the toast instead of switching.
        click(env, buttons.random);
        assert.match(env.document.getElementById('stat').textContent, /Preset locked/);

        click(env, buttons.glass);
        assert.ok(env.document.body.classList.contains('has-transparency'));
        assert.equal(storage.getItem('projectm:transparencyMode'), '1');

        click(env, buttons.bezel);
        assert.equal(context.options.aspectCorrection, false, 'full-window mode drops aspect correction');
        assert.equal(env.document.getElementById('contain1').style.position, 'fixed');

        // An unknown action warns and does nothing else.
        assert.doesNotThrow(() => click(env, buttons.missing));
    });
});

test('core: a remembered lock and ?transparent=1 are applied before the engine starts', async () => {
    const storage = fakeStorage({ 'projectm:presetLocked': '1' });
    await withShell({ profile: 'core', storage, search: '?transparent=1' }, async ({ env, shell }) => {
        assert.ok(env.document.body.classList.contains('has-lock'));
        assert.ok(env.document.body.classList.contains('has-transparency'));
        assert.equal(shell.context().options.presetLocked, true);
        assert.equal(shell.context().options.transparent, true);
    });
});

test('core: dispose() destroys the engine and leaves no listener, timer, channel or global', async () => {
    const env = installLifecycleEnv();
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    decorateWindow(env, fakeStorage());
    buildPage(env, 'core');
    const warn = console.warn;
    const info = console.info;
    console.warn = () => {};
    console.info = () => {};
    const timers = new Set();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => {
        const id = realSetInterval(fn, ms);
        timers.add(id);
        return id;
    };
    globalThis.clearInterval = (id) => {
        timers.delete(id);
        realClearInterval(id);
    };
    try {
        const module = makeFakeModule();
        const shell = boot(env.document, { windowRef: env.window, initDelayMs: 0, contextOptions: { sharedModule: module } });
        await shell.ready;
        // Let the optional song-loader import settle so its patch is owned too.
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(shell.context()?.ready);
        assert.ok(env.allListeners.adds > 0, 'the shell wired listeners');
        assert.ok(timers.size > 0, 'the auto preset switch is running');

        shell.dispose();
        assert.equal(shell.context(), null);
        // A shared Module is not the context's to destruct; its engine is.
        assert.ok(moduleCalls(module, 'destroy_host').length > 0, 'the engine was destroyed');
        assert.deepEqual(env.allListeners.outstanding(), {}, 'a listener survived dispose()');
        assert.deepEqual(env.windowLedger.outstanding(), {});
        assert.equal(timers.size, 0, 'an interval survived dispose()');
        assert.equal(env.openChannels().length, 0, 'a BroadcastChannel was left open');
        for (const name of ['projectMContext', 'presetPicker', 'toggleTransparencyMode', 'updatePresetDisplay', 'openAudioCapture', 'startLocalProjectMTestSender', 'cycleAudioPlayer']) {
            assert.equal(env.window[name], undefined, `window.${name} survived dispose()`);
        }
        assert.equal(globalThis.BroadcastChannel.projectMNativeBroadcastChannel, undefined, 'the BroadcastChannel patch was undone');
        assert.doesNotThrow(() => shell.dispose(), 'dispose() is idempotent');
    } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        for (const id of timers) realClearInterval(id);
        console.warn = warn;
        console.info = info;
        hideInitError();
        globalThis.fetch = savedFetch;
        delete globalThis.__projectMSongLoaderInstalled;
        env.restore();
    }
});

test('a page without cross-origin isolation shows the init error and builds no engine', async () => {
    const env = installLifecycleEnv({ crossOriginIsolated: false });
    decorateWindow(env, fakeStorage());
    buildPage(env, 'core');
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const warn = console.warn;
    console.warn = () => {};
    try {
        const shell = boot(env.document, { windowRef: env.window, initDelayMs: 0, contextOptions: { sharedModule: makeFakeModule() } });
        await shell.ready;
        assert.equal(shell.context(), null);
        shell.dispose();
    } finally {
        console.warn = warn;
        hideInitError();
        globalThis.fetch = savedFetch;
        delete globalThis.__projectMSongLoaderInstalled;
        env.restore();
    }
});

// ---- the panel2 page ----------------------------------------------------------

test('panel2: keyboard shortcuts, no persisted lock, and the WASM version picker', async () => {
    await withShell({ profile: 'panel2' }, async ({ env, shell, buttons, storage }) => {
        assert.ok(shell.context()?.ready);
        assert.equal(shell.actions.toggleTransparencyMode, undefined, 'panel2 has no glass toggle');

        env.document.dispatch('keydown', { key: 'l', preventDefault() {} });
        assert.ok(buttons.lock.classList.contains('engaged'), 'L locks');
        assert.equal(storage.getItem('projectm:presetLocked'), null, 'panel2 does not remember the lock');
        env.document.dispatch('keydown', { key: 'L', preventDefault() {} });
        assert.ok(!buttons.lock.classList.contains('engaged'), 'L again unlocks');

        const select = env.document.getElementById('wasmVersionSelect');
        assert.ok(select.children.length > 0, 'the picker lists the selectable builds');
        assert.ok(select.children.some((option) => /\(active\)$/.test(option.textContent)), 'the active build is marked');

        click(env, buttons.hide);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(env.document.getElementById('panel-container').style.display, 'none');
        click(env, env.document.getElementById('show-btn'));
        assert.equal(env.document.getElementById('panel-container').style.display, 'block');
    });
});

test('panel2: the bezel waits for its images and is torn down with the shell', async () => {
    await withShell({ profile: 'panel2' }, async ({ env }) => {
        const frame = env.document.getElementById('frm');
        assert.ok(frame._listeners.get('load')?.size > 0, 'the bezel waits for the frame image');
    });
});

// ---- the rest of the page --------------------------------------------------------

test('core: the remaining actions run, and Random falls back to the bundled presets', async () => {
    await withShell({ profile: 'core' }, async ({ env, shell, module }) => {
        const { actions } = shell;
        const switches = () => module.calls.filter((call) => /switch_preset|play_next|next_preset/.test(call.name)).length;
        const before = switches();
        // No picker on this fake page: Random Custom is Random, and with the
        // preset API down both cycle the bundled presets.
        actions.randomCustom();
        actions.randomPreset();
        await tick(20);
        assert.ok(switches() > before, 'the API fallback switched to a bundled preset');

        let fullscreenRequests = 0;
        env.document.documentElement = { requestFullscreen: async () => { fullscreenRequests += 1; } };
        env.document.fullscreenElement = null;
        actions.toggleFullscreen();
        assert.equal(fullscreenRequests, 1);
        assert.equal(shell.context().options.aspectCorrection, false, 'fullscreen leaves bezel mode');
        let exits = 0;
        env.document.fullscreenElement = {};
        env.document.exitFullscreen = async () => { exits += 1; };
        actions.toggleFullscreen();
        actions.fullWindow(); // back to bezel
        actions.fullWindow(); // and out again, leaving fullscreen
        assert.equal(exits, 2);

        // The audio-player controller reads the page's localStorage directly.
        const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStorage() });
        try {
            assert.doesNotThrow(() => {
                actions.startChangeSong();
                actions.cycleAudioPlayer();
                actions.closeAudioPlayer();
            });
        } finally {
            if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage);
            else delete globalThis.localStorage;
        }
        await tick(5);
    });
});

test('core: ?localPresets=1 wires the drop zone; a failed load shows on #stat', async () => {
    // The drop zone is wired at boot, so its markup goes in first.
    const env = installLifecycleEnv();
    decorateWindow(env, fakeStorage({ 'projectm:lastLocalPresetName': 'old.milk' }));
    env.window.location.search = '?localPresets=1';
    buildPage(env, 'core');
    const doc = env.document;
    const make = (tag, id, parent = doc.body) => {
        const node = doc.createElement(tag);
        node.id = id;
        parent.appendChild(node);
        return node;
    };
    const panel = make('section', 'local-preset-dev');
    panel.hidden = true;
    const dropzone = make('div', 'local-preset-dropzone', panel);
    const last = make('div', 'localPresetLast', panel);
    const input = make('input', 'localPresetInput', panel);
    const warn = console.warn;
    const error = console.error;
    console.warn = () => {};
    console.error = () => {};
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    let shell = null;
    try {
        shell = boot(doc, { windowRef: env.window, initDelayMs: 60_000 });
        assert.equal(panel.hidden, false);
        assert.equal(last.textContent, 'Last local preset: old.milk');

        dropzone.dispatch('dragover', { preventDefault() {} });
        assert.ok(dropzone.classList.contains('dragover'));
        dropzone.dispatch('dragleave', { preventDefault() {} });
        assert.ok(!dropzone.classList.contains('dragover'));

        input.files = [{ name: 'not-a-preset.txt', size: 3 }];
        input.dispatch('change');
        await tick(5);
        // No engine yet: the load is refused, and the page says so.
        assert.match(doc.getElementById('stat').textContent, /Module not ready/);
        assert.equal(input.value, '', 'the input is cleared for the next pick');

        dropzone.dispatch('drop', { preventDefault() {}, dataTransfer: { files: [] } });
    } finally {
        shell?.dispose();
        console.warn = warn;
        console.error = error;
        globalThis.fetch = savedFetch;
        hideInitError();
        delete globalThis.__projectMSongLoaderInstalled;
        env.restore();
    }
});

test('core: dev extras: player launchers, the test-sender panel and the console helpers', async () => {
    await withShell({ profile: 'core', search: '?debugSender', bootOptions: { extrasDelayMs: 0 } }, async ({ env }) => {
        await tick(900);
        for (const id of ['modPlayerLaunchBtn', 'flacPlayerLaunchBtn', 'audioCaptureLaunchBtn', 'pm-test-sender-panel']) {
            assert.ok(env.document.getElementById(id), `#${id} was added`);
        }
        const opened = [];
        env.window.open = (url, name) => {
            opened.push([url, name]);
            return { closed: false, focus() { opened.push(['focus']); } };
        };
        env.document.getElementById('audioCaptureLaunchBtn').dispatch('click');
        env.window.openAudioCapture();
        assert.deepEqual(opened, [['https://projectm.test/audio-capture.html', 'projectm-audio-capture'], ['focus']], 'a second open focuses the popup');
        assert.equal(typeof env.window.startLocalProjectMTestSender, 'function');
        assert.equal(typeof env.window.feedPCMToModuleForDebug, 'function');
    });
});

test('the knob follows a drag, by mouse and by touch', async () => {
    await withShell({ profile: 'core' }, async ({ env }) => {
        const knob = env.document.getElementById('knob');
        const panel = env.document.getElementById('panel-container');
        knob.dispatch('mousedown', { clientX: 640, clientY: 0 });
        env.document.dispatch('mousemove', { clientX: 0, clientY: 180 });
        assert.match(knob.style.transform, /rotate\(-?\d/);
        assert.match(panel.style.filter, /hsla\(/);
        env.document.dispatch('mouseup');
        const after = knob.style.transform;
        env.document.dispatch('mousemove', { clientX: 640, clientY: 360 });
        assert.equal(knob.style.transform, after, 'no drag after mouseup');

        knob.dispatch('touchstart', { touches: [{ clientX: 320, clientY: 0 }] });
        env.document.dispatch('touchmove', { touches: [{ clientX: 640, clientY: 180 }] });
        assert.notEqual(knob.style.transform, after);
        env.document.dispatch('touchend');
    });
});

test('weeks-on-fire mode: Random draws from the scanned weeks list', async () => {
    await withShell({ profile: 'core', search: '?mode=weeks_on_fire' }, async ({ env, shell }) => {
        assert.match(env.document.title, /Weeks on Fire/);
        shell.actions.randomPreset(); // scanner not ready yet: a warning, nothing else
        let picks = 0;
        env.window.loadRandomWeeksPreset = () => { picks += 1; };
        shell.actions.randomPreset();
        shell.actions.randomCustom();
        assert.equal(picks, 2);
    });
});

test('panel2: the WASM picker reloads with ?wasm=, and the other shortcuts', async () => {
    const storage = fakeStorage();
    await withShell({ profile: 'panel2', storage }, async ({ env, shell }) => {
        const select = env.document.getElementById('wasmVersionSelect');
        const choice = select.children[0].value;
        select.value = choice;
        select.dispatch('change');
        assert.ok([...storage.map.values()].includes(choice), 'the choice is remembered');
        assert.equal(new URLSearchParams(env.window.location.search).get('wasm'), choice);

        let cycles = 0;
        shell.actions.cycleAudioPlayer = () => { cycles += 1; };
        env.document.dispatch('keydown', { key: 'a', preventDefault() {} });
        env.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
        env.document.dispatch('keydown', { key: ' ', preventDefault() {} });
        env.document.dispatch('keydown', { key: 'h', preventDefault() {} });
        assert.equal(cycles, 1);
        await tick(300);
        assert.equal(env.document.getElementById('panel-container').style.display, 'none', 'H hides the panel');
    });
});
