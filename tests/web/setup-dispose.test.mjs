// Every setup*() export in html/ returns something with dispose(), and dispose()
// leaves the page as it found it: no listener still attached, no element still in
// the document, no timer still running.
//
// Why a table rather than a test per module: the failure this guards against is a
// *new* setup*() that builds a panel and returns nothing to take it down (which is
// how the preset picker, the tweaker, the audio test panel and the experimental
// bridge's panel all ended up). The first test reads the exports out of the
// sources, so a setup*() with no entry here fails until someone writes one.
//
// Run with: node --test tests/web/setup-dispose.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { trackListeners } from './helpers/listener-ledger.mjs';

const HTML_DIR = fileURLToPath(new URL('../../html/', import.meta.url));

/** `setup*` names exported by an html/ module, read from its source. */
function setupExportsIn(file) {
    const source = readFileSync(`${HTML_DIR}${file}`, 'utf8');
    return [...source.matchAll(/^export (?:async )?function (setup[A-Z]\w*)/gm)].map((m) => m[1]);
}

/** A fake Module: every `_symbol` is a no-op returning `answer(name)`, ccall likewise. */
function fakeModule(answer = () => 0) {
    return new Proxy({
        ccall: (name) => answer(name),
        HEAPF32: new Float32Array(16),
        FS: { writeFile() {}, mkdir() {}, readFile: () => new Uint8Array() },
    }, {
        get(target, property) {
            if (property in target) return target[property];
            if (typeof property === 'string' && property.startsWith('_')) return () => answer(property.slice(1));
            return undefined;
        },
    });
}

/** A main-thread transport shaped like createModuleTransport()'s. */
function fakeTransport() {
    return {
        topology: 'main',
        module: fakeModule(),
        host: 0,
        workerHandle: null,
        supports: () => false,
        call: async () => 0,
        callVoid() {},
        feedPcm() {},
        writePreset() {},
        resize() {},
        setFlashLimit() {},
        captureFrame: async () => ({ width: 0, height: 0, data: new Uint8ClampedArray(), frameIndex: 0 }),
        onContextEvent: () => () => {},
        onPerfFrame: () => () => {},
        onPerfHudEnabled: () => () => {},
        onRhythmEvent: () => () => {},
        contextSnapshot: () => null,
        recoverContext: async () => 0,
        destroy() {},
    };
}

/** An EventTarget-shaped object that keeps its listeners, for window and the AudioContext. */
function fakeEventTarget(extra = {}) {
    const listeners = new Map();
    return {
        ...extra,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    };
}

/**
 * How to call each setup*(), and what it may legitimately leave behind.
 *
 * `leavesDom` names an element the setup shares with the rest of the page and
 * therefore does not own; anything else still in the document after dispose() fails.
 *
 * @type {Record<string, { module: string, call: (env: any) => any | Promise<any>, leavesDom?: string[] }>}
 */
const SETUPS = {
    setupShellUi: {
        module: 'projectm-app-shell-ui.js',
        call: async (env) => {
            const { setupShellUi } = await import('../../html/projectm-app-shell-ui.js');
            const ui = setupShellUi(env.document, { windowRef: env.window, actions: {}, keyboard: true, chromeIds: ['logo-left'] });
            // The optional extras add elements of their own; dispose() must take them down too.
            ui.addLaunchers([{ id: 'pm-test-launcher', label: 'X', title: 'x', open() {} }]);
            ui.addTestSenderPanel({ start() {}, stop() {} });
            ui.showStatus('hello', 'warn', 1000);
            return ui;
        },
    },
    setupAudioUnlock: {
        module: 'projectm-audio-bootstrap.js',
        call: async () => {
            globalThis.projectMAudioContext_Global_Cpp = fakeEventTarget({ state: 'suspended', resume: async () => {} });
            const { setupAudioUnlock } = await import('../../html/projectm-audio-bootstrap.js');
            return setupAudioUnlock();
        },
        // The "tap to enable audio" overlay is the page's; ensureAudioRunning() hides it.
        leavesDom: ['pm-audio-unlock', 'pm-audio-unlock-style'],
    },
    setupContextLossRecovery: {
        module: 'projectm-context-loss.js',
        call: async (env) => {
            const { setupContextLossRecovery } = await import('../../html/projectm-context-loss.js');
            const canvas = env.document.createElement('canvas');
            return setupContextLossRecovery(fakeTransport(), { canvas, documentRef: env.document, windowRef: env.window });
        },
    },
    setupExperimentalBridge: {
        module: 'projectm-experimental-bridge.js',
        call: async () => {
            globalThis.MutationObserver = class { observe() {} disconnect() {} };
            const { setupExperimentalBridge } = await import('../../html/projectm-experimental-bridge.js');
            return setupExperimentalBridge(fakeModule(), { params: new URLSearchParams('experimental=1') });
        },
    },
    setupExternalAudioReceiver: {
        module: 'projectm-external-pcm.js',
        call: async () => {
            const { setupExternalAudioReceiver } = await import('../../html/projectm-external-pcm.js');
            return setupExternalAudioReceiver({ allowedOrigins: [] });
        },
    },
    setupFboFormatIndicator: {
        module: 'projectm-fbo-format.js',
        call: async () => {
            const { setupFboFormatIndicator } = await import('../../html/projectm-fbo-format.js');
            // Format 2 (RGBA8) is the one that shows the banner.
            return setupFboFormatIndicator(fakeModule((name) => (name === 'dual_fbo_get_format' ? 2 : 0)));
        },
    },
    setupFpsGovernor: {
        module: 'projectm-fps-governor.js',
        call: async () => {
            const { setupFpsGovernor } = await import('../../html/projectm-fps-governor.js');
            return setupFpsGovernor(fakeModule(), { params: new URLSearchParams() });
        },
    },
    setupInitErrorHandling: {
        module: 'projectm-init-errors.js',
        call: async () => {
            const { setupInitErrorHandling } = await import('../../html/projectm-init-errors.js');
            return setupInitErrorHandling(() => {});
        },
        // The init-error overlay is the page's: checkCrossOriginIsolation() and
        // showInitError() draw into the same element, with or without a handler.
        leavesDom: ['pm-init-error', 'pm-init-error-style'],
    },
    setupMeshQuality: {
        module: 'projectm-mesh-quality.js',
        call: async () => {
            const { setupMeshQuality } = await import('../../html/projectm-mesh-quality.js');
            return setupMeshQuality(fakeModule(), { params: new URLSearchParams() });
        },
    },
    setupPcmHud: {
        module: 'projectm-pcm-hud.js',
        call: async (env) => {
            const { setupPcmHud } = await import('../../html/projectm-pcm-hud.js');
            return setupPcmHud({ transport: fakeTransport(), windowRef: env.window, documentRef: env.document, visible: true });
        },
    },
    setupPerfTools: {
        module: 'projectm-perf.js',
        call: async () => {
            const { setupPerfTools } = await import('../../html/projectm-perf.js');
            return setupPerfTools(fakeModule());
        },
    },
    setupTransportPerfTools: {
        module: 'projectm-perf.js',
        call: async () => {
            const { setupTransportPerfTools } = await import('../../html/projectm-perf.js');
            return setupTransportPerfTools(fakeTransport());
        },
    },
    setupPresetDevTools: {
        module: 'projectm-preset-dev.js',
        call: async () => {
            const { setupPresetDevTools } = await import('../../html/projectm-preset-dev.js');
            return setupPresetDevTools(fakeModule(), { params: new URLSearchParams('devPreset=1') });
        },
    },
    setupPresetPicker: {
        module: 'projectm-preset-picker.js',
        call: async (env) => {
            globalThis.fetch = async () => ({ ok: true, json: async () => ({ presets: [] }) });
            const { setupPresetPicker } = await import('../../html/projectm-preset-picker.js');
            const picker = setupPresetPicker({ documentRef: env.document, preloadFeatured: false });
            await picker.ready;
            return picker;
        },
    },
    setupPresetTweaker: {
        module: 'projectm-preset-tweaker.js',
        call: async (env) => {
            const { setupPresetTweaker } = await import('../../html/projectm-preset-tweaker.js');
            // Built inside the dev panel when there is one.
            const devPanel = env.document.createElement('div');
            devPanel.id = 'pm-preset-dev-panel';
            env.document.body.appendChild(devPanel);
            env.baseline.add(devPanel);
            return setupPresetTweaker({ onApply: () => {}, documentRef: env.document });
        },
    },
    setupAudioTestPanel: {
        module: 'projectm-synthetic-audio.js',
        call: async (env) => {
            const { setupAudioTestPanel } = await import('../../html/projectm-synthetic-audio.js');
            return setupAudioTestPanel(fakeModule(), { documentRef: env.document, search: '?audioTest=1' });
        },
    },
    setupRenderWorker: {
        module: 'projectm-render-worker-host.js',
        call: async (env) => {
            globalThis.Worker = class {
                constructor() { this.terminated = false; env.worker = this; }
                postMessage(message) {
                    // A live worker answers shutdown; terminate follows.
                    if (message?.type === 'shutdown') queueMicrotask(() => this.onmessage?.({ data: { type: 'shutdown-complete' } }));
                }
                terminate() { this.terminated = true; }
            };
            globalThis.OffscreenCanvas = class { getContext() { return {}; } };
            const { setupRenderWorker } = await import('../../html/projectm-render-worker-host.js');
            return setupRenderWorker({ canvas: { transferControlToOffscreen: () => ({}) }, scriptSrc: 'https://cdn.test/pm.js' });
        },
        after: async (env) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            assert.equal(env.worker.terminated, true, 'dispose() ends with the worker terminated');
        },
    },
    setupShaderTranspileCacheHooks: {
        module: 'projectm-shader-cache.js',
        call: async () => {
            const { setupShaderTranspileCacheHooks } = await import('../../html/projectm-shader-cache.js');
            return setupShaderTranspileCacheHooks();
        },
    },
    setupWorkerFboFormatIndicator: {
        module: 'projectm-fbo-format.js',
        call: async () => {
            const { setupWorkerFboFormatIndicator } = await import('../../html/projectm-fbo-format.js');
            // Reports RGBA8 from the first stats: the banner goes up.
            return setupWorkerFboFormatIndicator({ getLastStats: () => ({ type: 'stats', fboFormat: 2 }), onStats: () => () => {} });
        },
    },
};

/** Every element under `root` (the fake DOM keeps a plain child list). */
function* descendants(root) {
    for (const child of root.children ?? []) {
        yield child;
        yield* descendants(child);
    }
}

test('every setup*() export in html/ has an entry here', () => {
    const exported = readdirSync(HTML_DIR)
        .filter((file) => file.startsWith('projectm-') && file.endsWith('.js'))
        .flatMap((file) => setupExportsIn(file).map((name) => ({ name, file })));
    assert.ok(exported.length >= 15, 'the scan found the setup exports');

    for (const { name, file } of exported) {
        assert.ok(SETUPS[name], `${file} exports ${name}() with no entry in tests/web/setup-dispose.test.mjs`);
        assert.equal(SETUPS[name].module, file, `${name} moved to ${file}`);
    }
    for (const name of Object.keys(SETUPS)) {
        assert.ok(exported.some((entry) => entry.name === name), `${name} is no longer exported; drop its entry`);
    }
});

for (const [name, entry] of Object.entries(SETUPS)) {
    test(`${name}() returns dispose(), and dispose() leaves no listener, element or timer behind`, async () => {
        const dom = installFakeDom({ search: '' });
        const elementLedger = trackListeners(FakeElement.prototype, 'fake elements');
        const windowRef = Object.assign(dom.window, fakeEventTarget());
        const windowLedger = trackListeners(windowRef, 'window');
        if (typeof dom.document.addEventListener !== 'function') Object.assign(dom.document, fakeEventTarget());
        const documentLedger = trackListeners(dom.document, 'document');
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
        const saved = ['fetch', 'MutationObserver', 'Worker', 'OffscreenCanvas', 'projectMAudioContext_Global_Cpp']
            .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
        const env = { document: dom.document, window: windowRef, baseline: new Set() };
        for (const node of [...descendants(dom.document.head), ...descendants(dom.document.body)]) env.baseline.add(node);

        let result;
        try {
            result = await entry.call(env);
            assert.ok(result, `${name}() returned nothing`);
            assert.equal(typeof result.dispose, 'function', `${name}() returned no dispose()`);

            result.dispose();
            assert.doesNotThrow(() => result.dispose(), 'dispose() is idempotent');
            await entry.after?.(env);

            assert.deepEqual(elementLedger.outstanding(), {}, `${name}: listeners still on its elements`);
            assert.deepEqual(windowLedger.outstanding(), {}, `${name}: listeners still on window`);
            assert.deepEqual(documentLedger.outstanding(), {}, `${name}: listeners still on document`);
            assert.equal(timers.size, 0, `${name}: an interval is still running`);
            const allowed = new Set(entry.leavesDom ?? []);
            const leftovers = [...descendants(dom.document.head), ...descendants(dom.document.body)]
                .filter((node) => !env.baseline.has(node) && !allowed.has(node.id))
                .map((node) => node.id || node.tagName);
            assert.deepEqual(leftovers, [], `${name}: elements still in the document`);
        } finally {
            result?.dispose?.();
            for (const id of timers) realClearInterval(id);
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
            elementLedger.restore();
            windowLedger.restore();
            documentLedger.restore();
            for (const [key, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
            dom.restore();
        }
    });
}
