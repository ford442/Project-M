// Unit tests for html/projectm-legacy-globals.js — the one module allowed to
// publish `window.pm*` convenience globals — and for the gate that keeps it the
// only one (scripts/check_host_globals.sh). Run with:
//   node --test tests/web/projectm-legacy-globals.test.mjs
//
// Every installer takes the object to publish on, so these tests use plain
// objects as the "window" and never touch the real globalThis except where the
// point is the real BroadcastChannel patch.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    LEGACY_GLOBAL_NAMES,
    exposeAudioPlayerGlobals,
    exposeExperimentalGlobals,
    exposeFboFormatGlobals,
    exposeGovernorGlobals,
    exposeMeshQualityGlobals,
    exposePresetDevGlobals,
    installLegacyGlobals,
    patchBroadcastChannel,
} from '../../html/projectm-legacy-globals.js';
import { createSongChannel, wrapSongChannel } from '../../html/projectm-song-loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeGovernor() {
    return {
        setTargetFps: (fps) => fps,
        setQualityGovernorEnabled: (enabled) => enabled,
        getQualityTier: () => 1,
        getRenderScale: () => 0.75,
        getBlurCap: () => 2,
    };
}

function fakeAudioController({ popup = false } = {}) {
    /** @type {string[]} */
    const shown = [];
    const controller = {
        shown,
        showAudioPlayer: (id) => shown.push(id),
        cycleAudioPlayer: () => shown.push('cycle'),
        closeAudioPlayer: () => shown.push('close'),
    };
    if (popup) {
        controller.openFlacPlayer = (url) => shown.push(`open-flac:${url}`);
        controller.openModPlayer = (url) => shown.push(`open-mod:${url}`);
    }
    return controller;
}

// ---- convenience installers -------------------------------------------------

test('exposeGovernorGlobals publishes the five governor names, bound to the controller', () => {
    const host = {};
    const governor = fakeGovernor();
    exposeGovernorGlobals(governor, host);

    assert.deepEqual(Object.keys(host).sort(), [
        'pmGetGovernorBlurCap',
        'pmGetGovernorRenderScale',
        'pmGetQualityTier',
        'pmSetQualityGovernorEnabled',
        'pmSetTargetFps',
    ]);
    assert.equal(host.pmSetTargetFps(30), 30);
    assert.equal(host.pmGetGovernorRenderScale(), 0.75);
    assert.equal(host.pmGetGovernorBlurCap(), 2);
    assert.equal(host.pmGetQualityTier(), 1);
});

test('exposeMeshQualityGlobals and exposeFboFormatGlobals publish one name each', () => {
    const host = {};
    exposeMeshQualityGlobals({ setQuality: (q) => `set:${q}` }, host);
    exposeFboFormatGlobals(() => 'RGBA16F', host);

    assert.equal(host.pmSetMeshQuality('low'), 'set:low');
    assert.equal(host.pmGetFboFormat(), 'RGBA16F');
    assert.deepEqual(Object.keys(host).sort(), ['pmGetFboFormat', 'pmSetMeshQuality']);
});

test('preset-dev and experimental installers do nothing unless their tool is enabled', () => {
    const host = {};
    exposePresetDevGlobals({ enabled: false }, host);
    exposeExperimentalGlobals({ enabled: false }, host);
    exposeExperimentalGlobals({ enabled: true }, host); // enabled, but no api to publish
    assert.deepEqual(Object.keys(host), []);

    const reload = () => 'reloaded';
    const api = { state: {} };
    exposePresetDevGlobals({ enabled: true, reloadFromText: reload }, host);
    exposeExperimentalGlobals({ enabled: true, api }, host);
    assert.equal(host.pmReloadPresetText, reload);
    assert.equal(host.pmPresetDevEnabled, true);
    assert.equal(host.pmExperimental, api);
});

test('exposeAudioPlayerGlobals: the section controller has no open* names, the popup one does', () => {
    const section = {};
    const sectionController = fakeAudioController();
    exposeAudioPlayerGlobals(sectionController, section);
    assert.deepEqual(Object.keys(section).sort(), ['closeAudioPlayer', 'cycleAudioPlayer', 'flacPlayer', 'modPlayer']);

    section.flacPlayer();
    section.modPlayer();
    section.cycleAudioPlayer();
    section.closeAudioPlayer();
    assert.deepEqual(sectionController.shown, ['flac', 'mod', 'cycle', 'close']);

    const popup = {};
    const popupController = fakeAudioController({ popup: true });
    exposeAudioPlayerGlobals(popupController, popup);
    assert.equal(typeof popup.openFlacPlayer, 'function');
    assert.equal(typeof popup.openModPlayer, 'function');
    popup.openModPlayer('a.xm');
    assert.deepEqual(popupController.shown, ['open-mod:a.xm']);
});

test('every installer writes only names the shim declares', () => {
    const host = {};
    const disposers = [
        exposeGovernorGlobals(fakeGovernor(), host),
        exposeMeshQualityGlobals({ setQuality: () => 'low' }, host),
        exposeFboFormatGlobals(() => 'RGBA8', host),
        exposePresetDevGlobals({ enabled: true, reloadFromText: () => {} }, host),
        exposeExperimentalGlobals({ enabled: true, api: {} }, host),
        exposeAudioPlayerGlobals(fakeAudioController({ popup: true }), host),
    ];
    for (const key of Object.keys(host)) {
        assert.ok(LEGACY_GLOBAL_NAMES.includes(key), `${key} is written but not in LEGACY_GLOBAL_NAMES`);
    }
    for (const dispose of disposers) dispose();
    assert.deepEqual(Object.keys(host), [], 'disposing everything leaves the page as it was');
});

// ---- two installs, one page -------------------------------------------------

test('two installs do not clobber each other: the newest is visible, the older survives', () => {
    const host = {};
    const a = { ...fakeGovernor(), getRenderScale: () => 'A' };
    const b = { ...fakeGovernor(), getRenderScale: () => 'B' };

    const disposeA = exposeGovernorGlobals(a, host);
    const disposeB = exposeGovernorGlobals(b, host);
    assert.equal(host.pmGetGovernorRenderScale(), 'B');

    disposeA();
    assert.equal(host.pmGetGovernorRenderScale(), 'B', 'destroying A leaves B\'s controls in place');

    disposeB();
    assert.equal('pmGetGovernorRenderScale' in host, false);
});

test('disposing the newer install hands the names back to the older one', () => {
    const host = {};
    const a = { ...fakeGovernor(), getRenderScale: () => 'A' };
    const b = { ...fakeGovernor(), getRenderScale: () => 'B' };
    const disposeA = exposeGovernorGlobals(a, host);
    const disposeB = exposeGovernorGlobals(b, host);

    disposeB();
    assert.equal(host.pmGetGovernorRenderScale(), 'A');
    disposeA();
    assert.deepEqual(Object.keys(host), []);
});

test('a name the page set itself is neither overwritten nor removed by a dispose', () => {
    const host = { pmSetMeshQuality: 'page-owned' };
    const dispose = exposeMeshQualityGlobals({ setQuality: () => 'low' }, host);
    assert.equal(typeof host.pmSetMeshQuality, 'function');

    host.pmSetMeshQuality = 'page-replaced-it-again';
    dispose();
    assert.equal(host.pmSetMeshQuality, 'page-replaced-it-again');
});

// ---- the aggregate ----------------------------------------------------------

test('installLegacyGlobals installs only what it is given and one disposer removes it all', () => {
    const host = {};
    const before = Object.keys(host);

    installLegacyGlobals({ host })();
    assert.deepEqual(Object.keys(host), before, 'an empty call is a no-op');

    const dispose = installLegacyGlobals({
        host,
        governor: fakeGovernor(),
        meshQuality: { setQuality: () => 'low' },
        fboFormat: () => 'RGBA16F',
        audioPlayer: fakeAudioController(),
    });
    assert.ok('pmSetTargetFps' in host);
    assert.ok('pmSetMeshQuality' in host);
    assert.ok('pmGetFboFormat' in host);
    assert.ok('cycleAudioPlayer' in host);
    assert.equal('pmExperimental' in host, false, 'nothing was passed for it');
    for (const key of Object.keys(host)) {
        assert.ok(LEGACY_GLOBAL_NAMES.includes(key), `${key} is not a declared legacy name`);
    }

    dispose();
    assert.deepEqual(Object.keys(host), before, 'the global-write snapshot is back to where it started');
});

// ---- BroadcastChannel patch -------------------------------------------------

function fakeChannelClass() {
    /** @type {Array<{ channel: string, data: unknown }>} */
    const posts = [];
    class FakeBroadcastChannel {
        constructor(name) { this.name = name; }
        postMessage(data) { posts.push({ channel: this.name, data }); }
        addEventListener() {}
        close() {}
    }
    return { FakeBroadcastChannel, posts };
}

test('patchBroadcastChannel wraps every channel created and restores the real constructor', () => {
    const { FakeBroadcastChannel } = fakeChannelClass();
    const host = { BroadcastChannel: FakeBroadcastChannel };
    /** @type {string[]} */
    const wrapped = [];

    const restore = patchBroadcastChannel((name, channel) => { wrapped.push(name); return channel; }, host);
    assert.notEqual(host.BroadcastChannel, FakeBroadcastChannel);

    const channel = new host.BroadcastChannel('sng');
    assert.ok(channel instanceof FakeBroadcastChannel, 'the prototype chain is the real one');
    assert.equal(channel.name, 'sng');
    assert.deepEqual(wrapped, ['sng']);
    assert.equal(host.BroadcastChannel.projectMNativeBroadcastChannel, FakeBroadcastChannel);

    restore();
    assert.equal(host.BroadcastChannel, FakeBroadcastChannel, 'the platform constructor is back');
    restore(); // idempotent
    assert.equal(host.BroadcastChannel, FakeBroadcastChannel);
});

test('patchBroadcastChannel does not restore over a constructor someone else installed later', () => {
    const { FakeBroadcastChannel } = fakeChannelClass();
    const host = { BroadcastChannel: FakeBroadcastChannel };
    const restore = patchBroadcastChannel((_name, channel) => channel, host);

    class LaterPatch {}
    host.BroadcastChannel = LaterPatch;
    restore();
    assert.equal(host.BroadcastChannel, LaterPatch);
});

test('a second patch replaces the first instead of stacking on it, and the first returns when it leaves', () => {
    const { FakeBroadcastChannel } = fakeChannelClass();
    const host = { BroadcastChannel: FakeBroadcastChannel };
    /** @type {string[]} */
    const wrappedBy = [];
    const wrapA = (_name, channel) => { wrappedBy.push('A'); return channel; };
    const wrapB = (_name, channel) => { wrappedBy.push('B'); return channel; };

    const restoreA = patchBroadcastChannel(wrapA, host);
    const restoreB = patchBroadcastChannel(wrapB, host);

    // Both patches look through to the real constructor, so a channel is wrapped
    // by exactly one of them -- never by the same adapter twice (which would
    // route every song post twice).
    new host.BroadcastChannel('x');
    assert.deepEqual(wrappedBy, ['B']);

    restoreB();
    new host.BroadcastChannel('x');
    assert.deepEqual(wrappedBy, ['B', 'A'], 'disposing the newer patch brings the older one back');

    restoreA();
    assert.equal(host.BroadcastChannel, FakeBroadcastChannel);
});

test('patchBroadcastChannel is a no-op where there is no BroadcastChannel', () => {
    const host = {};
    const restore = patchBroadcastChannel((_name, channel) => channel, host);
    assert.deepEqual(Object.keys(host), []);
    restore();
});

test('the song loader\'s adapter and the shim\'s patch agree on the real constructor', async () => {
    const { FakeBroadcastChannel } = fakeChannelClass();
    const previous = globalThis.BroadcastChannel;
    const previousFetch = globalThis.fetch;
    const previousAudio = globalThis.projectMAudioContext_Global_Cpp;
    const previousNode = globalThis.projectMWorkletNode_Global_Cpp;

    let fetches = 0;
    globalThis.BroadcastChannel = FakeBroadcastChannel;
    globalThis.fetch = async () => {
        fetches += 1;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    globalThis.projectMAudioContext_Global_Cpp = {
        state: 'running',
        decodeAudioData: async () => ({
            duration: 1, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(8),
        }),
    };
    globalThis.projectMWorkletNode_Global_Cpp = { port: { postMessage() {} } };
    delete globalThis.projectMSongLoadState;

    const restore = patchBroadcastChannel(wrapSongChannel);
    try {
        // Code that just says `new BroadcastChannel('sng')` is intercepted...
        new globalThis.BroadcastChannel('sng').postMessage({ data: 'https://example.com/a.mp3' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(fetches, 1, 'the patched global routes a song post through the loader');

        // ...and asking the adapter explicitly while the patch is installed must
        // not stack a second wrapper on top (the loader looks through the patch
        // to the real constructor via the shared tag).
        delete globalThis.projectMSongLoadState;
        const channel = createSongChannel('sng');
        assert.ok(channel instanceof FakeBroadcastChannel);
        channel.postMessage({ data: 'https://example.com/b.mp3' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(fetches, 2, 'one post, one route: not routed twice');
    } finally {
        restore();
        assert.equal(globalThis.BroadcastChannel, FakeBroadcastChannel);
        globalThis.BroadcastChannel = previous;
        globalThis.fetch = previousFetch;
        if (previousAudio) globalThis.projectMAudioContext_Global_Cpp = previousAudio;
        else delete globalThis.projectMAudioContext_Global_Cpp;
        if (previousNode) globalThis.projectMWorkletNode_Global_Cpp = previousNode;
        else delete globalThis.projectMWorkletNode_Global_Cpp;
        delete globalThis.projectMSongLoadState;
    }
});

// ---- the gate ---------------------------------------------------------------

const gateScript = join(repoRoot, 'scripts', 'check_host_globals.sh');

/**
 * Runs the gate against a scratch tree so its behaviour is pinned independent of
 * what the real html/ happens to contain.
 *
 * @param {Record<string, string>} files Path (relative to the tree) -> contents.
 */
function runGateOn(files) {
    const root = mkdtempSync(join(tmpdir(), 'pm-host-globals-'));
    try {
        mkdirSync(join(root, 'scripts'), { recursive: true });
        mkdirSync(join(root, 'html'), { recursive: true });
        copyFileSync(gateScript, join(root, 'scripts', 'check_host_globals.sh'));
        for (const [path, contents] of Object.entries(files)) {
            writeFileSync(join(root, path), contents);
        }
        const result = spawnSync('bash', [join(root, 'scripts', 'check_host_globals.sh')], { encoding: 'utf8' });
        return { status: result.status, out: `${result.stdout}${result.stderr}` };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('the gate passes reads, comparisons, comments and variable-named claims', () => {
    const { status, out } = runGateOn({
        'html/projectm-ok.js': [
            '// window.pmCommentedOut = 1;',
            ' * globalThis.pmDocExample = () => {};',
            'if (window.pmFoo === 1) {}',
            'const fmt = window.pmGetFboFormat();',
            'const off = subscribeWasmCallback("pmOnPerfFrame", listener);',
            'claimGlobal(host, name, dispatch);',
        ].join('\n'),
    });
    assert.equal(status, 0, out);
});

test('the gate fails each kind of page-global write and names the file', () => {
    /** @type {Array<[string, string]>} */
    const violations = [
        ['window.pm* assignment', 'window.pmLeaked = () => 1;'],
        ['globalThis.pm* assignment', 'globalThis.pmLeaked = () => 1;'],
        ['windowRef.pm* assignment', 'this.options.windowRef.pmOnGovernorRenderScaleChange = null;'],
        ['self.pm* assignment', 'self.pmLeaked = 1;'],
        ['bracket-form pm* assignment', "window['pmLeaked'] = 1;"],
        ['defineProperty of a pm* name', "Object.defineProperty(window, 'pmLeaked', { value: 1 });"],
        ['legacy popup-player global', 'window.cycleAudioPlayer = () => {};'],
        ['BroadcastChannel monkey-patch', 'globalThis.BroadcastChannel = class {};'],
        ['claimGlobal with a literal pm* name', "claimGlobal(window, 'pmLeaked', 1);"],
    ];
    for (const [label, line] of violations) {
        const { status, out } = runGateOn({ 'html/projectm-leaky.js': `${line}\n` });
        assert.equal(status, 1, `${label} should fail the gate`);
        assert.match(out, /projectm-leaky\.js/, `${label}: the failure should name the file`);
    }
});

test('the gate covers first-party host pages, not just the modules', () => {
    const { status, out } = runGateOn({
        'html/host.html': '<script type="module">window.pmSetTargetFps = () => 1;</script>\n',
    });
    assert.equal(status, 1);
    assert.match(out, /host\.html/);
});

test('the shim, the callback bus and the worker scope may write page globals', () => {
    const write = 'window.pmAllowed = 1;\nglobalThis.BroadcastChannel = class {};\n';
    const { status, out } = runGateOn({
        'html/projectm-legacy-globals.js': write,
        'html/projectm-wasm-callbacks.js': write,
        'html/projectm-globals.js': write,
        'html/projectm-render-worker.js': 'self.pmOnGovernorRenderScaleChange = () => {};\n',
    });
    assert.equal(status, 0, out);
});

test('the repository passes its own gate', () => {
    const result = spawnSync('bash', [gateScript], { encoding: 'utf8', cwd: repoRoot });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
