// app-shell/config.js
//
// The shell's profiles and the URL / localStorage settings it resolves before
// building a ProjectMContext. Pure functions: no DOM, no engine. Re-exported
// from projectm-app-shell.js.

/**
 * @typedef {import('../projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 *
 * @typedef {object} ShellProfile
 * @property {string} name
 * @property {string} log Console prefix.
 * @property {string} weeksTitle document.title in weeks-on-fire mode.
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
 * @property {boolean} presetFailedToast Show a preset the engine could not switch to in the
 *   status toast (it keeps rendering the previous one, so it is a notice, not an error).
 * @property {string[]} chromeIds Faded with the panel.
 */

export const TRANSPARENCY_THRESHOLD = 0.01;
export const LOCK_STORAGE_KEY = 'projectm:presetLocked';
export const TRANSPARENCY_STORAGE_KEY = 'projectm:transparencyMode';

/** @type {Readonly<Record<string, ShellProfile>>} */
export const SHELL_PROFILES = Object.freeze({
    core: {
        name: 'core',
        log: '[ProjectM]',
        weeksTitle: 'Project M — Weeks on Fire',
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
        presetFailedToast: true,
        chromeIds: [],
    },
    panel2: {
        name: 'panel2',
        log: '[B3HD]',
        weeksTitle: 'B3HD • Project M — Weeks on Fire',
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
        presetFailedToast: false,
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
export function readStorage(storage, key) {
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
export function writeStorage(storage, key, value) {
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
 * ?transitionBeats=, ?bpm=, ?switchPhrase=4|8|16, ?dropCut=1, and the beat
 * clock's latency compensation ?rhythmLatency=auto|<ms> (default auto) with
 * the "tap to align" nudge ?rhythmNudge=<ms> (or localStorage
 * rhythmLatencyNudge). The render worker has no `location`/localStorage of
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
    const phrase = parseInt(params.get('switchPhrase') || '', 10);
    const latencyRaw = params.get('rhythmLatency') ?? 'auto';
    const latencyMs = parseFloat(latencyRaw);
    const nudge = parseFloat(params.get('rhythmNudge') ?? readStorage(storage, 'rhythmLatencyNudge') ?? '');
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
        presetSwitchPhrase: Number.isFinite(phrase) && phrase > 1 ? phrase : 0,
        sectionHardCut: params.get('dropCut') === '1',
        rhythmLatency: /** @type {number | 'auto'} */ (
            latencyRaw === 'auto' ? 'auto' : Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0
        ),
        rhythmLatencyNudge: Number.isFinite(nudge) ? nudge : 0,
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
