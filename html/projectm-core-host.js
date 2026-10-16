// projectm-core-host.js
//
// The script of html/projectm-core.html. It used to be a 1061-line inline
// <script type="module"> in that page, where nothing type-checked it, no test
// loaded it and scripts/check_host_globals.sh could not see the page globals it
// wrote. It is a module now: html/tsconfig.json's `projectm-*.js` glob checks
// it, tests/web/projectm-core-host.test.mjs drives it, and the page globals it
// still needs go through exposeHostPageGlobals() / exposeAudioPlayerGlobals()
// in projectm-legacy-globals.js.
//
// The panel's buttons name their handler in `data-action` (see CORE_HOST_ACTIONS)
// instead of an inline `onclick="lockPreset()"`. Those inline handlers resolved
// against page globals, and only cycleAudioPlayer() and
// toggleTransparencyMode() were ever published, so the other seven buttons threw
// a ReferenceError on click — and the glass button, which had both the inline
// handler and a listener, toggled twice.
//
// Every URL flag is read through projectm-host-config.js (docs/HOST_FLAGS.md).
//
// The page runs startCoreHost() on load; tests call it against a fake DOM.

import { createPopupAudioPlayerController } from './projectm-audio-player.js';
import { ensureAudioRunning } from './projectm-audio-bootstrap.js';
import { ensureWorkletReady } from './projectm-worklet-playback.js';
import { installHostPcmRingWriter } from './projectm-pcm-ring.js';
import { createAudioSourceRouter } from './projectm-audio-source-router.js';
import { ProjectMContext } from './projectm-context.js';
import { defaultFeedPCMToModule, feedPCMToModule, flushQueuedExternalPCM, setupExternalAudioReceiver } from './projectm-external-pcm.js';
import { setupFboFormatIndicator, setupWorkerFboFormatIndicator } from './projectm-fbo-format.js';
import { setupFpsGovernor } from './projectm-fps-governor.js';
import { getHostConfig } from './projectm-host-config.js';
import { checkCrossOriginIsolation, setupInitErrorHandling } from './projectm-init-errors.js';
import { setupMeshQuality } from './projectm-mesh-quality.js';
import { setupPerfTools, setupTransportPerfTools } from './projectm-perf.js';
import { setupAudioTestPanel } from './projectm-synthetic-audio.js';
import { setupExperimentalBridge } from './projectm-experimental-bridge.js';
import { setupPresetDevTools } from './projectm-preset-dev.js';
import {
    exposeAudioPlayerGlobals,
    exposeExperimentalGlobals,
    exposeFboFormatGlobals,
    exposeGovernorGlobals,
    exposeHostPageGlobals,
    exposeMeshQualityGlobals,
    exposePresetDevGlobals,
    patchBroadcastChannel,
} from './projectm-legacy-globals.js';
import {
    getConfiguredPresetApiBase,
    LOCAL_PRESET_LAST_NAME_KEY,
    loadLocalPresetFile,
    loadRandomApiPreset as loadRandomPresetFromApi,
    loadStartupApiPresets as loadStartupPresetsFromApi,
    updatePresetDisplay,
} from './projectm-presets.js';
import { setupPresetPicker } from './projectm-preset-picker.js';
import { startTransitionWhenReady } from './projectm-transitions.js';
import { applyWeeksOnFireDomConfig, isWeeksOnFireMode, wireFlacDecoderBridge } from './projectm-weeks-on-fire.js';
import {
    addPresetFile,
    loadPresetFile,
    setAspectCorrection,
    setPresetLocked,
    setTransparencyMode,
    setTransparencyThreshold,
    setWindowSize,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-host-config-types.ts').HostConfig} HostConfig
 * @typedef {import('./projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {(vfsPath: string, bytes: Uint8Array) => unknown} PresetBytesWriter
 */

/** Every `data-action` html/projectm-core.html may name. */
export const CORE_HOST_ACTIONS = Object.freeze([
    'lockPreset',
    'hidePanel',
    'showPanel',
    'cycleAudioPlayer',
    'startChangeSong',
    'randomPreset',
    'fullWindow',
    'randomCustom',
    'toggleFullscreen',
    'toggleTransparencyMode',
]);

/** Near-black cutoff for glass-layer transparency. */
const TRANSPARENCY_THRESHOLD = 0.01;

/**
 * The page asks the engine for its historical auto-switch window: 27 s plus up
 * to 30 s more, drawn from the engine's seeded RNG (the WASM default is a
 * fixed 30 s since set_preset_duration() replaced the hidden random one).
 */
const ENGINE_PRESET_DURATION = Object.freeze({ seconds: 27, randomExtra: 30 });

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
const byId = (id) => document.getElementById(id);

/**
 * ProjectMContext options for this page's flags and state. Pure, so the test
 * can check the flag wiring without booting anything.
 *
 * @param {HostConfig} config
 * @param {{ isBezelMode: boolean, isTransparencyMode: boolean, isPresetLocked: boolean }} state
 * @returns {Partial<ProjectMContextOptions>}
 */
export function coreHostContextOptions(config, { isBezelMode, isTransparencyMode, isPresetLocked }) {
    let meshQuality = config.meshQuality;
    if (meshQuality === 'auto') {
        // The worker has no navigator of its own to decide with; decide here.
        meshQuality = (globalThis.navigator?.hardwareConcurrency || 1) < 4 ? 'low' : 'high';
    }
    return {
        aspectCorrection: isBezelMode,
        transparent: isTransparencyMode,
        // Transparency is toggled at run time, and the canvas's alpha channel
        // cannot be added after the context exists: always ask for it.
        contextAlpha: true,
        transparencyThreshold: TRANSPARENCY_THRESHOLD,
        presetLocked: isPresetLocked,
        presetDuration: ENGINE_PRESET_DURATION,
        antialias: config.aa,
        preserveDrawingBuffer: config.capture,
        fboPrecision: config.fboPrecision,
        depth: config.depth,
        stencil: config.depth,
        // The render worker has no location/localStorage of its own, so these
        // are resolved here and forwarded in its 'init' message.
        targetFps: config.targetFps,
        qualityGovernor: config.governor,
        meshQuality,
        // Musical scheduling (projectM-4/rhythm.h).
        presetSwitchPolicy: config.switchOn,
        presetSwitchBars: config.switchBars,
        transitionBeats: config.transitionBeats,
        rhythmHint: config.bpm,
    };
}

/**
 * @param {object} [options]
 * @param {HostConfig} [options.config]
 * @param {(options: ProjectMContextOptions) => ProjectMContext} [options.createContext]
 * @param {number} [options.initDelayMs] Delay before the first init attempt.
 * @param {() => Promise<{ installSongLoaderInterceptor: () => void, wrapSongChannel: (name: string, channel: BroadcastChannel) => BroadcastChannel }>} [options.loadSongLoader]
 * @param {typeof setupPresetPicker} [options.setupPicker]
 */
export function startCoreHost({
    config = getHostConfig(),
    createContext = (options) => new ProjectMContext(options),
    initDelayMs = 750,
    loadSongLoader = () => import('./projectm-song-loader.js'),
    setupPicker = setupPresetPicker,
} = {}) {
    // Optional: a missing/soft-404 song-loader.js must not abort this module
    // (DreamHost serves www.noahcohn.com/404.1ink as text/html).
    void loadSongLoader().then((mod) => {
        mod.installSongLoaderInterceptor();
        // The WASM glue posts its song URL on `new BroadcastChannel('sng')`
        // itself, so intercepting it means wrapping the global constructor: an
        // explicit, reversible opt-in (see projectm-legacy-globals.js).
        patchBroadcastChannel(mod.wrapSongChannel);
    }).catch((error) => {
        console.warn('[projectM] song loader unavailable; Start/Change Song uses /flac/', error);
    });

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const weeksOnFireMode = isWeeksOnFireMode();

    wireFlacDecoderBridge(document);
    if (weeksOnFireMode) {
        applyWeeksOnFireDomConfig(document);
        document.title = 'Project M — Weeks on Fire';
    }

    /** @type {ProjectMContext | null} */
    let pmContext = null;
    let isBezelMode = true;
    let isPresetLocked = false;
    let isTransparencyMode = false;
    let startupPresetsLoaded = false;

    /** @returns {ProjectMModule | null} */
    function getModule() {
        return pmContext?.module ?? null;
    }

    // ====== RENDER TOPOLOGY (see docs/PERFORMANCE.md) ======
    // Rendering runs in a dedicated OffscreenCanvas worker by default and on
    // this thread with ?renderWorker=0, but nothing below knows which: the
    // choice, the fallback, and the two transports live inside ProjectMContext.

    // ====== DRAGGABLE KNOB ======
    const knob = /** @type {HTMLElement} */ (byId('knob'));
    const panelContainer = /** @type {HTMLElement} */ (byId('panel-container'));
    let rot = 0;
    let dragging = false;
    let startAng = 0;

    /** @param {{ clientX: number, clientY: number }} e */
    function angle(e) {
        const r = knob.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    }

    /** @param {number} deg */
    function applyKnobRotation(deg) {
        knob.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
        const hue = ((deg % 360) + 360) % 360;
        panelContainer.style.filter = `drop-shadow(0 0 18px hsla(${hue}, 55%, 50%, 0.42))`;
    }

    knob.addEventListener('mousedown', (e) => { dragging = true; startAng = angle(e) - rot; });
    document.addEventListener('mousemove', (e) => {
        if (dragging) { rot = angle(e) - startAng; applyKnobRotation(rot); }
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    knob.addEventListener('touchstart', (e) => { dragging = true; startAng = angle(e.touches[0]) - rot; });
    document.addEventListener('touchmove', (e) => {
        if (dragging) { rot = angle(e.touches[0]) - startAng; applyKnobRotation(rot); }
    });
    document.addEventListener('touchend', () => { dragging = false; });

    // ====== BUTTON PULSE ======
    /** @param {Element | null} btn */
    function pulseButton(btn) {
        if (prefersReducedMotion || !(btn instanceof HTMLElement)) return;
        btn.classList.remove('pulse');
        void btn.offsetWidth;
        btn.classList.add('pulse');
        setTimeout(() => btn.classList.remove('pulse'), 420);
    }

    document.querySelectorAll('.clickable-button').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const target = /** @type {Element | null} */ (e.target);
            pulseButton(target?.closest('.clickable-button') ?? null);
        });
    });

    // ====== PANEL SHOW/HIDE ======
    function hidePanel() {
        console.log('[ProjectM] Hide Panel');
        panelContainer.style.transition = 'all 0.3s ease';
        panelContainer.style.opacity = '0';
        setTimeout(() => {
            panelContainer.style.display = 'none';
            byId('show-btn')?.classList.remove('hidden');
        }, 280);
    }

    function showPanel() {
        panelContainer.style.display = 'block';
        panelContainer.style.opacity = '0';
        setTimeout(() => {
            panelContainer.style.transition = 'all 0.3s ease';
            panelContainer.style.opacity = '1';
        }, 10);
        byId('show-btn')?.classList.add('hidden');
    }

    // ====== BEAT LED / IDLE KNOB WOBBLE ======
    const beatLed = document.querySelector('.led--beat');
    if (!prefersReducedMotion && beatLed) {
        setInterval(() => beatLed.classList.toggle('on'), 500);
    }
    if (!prefersReducedMotion) {
        setTimeout(() => {
            knob.style.transition = 'transform 1.5s cubic-bezier(0.34,1.56,0.64,1)';
            knob.style.transform = `translate(-50%, -50%) rotate(${Math.random() * 25 - 12}deg)`;
        }, 1200);
    }

    // ====== LOCAL PRESETS ======
    /** @param {string} message */
    function setLocalPresetError(message) {
        const stat = byId('stat');
        if (!stat) return;
        stat.textContent = message;
        stat.style.display = 'block';
        stat.style.background = 'rgba(127, 29, 29, 0.92)';
        stat.style.color = '#fecaca';
        stat.style.padding = '0.45rem 0.7rem';
        stat.style.borderRadius = '0.45rem';
        stat.style.border = '1px solid rgba(248,113,113,0.5)';
    }

    function updateLastLocalPresetLabel() {
        const label = byId('localPresetLast');
        if (!label) return;
        let last = null;
        try {
            last = localStorage.getItem(LOCAL_PRESET_LAST_NAME_KEY);
        } catch { /* storage blocked */ }
        label.textContent = last ? `Last local preset: ${last}` : 'Last local preset: none';
    }

    /** @param {File | undefined} file */
    async function handleLocalPresetSelection(file) {
        if (!file) return;
        try {
            if (pmContext) {
                await pmContext.loadPresetFile(file);
            } else {
                await loadLocalPresetFile(file, {
                        module: getModule() ?? undefined,
                    startTransitionWhenReady,
                    documentRef: document,
                });
            }
            updateLastLocalPresetLabel();
        } catch (error) {
            setLocalPresetError(error instanceof Error ? error.message : String(error));
            console.error('Failed to load local preset:', error);
        }
    }

    // ====== API PRESET HELPERS ======
    // Where fetched preset bytes go. Direct topology: the main-thread module's
    // VFS (fetchApiPreset writes it). Render-worker topology: the VFS is in the
    // worker, so route through the transport, which writes and loads/adds there.
    /**
     * @param {'load' | 'add'} mode
     * @returns {PresetBytesWriter | undefined}
     */
    function presetWriterFor(mode) {
        const module = getModule();
        if (module && module.FS) return undefined;
        const transport = pmContext?.transport;
        if (transport?.writePreset) {
            return (vfsPath, bytes) => transport.writePreset?.(vfsPath, bytes, mode);
        }
        return undefined;
    }

    async function loadRandomPresetFromRemote() {
        const writeBytes = presetWriterFor('load');
        const result = await loadRandomPresetFromApi({
            module: getModule() ?? undefined,
            apiBase: getConfiguredPresetApiBase(),
            requireDir: true,
            startTransitionWhenReady: writeBytes ? undefined : startTransitionWhenReady,
            writeBytes,
        });
        if (!result && pmContext) {
            // API down: cycle the bundled local presets instead.
            try {
                pmContext.nextPreset();
            } catch (error) {
                console.warn('[ProjectM] local preset fallback failed:', error);
            }
        }
        return result;
    }

    // The engine timer only calls play_next() on the worker playlist. A playlist
    // of one (the preset just loaded) makes that a no-op, which is why the
    // visual stayed put until the random-preset button fetched a new milk file.
    // This timer is that button. Lock skips it. ?presetDuration= seconds.
    const presetAutoSwitchMs = config.presetDuration * 1000;
    /** @type {ReturnType<typeof setInterval> | 0} */
    let presetAutoSwitchTimer = 0;

    function startPresetAutoSwitch() {
        if (presetAutoSwitchTimer || weeksOnFireMode) return;
        presetAutoSwitchTimer = setInterval(() => {
            if (isPresetLocked || document.hidden) return;
            console.info('[ProjectM] auto preset switch');
            void loadRandomPresetFromRemote();
        }, presetAutoSwitchMs);
        console.info(`[ProjectM] auto preset switch every ${presetAutoSwitchMs / 1000}s (lock pauses it)`);
    }

    // ====== BUTTON HANDLERS ======
    function startChangeSong() {
        console.log('[ProjectM] Start/Change Song');
        ensureAudioRunning()
            .then(() => ensureWorkletReady())
            .catch((err) => console.warn('[ProjectM] audio/worklet unlock failed:', err));
    }

    function fullWindow() {
        console.log('[ProjectM] Full Window');
        isBezelMode = !isBezelMode;
        byId('toggleBezelBtn')?.classList.toggle('engaged', isBezelMode);
        if (!isBezelMode && document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
        updateLayout();
        syncModuleSize();
    }

    // ====== CUSTOM PRESET PICKER ======
    // Named, searchable preset library with tags, favorites, featured pack, and
    // quality-weighted random (projectm-preset-picker.js + projectm-preset-library.js).
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let lockToastTimer;
    function flashLockToast() {
        const el = byId('stat');
        if (!el) return;
        el.style.display = 'block';
        el.textContent = 'Preset locked — tap lock to unlock';
        el.style.background = 'rgba(120, 53, 15, 0.92)';
        el.style.color = '#fde68a';
        el.style.padding = '0.45rem 0.7rem';
        el.style.borderRadius = '0.45rem';
        el.style.border = '1px solid rgba(245,158,11,0.5)';
        clearTimeout(lockToastTimer);
        lockToastTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
    }

    try {
        if (localStorage.getItem('projectm:presetLocked') === '1') isPresetLocked = true;
    } catch { /* ignore */ }
    // ?transparent=1, else the stored toggle.
    isTransparencyMode = config.transparent;

    const presetPicker = setupPicker({
        getModule: () => getModule(),
        startTransitionWhenReady,
        isLocked: () => isPresetLocked,
        onLockBlocked: flashLockToast,
        transitionDurationSec: 1.5,
        preloadFeatured: true,
    });

    if (isPresetLocked) {
        document.body.classList.add('has-lock');
        byId('lockPresetBtn')?.classList.add('engaged');
    }

    /** @param {string} label */
    function loadRandomWeeksPreset(label) {
        const load = /** @type {{ loadRandomWeeksPreset?: () => void }} */ (globalThis).loadRandomWeeksPreset;
        if (typeof load === 'function') {
            console.log(`[ProjectM] ${label}`);
            load();
        } else {
            console.warn('[ProjectM] Weeks mode: preset scanner not ready yet');
        }
    }

    function randomPreset() {
        if (isPresetLocked) {
            flashLockToast();
            return;
        }
        if (weeksOnFireMode) {
            loadRandomWeeksPreset('Random Weeks Preset');
            return;
        }
        console.log('[ProjectM] Random Preset');
        void loadRandomPresetFromRemote();
    }

    // "Random Custom" draws from the curated library with quality weighting,
    // preferring verified-rendering presets. Right-click opens the full picker.
    function randomCustom() {
        if (isPresetLocked) {
            flashLockToast();
            return;
        }
        if (weeksOnFireMode) {
            loadRandomWeeksPreset('Random Weeks Preset (custom slot)');
            return;
        }
        console.log('[ProjectM] Random Custom');
        void presetPicker.ready.then((presets) => {
            if (presets && presets.length) {
                presetPicker.pickRandom({ onlyOk: true });
            } else {
                void loadRandomPresetFromRemote();
            }
        });
    }

    const customMilkBtn = byId('customMilkBtn');
    if (customMilkBtn) {
        customMilkBtn.title = 'Random custom preset — right-click to browse by name';
        customMilkBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            presetPicker.toggle();
        });
    }

    if (config.localPresets) {
        const devPanel = byId('local-preset-dev');
        const input = /** @type {HTMLInputElement | null} */ (byId('localPresetInput'));
        const dropzone = byId('local-preset-dropzone');
        if (devPanel && input && dropzone) {
            devPanel.hidden = false;
            updateLastLocalPresetLabel();
            input.addEventListener('change', () => {
                void handleLocalPresetSelection(input.files?.[0]);
                input.value = '';
            });
            for (const type of ['dragenter', 'dragover']) {
                dropzone.addEventListener(type, (event) => {
                    event.preventDefault();
                    dropzone.classList.add('dragover');
                });
            }
            for (const type of ['dragleave', 'drop']) {
                dropzone.addEventListener(type, (event) => {
                    event.preventDefault();
                    dropzone.classList.remove('dragover');
                });
            }
            dropzone.addEventListener('drop', (event) => {
                void handleLocalPresetSelection(/** @type {DragEvent} */ (event).dataTransfer?.files?.[0]);
            });
        }
    }

    // The popup controller owns every player and capture window it opens.
    // song-loader's openModPlayer lookup still reads the names off window.
    const audioPlayerController = createPopupAudioPlayerController();
    exposeAudioPlayerGlobals(audioPlayerController);

    // ====== TRANSPARENCY ======
    /** @param {boolean} enabled */
    function applyTransparencyDomState(enabled) {
        const scanvas = /** @type {HTMLElement | null} */ (document.querySelector('#scanvas'));
        const bgMedia = /** @type {HTMLElement | null} */ (document.querySelector('#bg-media'));
        if (scanvas) scanvas.style.display = enabled ? 'none' : 'block';
        if (bgMedia) bgMedia.style.display = enabled ? 'block' : 'none';
        document.querySelectorAll('[data-action="toggleTransparencyMode"]').forEach((btn) => {
            btn.classList.toggle('engaged', enabled);
        });
        document.querySelector('.led--glass')?.classList.toggle('on', enabled);
        document.body.classList.toggle('has-transparency', enabled);
    }

    /** @param {boolean} enabled */
    function applyTransparencyMode(enabled) {
        isTransparencyMode = enabled;
        applyTransparencyDomState(enabled);

        if (pmContext) {
            pmContext.setTransparent(enabled);
            pmContext.setTransparencyThreshold(TRANSPARENCY_THRESHOLD);
        } else {
            const module = getModule();
            if (module) {
                setTransparencyMode(module, enabled);
                setTransparencyThreshold(module, TRANSPARENCY_THRESHOLD);
            }
        }

        try {
            localStorage.setItem('projectm:transparencyMode', enabled ? '1' : '0');
        } catch { /* ignore */ }
    }

    function toggleTransparencyMode() {
        console.log('[ProjectM] Toggle Transparency Mode');
        applyTransparencyMode(!isTransparencyMode);
    }

    if (isTransparencyMode) {
        applyTransparencyDomState(true);
    }

    function lockPreset() {
        console.log('[ProjectM] Lock Preset');
        isPresetLocked = !isPresetLocked;
        document.body.classList.toggle('has-lock', isPresetLocked);
        byId('lockPresetBtn')?.classList.toggle('engaged', isPresetLocked);
        try {
            localStorage.setItem('projectm:presetLocked', isPresetLocked ? '1' : '0');
        } catch { /* ignore */ }
        if (pmContext) {
            pmContext.setLocked(isPresetLocked);
        } else {
            const module = getModule();
            if (module) {
                setPresetLocked(module, isPresetLocked);
            }
        }
    }

    function toggleFullscreen() {
        console.log('[ProjectM] Fullscreen');
        isBezelMode = false;
        updateLayout();
        syncModuleSize();
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    }

    // ====== CANVAS MANAGEMENT ======
    /** @param {string} selector */
    const styleOf = (selector) => /** @type {HTMLElement | null} */ (document.querySelector(selector))?.style;

    function updateLayout() {
        const mcanvas = styleOf('#mcanvas');
        const scanvas = styleOf('#scanvas');
        const wrap = styleOf('#wrap');
        const contain1 = styleOf('#contain1');
        const circle = styleOf('#circle');
        if (!mcanvas || !scanvas) return;

        if (isBezelMode) {
            const sz = window.innerHeight;
            if (wrap) {
                wrap.width = '';
                wrap.height = '';
                wrap.position = '';
                wrap.top = '';
                wrap.left = '';
            }
            if (contain1) {
                contain1.width = sz + 'px';
                contain1.height = sz + 'px';
                contain1.left = 'calc(50vw - ' + (sz / 2) + 'px)';
                contain1.top = 'calc(50vh - ' + (sz / 2) + 'px)';
                contain1.position = 'absolute';
            }
            if (circle) circle.display = 'block';
        } else {
            if (wrap) {
                wrap.width = '100vw';
                wrap.height = '100vh';
                wrap.position = 'fixed';
                wrap.top = '0';
                wrap.left = '0';
            }
            if (contain1) {
                contain1.width = '100vw';
                contain1.height = '100vh';
                contain1.left = '0';
                contain1.top = '0';
                contain1.position = 'fixed';
            }
            if (circle) circle.display = 'none';
        }
        mcanvas.left = '0';
        mcanvas.top = '0';
        scanvas.left = '0';
        scanvas.top = '0';
    }

    /** Shared exclusive-source router for external PCM + worklet (`pl()`). */
    const audioSourceRouter = createAudioSourceRouter({
        autoSwitchOnFeed: true,
        onStatusChange: (status) => {
            console.debug('[ProjectM] audio source:', status.activeSource);
        },
    });

    // ====== EXTERNAL PLAYER AUDIO SOURCE (mod-player + flac_player) ======
    setupExternalAudioReceiver({
        preallocSize: 2048,
        feedGate: () => audioSourceRouter.externalFeedGate(),
        // One entry point for both topologies: ProjectMContext registers its
        // transport with the external-PCM module at start(), so this lands in
        // the engine's PCM ring whether that ring is here or in the worker.
        onFeed: audioSourceRouter.wrapExternalFeed(defaultFeedPCMToModule),
    });

    // Guarded: only some hosts have dedicated FLAC/MOD buttons.
    byId('flacPlayerBtn')?.addEventListener('click', () => audioPlayerController.openFlacPlayer?.());
    byId('modPlayerBtn')?.addEventListener('click', () => audioPlayerController.openModPlayer?.());

    function syncModuleSize() {
        const contain1 = /** @type {HTMLElement | null} */ (document.querySelector('#contain1'));
        const mcanvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#mcanvas'));
        const scanvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('#scanvas'));
        if (!contain1 || !mcanvas || !scanvas) return;

        if (pmContext) {
            pmContext.options.aspectCorrection = isBezelMode;
            pmContext.resize();
            return;
        }

        const rect = contain1.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        mcanvas.width = w;
        mcanvas.height = h;
        scanvas.width = w;
        scanvas.height = h;
        mcanvas.style.width = rect.width + 'px';
        mcanvas.style.height = rect.height + 'px';
        scanvas.style.width = rect.width + 'px';
        scanvas.style.height = rect.height + 'px';
        const module = getModule();
        if (!module) return;
        setWindowSize(module, w, h);
        setAspectCorrection(module, isBezelMode);
    }

    const contain1El = document.querySelector('#contain1');
    if (contain1El && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => syncModuleSize()).observe(contain1El);
    }
    window.addEventListener('resize', updateLayout);

    // Tab / system audio capture (html/audio-capture.html), through the same
    // controller as the panel's audio button, so it owns (and disposes) the
    // window. A popup, not an iframe: the share picker needs its own user
    // gesture, and the page must stay open while the user switches to the tab
    // they shared. It posts PCM to window.opener, falling back to
    // BroadcastChannel("projectm-audio") if COOP severs the opener.
    function openAudioCapture() {
        audioPlayerController.showAudioPlayer('capture');
    }

    // Visible launchers for the external players, top-left, since the panel
    // image has no hit zones for them. Created once, after first paint.
    function ensurePlayerLaunchButtons() {
        if (byId('modPlayerLaunchBtn')) return;

        const style = document.createElement('style');
        style.textContent = `
          .pm-ext-player-btn {
            position: fixed; z-index: 3500; width: 28px; height: 22px;
            background: #222; color: #0f0; border: 1px solid #0a0; border-radius: 3px;
            font: 10px/1 'Lucida Console', monospace; cursor: pointer; opacity: 0.85;
          }
          .pm-ext-player-btn:hover { opacity: 1; background:#111; }
        `;
        document.head.appendChild(style);

        /** @type {Array<[id: string, text: string, title: string, left: string, onClick: () => void]>} */
        const launchers = [
            ['modPlayerLaunchBtn', 'MOD', 'Open MOD Player (tracker) — sends PCM via postMessage', '8px',
                () => audioPlayerController.openModPlayer?.()],
            ['flacPlayerLaunchBtn', 'FLAC', 'Open FLAC Player — sends PCM via postMessage', '40px',
                () => audioPlayerController.openFlacPlayer?.()],
            ['audioCaptureLaunchBtn', 'TAB', 'Capture tab / system audio (getDisplayMedia) — sends PCM via postMessage', '72px',
                openAudioCapture],
        ];
        for (const [id, text, title, left, onClick] of launchers) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.className = 'pm-ext-player-btn';
            btn.textContent = text;
            btn.title = title;
            btn.style.left = left;
            btn.style.top = '8px';
            btn.addEventListener('click', onClick);
            document.body.appendChild(btn);
        }
    }
    setTimeout(ensurePlayerLaunchButtons, 1200);

    const testSender = createLocalTestSender();
    // A tiny floating panel for the test sender, on localhost or ?debugSender.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || config.debugSender) {
        setTimeout(() => {
            const panel = document.createElement('div');
            panel.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99999;background:#111;color:#0f0;font:11px/1.3 monospace;padding:6px 10px;border:1px solid #0a0;border-radius:4px;opacity:0.9';
            const title = document.createElement('div');
            title.style.cssText = 'margin-bottom:4px;font-weight:bold';
            title.textContent = 'projectM Sender Test';
            panel.appendChild(title);
            /** @type {Array<[string, () => void]>} */
            const buttons = [
                ['Tone → PM', () => void testSender.start(false)],
                ['Mic → PM', () => void testSender.start(true)],
                ['Stop', () => testSender.stop()],
            ];
            for (const [label, onClick] of buttons) {
                const btn = document.createElement('button');
                btn.textContent = label;
                btn.style.marginRight = '4px';
                btn.addEventListener('click', onClick);
                panel.appendChild(btn);
            }
            document.body.appendChild(panel);
        }, 2000);
    }

    // Console API (docs/AUDIO_PIPELINE.md, docs/EMSCRIPTEN.md) and the preset
    // label the WASM glue updates by name.
    exposeHostPageGlobals({
        updatePresetDisplay,
        presetPicker,
        toggleTransparencyMode,
        openAudioCapture,
        feedPCMToModuleForDebug: (/** @type {Float32Array} */ buf, /** @type {number} */ ch) => feedPCMToModule(buf, ch),
        startLocalProjectMTestSender: testSender.start,
        stopLocalProjectMTestSender: testSender.stop,
    });

    /** @type {Record<(typeof CORE_HOST_ACTIONS)[number], () => void>} */
    const actions = {
        lockPreset,
        hidePanel,
        showPanel,
        cycleAudioPlayer: audioPlayerController.cycleAudioPlayer,
        startChangeSong,
        randomPreset,
        fullWindow,
        randomCustom,
        toggleFullscreen,
        toggleTransparencyMode,
    };
    document.querySelectorAll('[data-action]').forEach((el) => {
        const name = /** @type {HTMLElement} */ (el).dataset.action ?? '';
        const action = /** @type {Record<string, (() => void) | undefined>} */ (actions)[name];
        if (!action) {
            console.warn(`[ProjectM] no handler for data-action="${name}"`);
            return;
        }
        el.addEventListener('click', () => action());
    });

    // ====== INITIALIZATION ======
    updateLayout();
    setTimeout(() => {
        const splash = styleOf('#splash2');
        if (splash) splash.display = 'none';
    }, 5200);
    setTimeout(() => {
        const splash = styleOf('#splash1');
        if (splash) splash.display = 'none';
    }, 5500);

    // ====== INIT ERROR HANDLING ======
    // Shows a recovery overlay (#pm-init-error) if init fails (EGL/WebGL/projectM
    // setup). See docs/EMSCRIPTEN.md#init-error-codes. ?simulateInitFail=1
    // previews the overlay without breaking WebGL.
    const initErrors = setupInitErrorHandling(() => attemptInit());

    /** Boots the engine once; Retry on the init-error overlay calls it again. */
    async function attemptInit() {
        if (initErrors.simulate) {
            // The automatic first call leaves the simulated overlay up; Retry
            // clears the flag and makes a real attempt.
            initErrors.simulate = false;
            return;
        }

        try {
            if (!pmContext && !checkCrossOriginIsolation()) {
                return;
            }
            if (pmContext) {
                return;
            }

            const mcanvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#mcanvas'));
            const scanvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#scanvas'));
            const contain1 = /** @type {HTMLElement | null} */ (document.querySelector('#contain1'));

            updateLayout();
            syncModuleSize();

            pmContext = createContext({
                ...coreHostContextOptions(config, { isBezelMode, isTransparencyMode, isPresetLocked }),
                canvas: mcanvas,
                secondaryCanvas: scanvas,
                primaryCanvasSelector: '#mcanvas',
                secondaryCanvasSelector: '#scanvas',
                container: contain1 ?? undefined,
                audioSource: 'none',
                audioRouter: audioSourceRouter,
                onRenderWorkerFallback: (reason) => {
                    console.warn('[ProjectM] Render worker unavailable, rendering on the main thread:', reason);
                },
                onError: (detail) => {
                    console.error('[ProjectM] context init error:', detail);
                },
            });
            const context = pmContext;

            await context.start();
            const Module = context.module;

            if (config.rhythmDebug) {
                // ?rhythmDebug=1: log the music's structure as the engine hears it.
                context.on('bar', (event) => {
                    console.info(`[ProjectM] bar  beat #${event.beatIndex}  ${event.bpm.toFixed(1)} BPM  confidence ${event.confidence.toFixed(2)}`);
                });
                context.on('section', (event) => {
                    console.info(`[ProjectM] section ${event.sectionIndex} at beat #${event.beatIndex}`);
                });
            }

            flushQueuedExternalPCM();
            applyTransparencyDomState(isTransparencyMode);

            // The panels below read and write engine state through a module
            // object on this thread: the preset dev tools and the experimental
            // bridge. In the worker topology there is no such object here, so
            // they stay unbuilt rather than throwing (?renderWorker=0 brings
            // them back). The perf HUD and the FBO-format banner are diagnostics
            // for the topology we ship, so they run on the transport in both.
            if (Module) {
                // Give the baked EM_JS worklet handler its host implementation,
                // so it goes through the one PCM ring writer in
                // html/projectm-pcm-ring.js rather than the inline copy compiled
                // into the WASM bundle.
                installHostPcmRingWriter(Module);

                exposeMeshQualityGlobals(setupMeshQuality(Module));
                exposeGovernorGlobals(setupFpsGovernor(Module, {
                    onRenderScaleChange: (scale) => {
                        // Governor v2: shrink the canvas backing store while the
                        // context keeps its CSS display size fixed (see
                        // syncCanvasSize() in projectm-context.js).
                        context.renderScale = scale;
                        context.resize();
                    },
                }));
                const fboFormat = setupFboFormatIndicator(Module);
                exposeFboFormatGlobals(() => fboFormat);
                setupPerfTools(Module);
                exposePresetDevGlobals(setupPresetDevTools(Module, { startTransitionWhenReady }));
                exposeExperimentalGlobals(setupExperimentalBridge(Module));
                setupAudioTestPanel(() => getModule());
            } else {
                // ?perfhud=1 / ?benchmark=1: frames are relayed from the worker.
                const transport = /** @type {import('./projectm-transport-types.ts').RenderTransport} */ (context.transport);
                setupTransportPerfTools(transport);
                const workerHandle = transport.workerHandle;
                if (workerHandle) {
                    const fboFormat = setupWorkerFboFormatIndicator(workerHandle);
                    exposeFboFormatGlobals(() => fboFormat.format());
                }
                console.info('[ProjectM] Rendering in the render worker; the preset dev tools and experimental bridge are inactive (use ?renderWorker=0 for them).');
            }

            if (!startupPresetsLoaded) {
                startupPresetsLoaded = true;
                if (!weeksOnFireMode) {
                    await loadStartupPresets(context, Module);
                } else {
                    console.log('[ProjectM] Weeks on fire: preset playlist seeded by WASM bootstrap');
                }
            }
            startPresetAutoSwitch();
        } catch (err) {
            console.error('projectM initialization failed:', err);
        }
    }

    /**
     * Presets reach the engine through the context in either topology: on the
     * main thread a VFS write plus a call, in the worker the same two steps
     * happen there.
     *
     * @param {ProjectMContext} context
     * @param {ProjectMModule | null} Module
     */
    async function loadStartupPresets(context, Module) {
        const startupResults = (await loadStartupPresetsFromApi({
            apiBase: getConfiguredPresetApiBase(),
            requireDir: true,
            module: Module ?? undefined,
            count: 5,
            updateDisplayMode: 'first',
            writeBytes: presetWriterFor('add'),
        })).filter(isStartupPreset);
        if (startupResults.length === 0) return;
        if (Module && Module.FS) {
            loadPresetFile(Module, startupResults[0].vfsPath);
            updatePresetDisplay(startupResults[0].filename);
            for (let i = 1; i < startupResults.length; i++) {
                addPresetFile(Module, startupResults[i].vfsPath);
            }
            return;
        }
        for (let i = 0; i < startupResults.length; i++) {
            const { vfsPath, bytes } = startupResults[i];
            if (!bytes) continue;
            if (i === 0) {
                context.transport?.writePreset?.(vfsPath, bytes);
                updatePresetDisplay(startupResults[0].filename);
            } else {
                context.addPreset(vfsPath, bytes);
            }
        }
    }

    setTimeout(() => {
        void attemptInit();
    }, initDelayMs);

    return {
        actions,
        attemptInit,
        getContext: () => pmContext,
        audioPlayerController,
    };
}

/**
 * loadStartupApiPresets() results that carry their bytes (not bare paths).
 *
 * @template T
 * @param {T | string} entry
 * @returns {entry is T}
 */
function isStartupPreset(entry) {
    return typeof entry !== 'string';
}

/**
 * A local PCM sender for developing the external-PCM bridge without the real
 * players: a generated tone or the microphone, posted the way a player posts.
 */
function createLocalTestSender() {
    /** @type {number | null} */
    let raf = null;
    /** @type {AudioContext | null} */
    let context = null;
    /** @type {BroadcastChannel | null} */
    let channel = null;

    /** @param {boolean} [useMic] */
    async function start(useMic = false) {
        if (raf) {
            console.warn('Test sender already running');
            return;
        }
        const AudioContextCtor = window.AudioContext
            || /** @type {{ webkitAudioContext?: typeof AudioContext }} */ (/** @type {unknown} */ (window)).webkitAudioContext;
        if (!AudioContextCtor) return;
        const audio = new AudioContextCtor();
        context = audio;
        const analyser = audio.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.2;

        if (useMic) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                audio.createMediaStreamSource(stream).connect(analyser);
                console.log('[TestSender] Using microphone input for projectM PCM');
            } catch (e) {
                console.error('Mic access denied, falling back to generated tone', e);
                useMic = false;
            }
        }
        if (!useMic) {
            const osc = audio.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = 110;
            const gain = audio.createGain();
            gain.gain.value = 0.3;
            const filter = audio.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 800;
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(analyser);
            osc.start();
            console.log('[TestSender] Using generated tone (saw + filter) for projectM PCM');
        }

        const bc = new BroadcastChannel('projectm-audio'); // legacy hosts
        channel = bc;
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            const copy = buf.slice(0); // the view is live
            try {
                if (window.opener) window.opener.postMessage({ type: 'pcm', buffer: copy, channels: 1 }, '*');
                if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'pcm', buffer: copy, channels: 1 }, '*');
            } catch { /* cross-origin opener */ }
            try { bc.postMessage({ type: 'pcm', buffer: copy, channels: 1 }); } catch { /* closed */ }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        console.log('%c[projectM Test Sender] Running — PCM is now being sent locally. Call window.stopLocalProjectMTestSender() to stop.', 'color:#0f0');
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        try { channel?.close(); } catch { /* ignore */ }
        try { void context?.close(); } catch { /* ignore */ }
        context = null;
        channel = null;
        console.log('[projectM Test Sender] Stopped');
    }

    return { start, stop };
}

// The page: html/projectm-core.html loads this module and has #mcanvas.
if (typeof document !== 'undefined' && document.getElementById?.('mcanvas') && document.getElementById('panel-container')) {
    startCoreHost();
}
