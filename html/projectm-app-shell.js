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

import { createAudioPlayerController } from './projectm-audio-player.js';
import { ensureAudioRunning } from './projectm-audio-bootstrap.js';
import { createAudioSourceRouter } from './projectm-audio-source-router.js';
import { setupShellUi } from './projectm-app-shell-ui.js';
import { createBezel } from './projectm-bezel.js';
import { ProjectMContext } from './projectm-context.js';
import { createDisposables } from './projectm-disposables.js';
import { defaultFeedPCMToModule, setupExternalAudioReceiver } from './projectm-external-pcm.js';
import { claimGlobal } from './projectm-globals.js';
import {
    buildWasmBundlePaths,
    PROJECTM_WASM_VERSION_STORAGE_KEY,
    resolveSelectedWasmVersion,
} from './projectm-init.js';
import { checkCrossOriginIsolation, setupInitErrorHandling } from './projectm-init-errors.js';
import { exposeAudioPlayerGlobals, patchBroadcastChannel } from './projectm-legacy-globals.js';
import { setupPresetPicker } from './projectm-preset-picker.js';
import { updatePresetDisplay } from './projectm-presets.js';
import { startTransitionWhenReady } from './projectm-transitions.js';
import { loadWasmBuildsManifest } from './projectm-wasm-manifest.js';
import { getSelectableWasmVersions } from './projectm-wasm-version.js';
import { ensureWorkletReady } from './projectm-worklet-playback.js';
import { applyWeeksOnFireDomConfig, isWeeksOnFireMode, wireFlacDecoderBridge } from './projectm-weeks-on-fire.js';
import {
    LOCK_STORAGE_KEY,
    readStorage,
    resolveShellProfile,
    TRANSPARENCY_STORAGE_KEY,
    TRANSPARENCY_THRESHOLD,
    writeStorage,
} from './app-shell/config.js';
import { setupShellDevPanels } from './app-shell/dev-tools.js';
import { buildContextOptions, wireLiveTexture, wireStartedContext } from './app-shell/engine.js';
import { createShellPresets } from './app-shell/presets.js';

// The pure profile / URL-settings helpers live in app-shell/config.js.
export {
    resolveContextAttributes,
    resolvePresetAutoSwitchMs,
    resolveRenderConfig,
    resolveShellProfile,
    SHELL_PROFILES,
} from './app-shell/config.js';

/**
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('./projectm-app-shell-ui.js').ShellUi} ShellUi
 *
 * @typedef {import('./app-shell/config.js').ShellProfile} ShellProfile
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
            owned.add(mod.installSongLoaderInterceptor());
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

    // One controller for every page: it picks section / docked frame / tab /
    // popup per source, from the URL and whether the page has the section.
    const audioPlayer = createAudioPlayerController({ documentRef });
    owned.add(() => audioPlayer.dispose());
    // song-loader's openModPlayer lookup (and console users) read these off window.
    owned.add(exposeAudioPlayerGlobals(audioPlayer));
    owned.add(claimGlobal(windowRef, 'updatePresetDisplay', updatePresetDisplay));

    // ---- presets
    const { randomRemote, loadStartupPresets, weeksPreset } = createShellPresets({
        profile,
        log,
        windowRef,
        storage,
        state,
        weeksOnFire,
        getContext: () => pmContext,
        getModule,
    });

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

    // Positions the container for the current mode. The canvas size follows
    // from that: ProjectMContext observes #contain1 and is the only thing that
    // sizes the canvases. Only an aspect-correction change needs a resize call
    // from here, since it does not change the container's size.
    function relayout() {
        ui.updateLayout();
        if (pmContext && pmContext.options.aspectCorrection !== state.bezel) {
            pmContext.options.aspectCorrection = state.bezel;
            pmContext.resize();
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
        setupShellDevPanels({
            ui,
            owned,
            windowRef,
            documentRef,
            params,
            storage,
            log,
            audioPlayer,
            extrasDelayMs,
            getContext: () => pmContext,
            getModule,
        });
    }

    // ---- the engine
    /** @type {import('./app-shell/engine.js').ShellEngineDeps} */
    const engineDeps = {
        profile,
        log,
        documentRef,
        windowRef,
        params,
        storage,
        state,
        getUi: () => ui,
        audioRouter,
        baseUrl,
        getWasmVersion: () => selectedWasmVersion,
        overrides: options.contextOptions,
        weeksOnFire,
        randomRemote,
        getModule,
    };

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

        const context = new ProjectMContext(buildContextOptions(engineDeps));
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
        wireStartedContext(context, engineDeps);
        ui.hideSplash();
        await wireLiveTexture(context, engineDeps).catch((error) =>
            console.warn(`${log} ?liveTex=1 could not start:`, error)
        );
        if (owned.disposed || pmContext !== context) return;
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

    // The bezel layout is sized from the window height, so window resizes
    // re-run it. Container resizes are ProjectMContext's (see relayout()).
    relayout();
    owned.add(() => windowRef.removeEventListener('resize', relayout));
    windowRef.addEventListener('resize', relayout);

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
