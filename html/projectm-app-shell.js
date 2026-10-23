// projectm-app-shell.js
//
// The first-party page shell: what projectm-core.html and projectm_panel2.1ink
// do once their markup is up. Each page's whole script is
//
//   <script type="module">
//   import { boot } from './projectm-app-shell.js';
//   boot(document);
//   </script>
//
// with `<body data-pm-shell="core|panel2">` choosing a profile. The profiles
// are the two pages' real differences (which audio-player UI, which preset API
// policy, the bezel, the WASM version picker, the dev extras), not two copies
// of the same code: the knob, the layout, lock, the preset actions, the engine
// lifecycle and the init-error retry are one implementation.
//
// These used to be ~1,600 lines of inline script that neither tsc nor any test
// saw. Here they are checked by html/tsconfig.json and booted against a fake
// page by tests/web/projectm-app-shell.test.mjs.
//
// Ownership: boot() returns `{ dispose }`. Everything the page wires up before
// the engine exists hangs off the shell; everything that needs the engine is
// handed to ProjectMContext#own(), so it goes when the context does.

import { createPopupAudioPlayerController, createSectionAudioPlayerController } from './projectm-audio-player.js';
import { ensureAudioRunning } from './projectm-audio-bootstrap.js';
import { createAudioSourceRouter } from './projectm-audio-source-router.js';
import { setupShellUi } from './projectm-app-shell-ui.js';
import { createBezel } from './projectm-bezel.js';
import { ProjectMContext } from './projectm-context.js';
import { createDisposables } from './projectm-disposables.js';
import { setupExperimentalBridge } from './projectm-experimental-bridge.js';
import {
    defaultFeedPCMToModule,
    feedPCMToModule,
    flushQueuedExternalPCM,
    setupExternalAudioReceiver,
} from './projectm-external-pcm.js';
import { setupFboFormatIndicator, setupWorkerFboFormatIndicator } from './projectm-fbo-format.js';
import { setupFpsGovernor } from './projectm-fps-governor.js';
import { claimGlobal } from './projectm-globals.js';
import {
    buildWasmBundlePaths,
    PROJECTM_WASM_VERSION_STORAGE_KEY,
    resolveSelectedWasmVersion,
} from './projectm-init.js';
import { checkCrossOriginIsolation, setupInitErrorHandling } from './projectm-init-errors.js';
import {
    exposeAudioPlayerGlobals,
    exposeExperimentalGlobals,
    exposeFboFormatGlobals,
    exposeGovernorGlobals,
    exposeMeshQualityGlobals,
    exposePresetDevGlobals,
    patchBroadcastChannel,
} from './projectm-legacy-globals.js';
import { setupMeshQuality } from './projectm-mesh-quality.js';
import { createPcmTestSender } from './projectm-pcm-test-sender.js';
import { installHostPcmRingWriter } from './projectm-pcm-ring.js';
import { setupPerfTools, setupTransportPerfTools } from './projectm-perf.js';
import { setupPresetDevTools } from './projectm-preset-dev.js';
import { setupPresetPicker } from './projectm-preset-picker.js';
import {
    getConfiguredPresetApiBase,
    LOCAL_PRESET_LAST_NAME_KEY,
    loadLocalPresetFile,
    loadRandomApiPreset,
    loadStartupApiPresets,
    updatePresetDisplay,
} from './projectm-presets.js';
import { setupAudioTestPanel } from './projectm-synthetic-audio.js';
import { startTransitionWhenReady } from './projectm-transitions.js';
import { loadWasmBuildsManifest } from './projectm-wasm-manifest.js';
import { getSelectableWasmVersions } from './projectm-wasm-version.js';
import { ensureWorkletReady } from './projectm-worklet-playback.js';
import { applyWeeksOnFireDomConfig, isWeeksOnFireMode, wireFlacDecoderBridge } from './projectm-weeks-on-fire.js';
import { addPresetFile, loadPresetFile } from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-app-shell-ui.js').ShellUi} ShellUi
 *
 * @typedef {object} ShellProfile
 * @property {string} name
 * @property {string} log Console prefix.
 * @property {string} weeksTitle document.title in weeks-on-fire mode.
 * @property {'popup' | 'section'} audioPlayer Popup windows (core) or in-page iframes (panel2).
 * @property {boolean} requirePresetDir Whether the preset API's `dir` must be present.
 * @property {boolean} persistLock Remember the lock in localStorage.
 * @property {boolean} transparency The glass-layer toggle.
 * @property {boolean} presetPicker The named preset library (right-click Random Custom).
 * @property {boolean} autoSwitch Fetch a new preset on a timer (?presetDuration=).
 * @property {boolean} urlContextConfig ?aa / ?capture / ?fboPrecision / ?depth and the
 *   render-worker governor / mesh / rhythm settings.
 * @property {boolean} audioRouter One exclusive router for external PCM and the worklet.
 * @property {boolean} devTools Mesh quality, governor, FBO banner, perf HUD, preset dev,
 *   experimental bridge, audio test panel, local presets, test sender, launchers.
 * @property {boolean} bezel The B3HD frame + iris (projectm-bezel.js).
 * @property {boolean} wasmPicker The WASM build <select> and ?wasm= selection.
 * @property {boolean} keyboard Space / L / H / A / Escape.
 * @property {string[]} chromeIds Faded with the panel.
 *
 * @typedef {object} BootOptions
 * @property {string} [profile] Overrides `<body data-pm-shell>`.
 * @property {Window & typeof globalThis} [windowRef]
 * @property {number} [initDelayMs] When the first init attempt runs (750 ms: after first paint).
 * @property {number} [extrasDelayMs] When the dev extras (player launchers, test-sender
 *   panel) are added: 1200 ms, after the rest of the UI has painted.
 * @property {Partial<ProjectMContextOptions>} [contextOptions] Merged over what the
 *   shell builds; tests pass a `sharedModule` here.
 * @property {string} [baseUrl] Where the WASM bundle and pm/builds.json are resolved
 *   from. Defaults to this module's URL (the deploy is flat).
 *
 * @typedef {object} AppShell
 * @property {ShellProfile} profile
 * @property {Record<string, () => void>} actions
 * @property {() => ProjectMContext | null} context
 * @property {() => Promise<void>} init Runs (or re-runs, after a failure) the init attempt.
 * @property {Promise<void>} ready Settles after the first init attempt.
 * @property {() => void} dispose
 */

const TRANSPARENCY_THRESHOLD = 0.01;
const LOCK_STORAGE_KEY = 'projectm:presetLocked';
const TRANSPARENCY_STORAGE_KEY = 'projectm:transparencyMode';

/** @type {Readonly<Record<string, ShellProfile>>} */
export const SHELL_PROFILES = Object.freeze({
    core: {
        name: 'core',
        log: '[ProjectM]',
        weeksTitle: 'Project M — Weeks on Fire',
        audioPlayer: 'popup',
        requirePresetDir: true,
        persistLock: true,
        transparency: true,
        presetPicker: true,
        autoSwitch: true,
        urlContextConfig: true,
        audioRouter: true,
        devTools: true,
        bezel: false,
        wasmPicker: false,
        keyboard: false,
        chromeIds: [],
    },
    panel2: {
        name: 'panel2',
        log: '[B3HD]',
        weeksTitle: 'B3HD • Project M — Weeks on Fire',
        audioPlayer: 'section',
        requirePresetDir: false,
        persistLock: false,
        transparency: false,
        presetPicker: false,
        autoSwitch: false,
        urlContextConfig: false,
        audioRouter: false,
        devTools: false,
        bezel: true,
        wasmPicker: true,
        keyboard: true,
        chromeIds: ['logo-left', 'logo-right', 'preset-name', 'audio-player-status', 'wasm-bundle-picker'],
    },
});

/**
 * @param {Document} documentRef
 * @param {string} [requested]
 * @returns {ShellProfile}
 */
export function resolveShellProfile(documentRef, requested) {
    const name = requested ?? documentRef.body?.dataset?.pmShell ?? 'core';
    const profile = SHELL_PROFILES[name];
    if (!profile) {
        console.warn(`[projectM] unknown shell profile "${name}"; using core`);
        return SHELL_PROFILES.core;
    }
    return profile;
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @returns {string | null}
 */
function readStorage(storage, key) {
    try {
        return storage ? storage.getItem(key) : null;
    } catch {
        return null; // blocked (private mode, sandboxed iframe)
    }
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @param {string} value
 */
function writeStorage(storage, key, value) {
    try {
        storage?.setItem(key, value);
    } catch {
        // blocked
    }
}

/**
 * WebGL context attributes, parsed here in the host layer and forwarded to the
 * WASM host as ProjectMContext options (#128, docs/EMSCRIPTEN.md "WebGL context
 * attributes"): `?aa=1` or localStorage.canvasAA opt into MSAA; `?capture=1`
 * (or window.__projectMCaptureMode) keeps a readable back-buffer;
 * `?fboPrecision=high|byte` picks the dual-FBO format; `?depth=1` restores a
 * canvas depth+stencil attachment (off by default, #246).
 *
 * @param {URLSearchParams} params
 * @param {Storage | null} storage
 * @param {Window} windowRef
 * @returns {Partial<ProjectMContextOptions>}
 */
export function resolveContextAttributes(params, storage, windowRef) {
    const aa = params.get('aa');
    const antialias =
        aa === '1' || aa === 'true'
            ? true
            : aa === '0' || aa === 'false'
              ? false
              : ['1', 'true'].includes(readStorage(storage, 'canvasAA') ?? '');
    const capture =
        /** @type {{ __projectMCaptureMode?: boolean }} */ (windowRef).__projectMCaptureMode === true ||
        params.get('capture') === '1' ||
        params.get('capture') === 'true';
    const precision = (params.get('fboPrecision') || '').toLowerCase();
    const depth = params.get('depth') === '1' || params.get('depth') === 'true';
    return {
        antialias,
        preserveDrawingBuffer: capture,
        fboPrecision: precision === 'high' || precision === 'byte' ? precision : 'half',
        depth,
        stencil: depth,
    };
}

/**
 * The ?targetFps= / ?governor= / ?meshQuality= (and localStorage) overrides
 * projectm-fps-governor.js and projectm-mesh-quality.js read, plus the musical
 * scheduling ones (projectM-4/rhythm.h): ?switchOn=bars|section, ?switchBars=,
 * ?transitionBeats=, ?bpm=. The render worker has no `location`/localStorage of
 * its own, so they are resolved here and handed to ProjectMContext.
 *
 * @param {URLSearchParams} params
 * @param {Storage | null} storage
 * @param {number} [hardwareConcurrency]
 */
export function resolveRenderConfig(params, storage, hardwareConcurrency = 1) {
    const fps = parseInt(params.get('targetFps') || readStorage(storage, 'targetFps') || '', 10);
    const governorRaw = params.get('governor') ?? readStorage(storage, 'qualityGovernor');
    let meshQuality = params.get('meshQuality') || readStorage(storage, 'meshQuality') || 'auto';
    if (meshQuality !== 'low' && meshQuality !== 'high') {
        meshQuality = hardwareConcurrency < 4 ? 'low' : 'high';
    }
    const switchOn = params.get('switchOn');
    const bars = parseInt(params.get('switchBars') || '', 10);
    const beats = parseFloat(params.get('transitionBeats') || '');
    const bpm = parseFloat(params.get('bpm') || '');
    return {
        targetFps: Number.isFinite(fps) && fps > 0 ? fps : 60,
        qualityGovernor: !(governorRaw === '0' || governorRaw === 'false'),
        meshQuality: /** @type {'low' | 'high'} */ (meshQuality),
        presetSwitchPolicy: /** @type {'timer' | 'bars' | 'section'} */ (
            switchOn === 'bars' || switchOn === 'section' ? switchOn : 'timer'
        ),
        presetSwitchBars: Number.isFinite(bars) && bars > 0 ? bars : 16,
        transitionBeats: Number.isFinite(beats) && beats > 0 ? beats : 0,
        rhythmHint: Number.isFinite(bpm) && bpm > 0 ? bpm : 0,
        rhythmDebug: params.get('rhythmDebug') === '1',
    };
}

/**
 * The engine timer only calls play_next() on the worker playlist, and a
 * playlist of one makes that a no-op, so the shell fetches a new preset on its
 * own timer. ?presetDuration= seconds (>= 5), default 40 (the engine's own
 * window is 27–57).
 *
 * @param {URLSearchParams} params
 * @returns {number} milliseconds
 */
export function resolvePresetAutoSwitchMs(params) {
    const seconds = Number(params.get('presetDuration'));
    return (Number.isFinite(seconds) && seconds >= 5 ? seconds : 40) * 1000;
}

/**
 * @param {Document} documentRef
 * @param {BootOptions} [options]
 * @returns {AppShell}
 */
export function boot(documentRef, options = {}) {
    const windowRef =
        options.windowRef ?? /** @type {Window & typeof globalThis} */ (documentRef.defaultView ?? window);
    const profile = resolveShellProfile(documentRef, options.profile);
    const log = profile.log;
    const owned = createDisposables({ label: `projectM shell ${profile.name}` });
    const params = new URLSearchParams(windowRef.location?.search ?? '');
    /** @type {Storage | null} */
    let storage = null;
    try {
        storage = windowRef.localStorage ?? null;
    } catch {
        storage = null;
    }
    const baseUrl = options.baseUrl ?? import.meta.url;
    const weeksOnFire = isWeeksOnFireMode(params);
    const extrasDelayMs = options.extrasDelayMs ?? 1200;

    const state = {
        bezel: true,
        locked: profile.persistLock && readStorage(storage, LOCK_STORAGE_KEY) === '1',
        transparent:
            profile.transparency &&
            (params.get('transparent') === '1' ||
                params.get('transparent') === 'true' ||
                readStorage(storage, TRANSPARENCY_STORAGE_KEY) === '1'),
        startupPresetsLoaded: false,
    };
    /** @type {ProjectMContext | null} */
    let pmContext = null;
    /** @type {Promise<void> | null} */
    let initInFlight = null;

    const getModule = () => /** @type {ProjectMModule | undefined} */ (pmContext?.module ?? undefined);

    // ---- the song loader: optional (a soft-404 HTML page fails the MIME check)
    import('./projectm-song-loader.js')
        .then((mod) => {
            if (owned.disposed) return;
            mod.installSongLoaderInterceptor();
            // The WASM glue posts its song URL on `new BroadcastChannel('sng')`
            // itself, so intercepting it means wrapping the global constructor:
            // an explicit, reversible opt-in (projectm-legacy-globals.js).
            owned.add(patchBroadcastChannel(mod.wrapSongChannel));
        })
        .catch((error) => {
            console.warn(`${log} song loader unavailable; Start/Change Song uses /flac/`, error);
        });

    wireFlacDecoderBridge(documentRef);
    if (weeksOnFire) {
        applyWeeksOnFireDomConfig(documentRef);
        documentRef.title = profile.weeksTitle;
    }

    // ---- WASM build selection (panel2): ?wasm= / localStorage / pm/builds.json
    const wasmManifestReady = profile.wasmPicker ? loadWasmBuildsManifest({ baseUrl }) : Promise.resolve(null);
    let selectedWasmVersion = profile.wasmPicker ? resolveSelectedWasmVersion({ searchParams: params }) : undefined;

    // ---- audio
    const audioRouter = profile.audioRouter
        ? createAudioSourceRouter({
              autoSwitchOnFeed: true,
              onStatusChange: (status) => console.debug(`${log} audio source:`, status.activeSource),
          })
        : null;
    if (audioRouter) owned.add(() => audioRouter.destroy());
    owned.add(
        setupExternalAudioReceiver(
            audioRouter
                ? {
                      preallocSize: 2048,
                      feedGate: () => audioRouter.externalFeedGate(),
                      // ProjectMContext registers its transport with the external-PCM
                      // module at start(), so this lands in the engine's PCM ring
                      // whether that ring is on this thread or in the worker.
                      onFeed: audioRouter.wrapExternalFeed(defaultFeedPCMToModule),
                  }
                : { preallocSize: 2048 }
        )
    );

    const audioPlayer =
        profile.audioPlayer === 'popup' ? createPopupAudioPlayerController() : createSectionAudioPlayerController();
    // song-loader's openModPlayer lookup (and console users) read these off window.
    owned.add(exposeAudioPlayerGlobals(audioPlayer));
    owned.add(claimGlobal(windowRef, 'updatePresetDisplay', updatePresetDisplay));

    // ---- presets
    /**
     * Where fetched preset bytes go: the main-thread module's VFS, or — in the
     * render-worker topology, where the VFS is in the worker — the transport.
     *
     * @param {'load' | 'add'} mode
     * @returns {((vfsPath: string, bytes: Uint8Array) => void) | undefined}
     */
    function presetWriterFor(mode) {
        if (getModule()?.FS) return undefined;
        const transport = pmContext?.transport;
        if (transport?.writePreset) {
            return (vfsPath, bytes) => transport.writePreset?.(vfsPath, bytes, mode);
        }
        return undefined;
    }

    async function loadRandomPresetFromRemote() {
        const writeBytes = presetWriterFor('load');
        const result = await loadRandomApiPreset({
            module: getModule(),
            apiBase: getConfiguredPresetApiBase({ windowRef, storage }),
            requireDir: profile.requirePresetDir,
            startTransitionWhenReady: writeBytes ? undefined : startTransitionWhenReady,
            writeBytes,
        });
        if (!result && pmContext) {
            // API down: cycle the bundled local presets instead.
            try {
                pmContext.nextPreset();
            } catch (error) {
                console.warn(`${log} local preset fallback failed:`, error);
            }
        }
    }
    const randomRemote = () => {
        loadRandomPresetFromRemote().catch((error) => console.warn(`${log} random preset failed:`, error));
    };

    async function loadStartupPresets() {
        if (state.startupPresetsLoaded) return;
        state.startupPresetsLoaded = true;
        if (weeksOnFire) {
            console.log(`${log} Weeks on fire: preset playlist seeded by WASM bootstrap`);
            return;
        }
        const module = getModule();
        // `count` is a named option: positional `loadStartupApiPresets(5)`
        // destructured to count = 0 and quietly loaded nothing.
        const startup = /** @type {{ vfsPath: string, filename: string, bytes?: Uint8Array }[]} */ (
            await loadStartupApiPresets({
                module,
                count: 5,
                apiBase: getConfiguredPresetApiBase({ windowRef, storage }),
                requireDir: profile.requirePresetDir,
                updateDisplayMode: 'first',
                writeBytes: presetWriterFor('add'),
            })
        );
        if (startup.length === 0 || !pmContext) return;
        if (module?.FS) {
            loadPresetFile(module, startup[0].vfsPath);
            updatePresetDisplay(startup[0].filename);
            for (const entry of startup.slice(1)) addPresetFile(module, entry.vfsPath);
            return;
        }
        // Render-worker topology: the first preset is loaded, the rest queued, there.
        startup.forEach(({ vfsPath, bytes }, index) => {
            if (!bytes || !pmContext) return;
            if (index === 0) {
                pmContext.transport?.writePreset?.(vfsPath, bytes);
                updatePresetDisplay(startup[0].filename);
            } else {
                pmContext.addPreset(vfsPath, bytes);
            }
        });
    }

    /**
     * An optional feature that fails to build is logged and left out: a broken
     * preset library must not take the engine down with it (on the old inline
     * page the same throw ended the whole module script).
     *
     * @template T
     * @param {string} label
     * @param {() => T} build
     * @returns {T | null}
     */
    const optional = (label, build) => {
        try {
            return build();
        } catch (error) {
            console.warn(`${log} ${label} unavailable:`, error);
            return null;
        }
    };

    const presetPicker = profile.presetPicker
        ? optional('preset picker', () =>
              owned.add(
                  setupPresetPicker({
                      getModule: () => getModule() ?? null,
                      startTransitionWhenReady,
                      isLocked: () => state.locked,
                      onLockBlocked: () => ui.showStatus('Preset locked — tap lock to unlock', 'warn', 2200),
                      transitionDurationSec: 1.5,
                      preloadFeatured: true,
                  })
              )
          )
        : null;
    if (presetPicker) owned.add(claimGlobal(windowRef, 'presetPicker', presetPicker));

    // ---- actions
    /** @returns {boolean} true when the lock stopped the switch */
    function blockedByLock() {
        if (!state.locked) return false;
        ui.showStatus('Preset locked — tap lock to unlock', 'warn', 2200);
        return true;
    }
    /** Weeks-on-fire mode draws from its own scanned list. @returns {boolean} handled */
    function weeksPreset() {
        if (!weeksOnFire) return false;
        const pick = /** @type {{ loadRandomWeeksPreset?: () => void }} */ (/** @type {unknown} */ (windowRef))
            .loadRandomWeeksPreset;
        if (typeof pick === 'function') pick();
        else console.warn(`${log} Weeks mode: preset scanner not ready yet`);
        return true;
    }

    /** @param {boolean} enabled */
    function applyTransparency(enabled) {
        state.transparent = enabled;
        ui.setTransparency(enabled);
        if (pmContext) {
            pmContext.setTransparent(enabled);
            pmContext.setTransparencyThreshold(TRANSPARENCY_THRESHOLD);
        }
        writeStorage(storage, TRANSPARENCY_STORAGE_KEY, enabled ? '1' : '0');
    }

    function relayout() {
        ui.updateLayout();
        if (pmContext) {
            pmContext.options.aspectCorrection = state.bezel;
            pmContext.resize();
        } else {
            ui.sizeCanvases();
        }
    }

    /** @type {Record<string, () => void>} */
    const actions = {
        lockPreset() {
            state.locked = !state.locked;
            ui.setLocked(state.locked);
            if (profile.persistLock) writeStorage(storage, LOCK_STORAGE_KEY, state.locked ? '1' : '0');
            pmContext?.setLocked(state.locked);
        },
        randomPreset() {
            if (blockedByLock() || weeksPreset()) return;
            randomRemote();
        },
        // "Random Custom" draws from the curated library with quality weighting;
        // right-click opens the full picker. Without a picker it is Random.
        randomCustom() {
            if (blockedByLock() || weeksPreset()) return;
            if (!presetPicker) {
                randomRemote();
                return;
            }
            presetPicker.ready
                .then((presets) => {
                    if (presets && presets.length) presetPicker.pickRandom({ onlyOk: true });
                    else randomRemote();
                })
                .catch((error) => console.warn(`${log} preset library unavailable:`, error));
        },
        startChangeSong() {
            ensureAudioRunning()
                .then(() => ensureWorkletReady())
                .catch((error) => console.warn(`${log} audio/worklet unlock failed:`, error));
        },
        fullWindow() {
            state.bezel = !state.bezel;
            ui.setBezel(state.bezel);
            if (!state.bezel && documentRef.fullscreenElement) {
                documentRef.exitFullscreen().catch(() => {});
            }
            relayout();
        },
        toggleFullscreen() {
            state.bezel = false;
            relayout();
            const request = documentRef.fullscreenElement
                ? documentRef.exitFullscreen()
                : documentRef.documentElement.requestFullscreen();
            request.catch(() => {});
        },
        cycleAudioPlayer: () => audioPlayer.cycleAudioPlayer(),
        closeAudioPlayer: () => audioPlayer.closeAudioPlayer(),
        openFlacPlayer: () => audioPlayer.openFlacPlayer?.(),
        openModPlayer: () => audioPlayer.openModPlayer?.(),
        hidePanel: () => ui.hidePanel(),
        showPanel: () => ui.showPanel(),
    };
    if (profile.transparency) {
        actions.toggleTransparencyMode = () => applyTransparency(!state.transparent);
        owned.add(claimGlobal(windowRef, 'toggleTransparencyMode', actions.toggleTransparencyMode));
    }

    // ---- the DOM
    const bezel = profile.bezel ? owned.add(createBezel(documentRef, { windowRef })) : null;
    const ui = owned.add(
        setupShellUi(documentRef, {
            windowRef,
            actions,
            chromeIds: profile.chromeIds,
            keyboard: profile.keyboard,
            isBezelMode: () => state.bezel,
            onBezelLayout: bezel ? () => bezel.draw() : undefined,
            onContextMenuCustom: presetPicker
                ? (event) => {
                      event.preventDefault();
                      presetPicker.toggle();
                  }
                : undefined,
        })
    );
    const customMilk = documentRef.getElementById('customMilkBtn');
    if (customMilk && presetPicker) customMilk.title = 'Random custom preset — right-click to browse by name';
    ui.setLocked(state.locked);
    if (state.transparent) ui.setTransparency(true);

    if (profile.wasmPicker) {
        const rerender = ui.setupWasmPicker({
            versions: () => [...getSelectableWasmVersions()],
            active: () => buildWasmBundlePaths(selectedWasmVersion).version,
            onChange: (version) => {
                writeStorage(storage, PROJECTM_WASM_VERSION_STORAGE_KEY, version);
                const next = new URLSearchParams(windowRef.location.search);
                next.set('wasm', version);
                windowRef.location.search = next.toString();
            },
        });
        wasmManifestReady
            .then((manifest) => {
                if (!manifest || owned.disposed) return;
                selectedWasmVersion = resolveSelectedWasmVersion({ searchParams: params });
                rerender();
            })
            .catch(() => {});
    }

    if (profile.devTools) {
        if (params.get('localPresets') === '1') {
            ui.enableLocalPresetDrop({
                lastLabel: () => {
                    const last = readStorage(storage, LOCAL_PRESET_LAST_NAME_KEY);
                    return last ? `Last local preset: ${last}` : 'Last local preset: none';
                },
                onFile: (file) => {
                    const load = pmContext
                        ? pmContext.loadPresetFile(file)
                        : loadLocalPresetFile(file, { module: getModule(), startTransitionWhenReady, documentRef });
                    Promise.resolve(load).catch((error) => {
                        ui.showStatus(error instanceof Error ? error.message : String(error), 'error');
                        console.error(`${log} Failed to load local preset:`, error);
                    });
                },
            });
        }

        // Tab / system audio capture (html/audio-capture.html): a popup, not an
        // iframe — the share picker needs its own user gesture and the page has
        // to stay open while the user switches to the shared tab. It posts PCM
        // to window.opener, or on BroadcastChannel('projectm-audio') when COOP
        // severs the opener.
        /** @type {Window | null} */
        let captureWindow = null;
        const openAudioCapture = () => {
            if (captureWindow && !captureWindow.closed) {
                captureWindow.focus();
                return captureWindow;
            }
            const url = new URL('./audio-capture.html', windowRef.location.href).toString();
            captureWindow = windowRef.open(url, 'projectm-audio-capture', 'popup,width=440,height=340');
            if (!captureWindow) console.warn('[projectM] audio capture popup blocked; allow popups or open', url);
            return captureWindow;
        };
        owned.add(claimGlobal(windowRef, 'openAudioCapture', openAudioCapture));
        owned.add(claimGlobal(windowRef, 'feedPCMToModuleForDebug', feedPCMToModule));

        // Launchers for the external players, in case the panel image has no
        // hit zone for them. After first paint, so the rest of the UI is there.
        owned.setTimeout(
            () =>
                ui.addLaunchers([
                    {
                        id: 'modPlayerLaunchBtn',
                        label: 'MOD',
                        title: 'Open MOD Player (tracker) — sends PCM via postMessage',
                        open: () => audioPlayer.openModPlayer?.(),
                    },
                    {
                        id: 'flacPlayerLaunchBtn',
                        label: 'FLAC',
                        title: 'Open FLAC Player — sends PCM via postMessage',
                        open: () => audioPlayer.openFlacPlayer?.(),
                    },
                    {
                        id: 'audioCaptureLaunchBtn',
                        label: 'TAB',
                        title: 'Capture tab / system audio (getDisplayMedia) — sends PCM via postMessage',
                        open: () => void openAudioCapture(),
                    },
                ]),
            extrasDelayMs
        );

        const sender = owned.add(createPcmTestSender({ windowRef }));
        owned.add(claimGlobal(windowRef, 'startLocalProjectMTestSender', sender.start));
        owned.add(claimGlobal(windowRef, 'stopLocalProjectMTestSender', sender.stop));
        const host = windowRef.location?.hostname;
        if (host === 'localhost' || host === '127.0.0.1' || params.has('debugSender')) {
            owned.setTimeout(() => ui.addTestSenderPanel(sender), extrasDelayMs + 800);
        }
    }

    // ---- the engine
    /**
     * The panels that read and write engine state through a module object on
     * this thread (preset dev tools, experimental bridge, ...). In the worker
     * topology there is no such object here, so they stay unbuilt (?renderWorker=0
     * brings them back); the perf HUD and FBO banner run on the transport.
     *
     * @param {ProjectMContext} context
     */
    function ownDevTools(context) {
        const module = /** @type {ProjectMModule | null} */ (context.module);
        if (module) {
            // The baked EM_JS worklet handler and media-element export get their
            // host implementations: one PCM ring writer (projectm-pcm-ring.js).
            context.own(installHostPcmRingWriter(module));
            const meshQuality = context.own(setupMeshQuality(module));
            context.own(exposeMeshQualityGlobals(meshQuality));
            const governor = context.own(
                setupFpsGovernor(module, {
                    // Governor v2: shrink the backing store while the CSS size stays.
                    onRenderScaleChange: (scale) => {
                        context.renderScale = scale;
                        context.resize();
                    },
                })
            );
            context.own(exposeGovernorGlobals(governor));
            const fbo = context.own(setupFboFormatIndicator(module));
            context.own(exposeFboFormatGlobals(() => fbo.format()));
            context.own(setupPerfTools(module));
            context.own(exposePresetDevGlobals(context.own(setupPresetDevTools(module, { startTransitionWhenReady }))));
            context.own(exposeExperimentalGlobals(context.own(setupExperimentalBridge(module))));
            context.own(setupAudioTestPanel(() => getModule(), { documentRef }));
            return;
        }
        const transport = context.transport;
        if (transport) context.own(setupTransportPerfTools(transport));
        const workerHandle = transport?.workerHandle;
        if (workerHandle) {
            const fbo = context.own(setupWorkerFboFormatIndicator(workerHandle));
            context.own(exposeFboFormatGlobals(() => fbo.format()));
        }
        console.info(
            `${log} Rendering in the render worker; the preset dev tools and experimental bridge are inactive (use ?renderWorker=0 for them).`
        );
    }

    /** @returns {ProjectMContextOptions} */
    function contextOptions() {
        const byId = (/** @type {string} */ id) => documentRef.getElementById(id);
        /** @type {ProjectMContextOptions} */
        const config = {
            canvas: /** @type {HTMLCanvasElement} */ (byId('mcanvas')),
            secondaryCanvas: /** @type {HTMLCanvasElement | null} */ (byId('scanvas')) ?? undefined,
            primaryCanvasSelector: '#mcanvas',
            secondaryCanvasSelector: '#scanvas',
            container: byId('contain1') ?? undefined,
            aspectCorrection: state.bezel,
            presetLocked: state.locked,
            audioSource: 'none',
            onError: (detail) => console.error(`${log} context init error:`, detail),
        };
        if (profile.transparency) {
            config.transparent = state.transparent;
            config.transparencyThreshold = TRANSPARENCY_THRESHOLD;
            // The glass toggle works at runtime, and a canvas created opaque
            // cannot show through later; while it is off the engine fills the
            // alpha channel with 1.
            config.contextAlpha = true;
        }
        if (audioRouter) config.audioRouter = audioRouter;
        if (profile.wasmPicker) {
            config.wasmBaseUrl = baseUrl;
            config.wasmVersion = selectedWasmVersion;
        }
        if (profile.urlContextConfig) {
            const render = resolveRenderConfig(params, storage, windowRef.navigator?.hardwareConcurrency);
            Object.assign(config, resolveContextAttributes(params, storage, windowRef), {
                targetFps: render.targetFps,
                qualityGovernor: render.qualityGovernor,
                meshQuality: render.meshQuality,
                presetSwitchPolicy: render.presetSwitchPolicy,
                presetSwitchBars: render.presetSwitchBars,
                transitionBeats: render.transitionBeats,
                rhythmHint: render.rhythmHint,
                onRenderWorkerFallback: (/** @type {string} */ reason) => {
                    console.warn(`${log} Render worker unavailable, rendering on the main thread:`, reason);
                },
            });
        }
        return { ...config, ...options.contextOptions };
    }

    /** @param {ProjectMContext} context */
    function wireStartedContext(context) {
        // Console / test handle that works in both topologies (Module is null in
        // the render worker): beat events, PCM stats.
        context.own(claimGlobal(windowRef, 'projectMContext', context));
        context.own(claimGlobal(windowRef, 'Module', context.module ?? undefined));

        if (profile.urlContextConfig && params.get('rhythmDebug') === '1') {
            // ?rhythmDebug=1: log the music's structure as the engine hears it.
            context.own(
                context.on('bar', (event) => {
                    console.info(
                        `${log} bar  beat #${event.beatIndex}  ${event.bpm.toFixed(1)} BPM  confidence ${event.confidence.toFixed(2)}`
                    );
                })
            );
            context.own(
                context.on('section', (event) => {
                    console.info(`${log} section ${event.sectionIndex} at beat #${event.beatIndex}`);
                })
            );
        }
        flushQueuedExternalPCM();
        if (profile.transparency) ui.setTransparency(state.transparent);
        if (profile.devTools) ownDevTools(context);
        if (profile.autoSwitch && !weeksOnFire) {
            const everyMs = resolvePresetAutoSwitchMs(params);
            const timer = setInterval(() => {
                if (state.locked || documentRef.hidden) return;
                console.info(`${log} auto preset switch`);
                randomRemote();
            }, everyMs);
            context.own(() => clearInterval(timer));
            console.info(`${log} auto preset switch every ${everyMs / 1000}s (lock pauses it)`);
        }
    }

    async function attemptInit() {
        if (initErrors.simulate) {
            // ?simulateInitFail=1: the first (automatic) attempt leaves the
            // overlay up; Retry clears the flag and really initializes.
            initErrors.simulate = false;
            return;
        }
        if (pmContext || owned.disposed) return;
        if (!checkCrossOriginIsolation()) return;

        relayout();
        await wasmManifestReady;
        if (owned.disposed) return;

        const context = new ProjectMContext(contextOptions());
        pmContext = context;
        try {
            await context.start();
        } catch (error) {
            // A failed start leaves nothing behind; Retry builds a new context.
            if (pmContext === context) pmContext = null;
            context.destroy();
            throw error;
        }
        if (owned.disposed || pmContext !== context) return;
        wireStartedContext(context);
        ui.hideSplash();
        await loadStartupPresets();
    }

    function init() {
        initInFlight ??= attemptInit()
            .catch((error) => console.error(`${log} projectM initialization failed:`, error))
            .finally(() => {
                initInFlight = null;
            });
        return initInFlight;
    }

    // Shows a recovery overlay (#pm-init-error) when init fails; see
    // docs/EMSCRIPTEN.md#init-error-codes. ?simulateInitFail=1 previews it.
    const initErrors = owned.add(setupInitErrorHandling(() => void init()));
    owned.add(() => {
        pmContext?.destroy();
        pmContext = null;
    });

    relayout();
    owned.add(() => windowRef.removeEventListener('resize', relayout));
    windowRef.addEventListener('resize', relayout);
    if (typeof windowRef.ResizeObserver === 'function') {
        const contain = documentRef.getElementById('contain1');
        if (contain) {
            const observer = new windowRef.ResizeObserver(() => relayout());
            observer.observe(contain);
            owned.add(() => observer.disconnect());
        }
    }

    /** @type {() => void} */
    let settleReady = () => {};
    /** @type {Promise<void>} */
    const ready = new Promise((resolve) => {
        settleReady = resolve;
    });
    owned.add(() => settleReady());
    owned.setTimeout(() => {
        // projectm-wasm-default-redirect.js is about to reload with ?wasm=<default>.
        if (/** @type {{ __projectMWasmRedirectPending?: boolean }} */ (windowRef).__projectMWasmRedirectPending) {
            settleReady();
            return;
        }
        void init().then(settleReady);
    }, options.initDelayMs ?? 750);

    return {
        profile,
        actions,
        context: () => pmContext,
        init,
        ready,
        dispose: () => owned.dispose(),
    };
}
