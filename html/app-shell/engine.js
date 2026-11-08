// app-shell/engine.js
//
// Building the ProjectMContext's options from the profile and the URL, and
// wiring a context once it has started (console handles, rhythm logging,
// textures, dev tools, the preset auto-switch timer).

import { PRESET_SWITCH_FAILED } from '../projectm-context.js';
import { flushQueuedExternalPCM } from '../projectm-external-pcm.js';
import { claimGlobal } from '../projectm-globals.js';
import { loadPageTextures } from '../projectm-textures.js';
import {
    resolveContextAttributes,
    resolvePresetAutoSwitchMs,
    resolveRenderConfig,
    TRANSPARENCY_THRESHOLD,
} from './config.js';
import { ownDevTools } from './dev-tools.js';

/**
 * @typedef {import('../projectm-context-types.ts').ProjectMContextOptions} ProjectMContextOptions
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-context.js').ProjectMContext} ProjectMContext
 * @typedef {import('../projectm-app-shell-ui.js').ShellUi} ShellUi
 * @typedef {import('./config.js').ShellProfile} ShellProfile
 *
 * @typedef {object} ShellEngineDeps
 * @property {ShellProfile} profile
 * @property {string} log
 * @property {Document} documentRef
 * @property {Window & typeof globalThis} windowRef
 * @property {URLSearchParams} params
 * @property {Storage | null} storage
 * @property {{ bezel: boolean, locked: boolean, transparent: boolean }} state
 * @property {() => ShellUi} getUi
 * @property {ReturnType<typeof import('../projectm-audio-source-router.js').createAudioSourceRouter> | null} audioRouter
 * @property {string} baseUrl
 * @property {() => string | undefined} getWasmVersion
 * @property {Partial<ProjectMContextOptions> | undefined} overrides
 * @property {boolean} weeksOnFire
 * @property {() => void} randomRemote
 * @property {() => ProjectMModule | undefined} getModule
 */

/**
 * @param {ShellEngineDeps} deps
 * @returns {ProjectMContextOptions}
 */
export function buildContextOptions({
    profile,
    log,
    documentRef,
    windowRef,
    params,
    storage,
    state,
    getUi,
    audioRouter,
    baseUrl,
    getWasmVersion,
    overrides,
}) {
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
        onError: (detail) => {
            // A preset the engine could not switch to: it keeps rendering the
            // previous one, so this is a passing notice, not an init error.
            if (detail.code === PRESET_SWITCH_FAILED) {
                if (profile.presetFailedToast) {
                    const preset = String(
                        /** @type {{ preset?: string }} */ (detail.error ?? {}).preset ?? detail.message
                    );
                    getUi().showStatus(`Preset failed: ${preset.split('/').pop() || preset}`, 'error', 4000);
                }
                return;
            }
            console.error(`${log} context init error:`, detail);
        },
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
        config.wasmVersion = getWasmVersion();
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
            rhythmLatency: render.rhythmLatency,
            rhythmLatencyNudge: render.rhythmLatencyNudge,
            presetSwitchPhrase: render.presetSwitchPhrase,
            sectionHardCut: render.sectionHardCut,
            onRenderWorkerFallback: (/** @type {string} */ reason) => {
                console.warn(`${log} Render worker unavailable, rendering on the main thread:`, reason);
            },
        });
    }
    return { ...config, ...overrides };
}

/**
 * `?liveTex=1` (docs/LIVE_INPUT.md): a camera or a video file into a live
 * texture presets sample by name. The module is only fetched when asked for.
 * Resolves once the texture is registered, which must happen before the
 * startup presets load, or they bind the placeholder instead.
 *
 * @param {ProjectMContext} context
 * @param {ShellEngineDeps} deps
 * @returns {Promise<void>}
 */
export async function wireLiveTexture(context, deps) {
    const { profile, log, documentRef, windowRef, params } = deps;
    if (!profile.urlContextConfig || !/^(1|true)$/.test(params.get('liveTex') ?? '')) {
        return;
    }
    const { resolveLiveTextureConfig, setupLiveTextureSource } = await import('../projectm-live-texture-source.js');
    const config = resolveLiveTextureConfig(params);
    if (!config || context.destroyed) {
        return;
    }
    const source = context.own(
        setupLiveTextureSource(context, config, { documentRef, windowRef, navigatorRef: windowRef.navigator, log })
    );
    // Synchronous on the main thread, one round trip in the worker topology.
    await source.registered;
}

/**
 * @param {ProjectMContext} context
 * @param {ShellEngineDeps} deps
 */
export function wireStartedContext(context, deps) {
    const { profile, log, documentRef, windowRef, params, state, weeksOnFire, randomRemote, getModule } = deps;
    const ui = deps.getUi();
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
    // The engine only reports; the page fetches. Main-thread engines get the
    // page's textures (the render worker's VFS is not reachable from here).
    void loadPageTextures({ module: context.module ?? undefined, documentRef, windowRef });
    if (profile.transparency) ui.setTransparency(state.transparent);
    if (profile.devTools) ownDevTools(context, { log, documentRef, getModule });
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
