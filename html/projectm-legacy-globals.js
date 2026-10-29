// projectm-legacy-globals.js
//
// The one module in html/ that may assign `window.pm*` convenience globals (and
// the legacy popup-player and BroadcastChannel hooks). It is opt-in: only a page
// that still has inline `onclick="cycleAudioPlayer()"` handlers, a console
// workflow built on `window.pmSetTargetFps(...)`, or glue that posts on
// `new BroadcastChannel('sng')` imports it. Embeds built on ProjectMContext or
// <project-m-visualizer> never load it and touch no page globals for these.
// scripts/check_host_globals.sh fails CI when another html/projectm-*.js starts
// assigning them.
//
// Two tiers of `pm*` names exist, and only one of them is here:
//
//   * Engine callbacks -- `pmOnPerfFrame`, `pmOnGovernor*Change`,
//     `pmOnTranspiledShaderStored`, `pmReportInitError`, `pmHideInitError`,
//     `pmSetPerfHudEnabled`. The WASM glue calls these by name (src/wasm/), so a
//     page cannot opt out of them. The modules that consume them subscribe
//     through projectm-wasm-callbacks.js, which owns the global and fans out.
//
//   * Convenience API -- everything below. Nothing in the engine calls these;
//     they exist for host pages and the console.
//
// Every installer goes through `claimGlobal()`, so two installs do not clobber
// each other, and a disposer only removes what it wrote. Installers take the
// object to publish on (`host`, default `globalThis`, which is `window` in a
// document) so tests and non-window scopes can point them elsewhere.

import { claimGlobal } from './projectm-globals.js';

/**
 * Every name this module may write, for docs and for the tests that pin the
 * shim as the only writer.
 */
export const LEGACY_GLOBAL_NAMES = Object.freeze([
    'pmSetTargetFps',
    'pmSetQualityGovernorEnabled',
    'pmGetQualityTier',
    'pmGetGovernorRenderScale',
    'pmGetGovernorBlurCap',
    'pmSetMeshQuality',
    'pmGetFboFormat',
    'pmReloadPresetText',
    'pmPresetDevEnabled',
    'pmExperimental',
    'cycleAudioPlayer',
    'closeAudioPlayer',
    'flacPlayer',
    'modPlayer',
    'openFlacPlayer',
    'openModPlayer',
    'BroadcastChannel',
]);

/**
 * @param {any} host
 * @param {Record<string, unknown>} entries
 * @returns {() => void} Releases every claim made here.
 */
function claimAll(host, entries) {
    const releases = Object.entries(entries).map(([key, value]) => claimGlobal(host, key, value));
    return () => {
        // Newest first, so overlapping claims unwind in the order they stacked.
        for (const release of releases.reverse()) {
            release();
        }
    };
}

/**
 * `window.pmSetTargetFps` / `pmSetQualityGovernorEnabled` / `pmGetQualityTier` /
 * `pmGetGovernorRenderScale` / `pmGetGovernorBlurCap`, backed by the object
 * `setupFpsGovernor()` returns.
 *
 * @param {import('./projectm-fps-governor.js').FpsGovernorApi} governor
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposeGovernorGlobals(governor, host = globalThis) {
    return claimAll(host, {
        pmSetTargetFps: governor.setTargetFps,
        pmSetQualityGovernorEnabled: governor.setQualityGovernorEnabled,
        pmGetQualityTier: governor.getQualityTier,
        pmGetGovernorRenderScale: governor.getRenderScale,
        pmGetGovernorBlurCap: governor.getBlurCap,
    });
}

/**
 * `window.pmSetMeshQuality`, backed by the object `setupMeshQuality()` returns.
 *
 * @param {{ setQuality: (quality: string) => string }} meshQuality
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposeMeshQualityGlobals(meshQuality, host = globalThis) {
    return claimAll(host, { pmSetMeshQuality: meshQuality.setQuality });
}

/**
 * `window.pmGetFboFormat`.
 *
 * @param {() => string} getFormat Returns 'RGBA32F' | 'RGBA16F' | 'RGBA8'.
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposeFboFormatGlobals(getFormat, host = globalThis) {
    return claimAll(host, { pmGetFboFormat: getFormat });
}

/**
 * `window.pmReloadPresetText` / `pmPresetDevEnabled`, from the result of
 * `setupPresetDevTools()`. Does nothing when the dev tools are not enabled.
 *
 * @param {{ enabled: boolean, reloadFromText?: unknown }} presetDev
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposePresetDevGlobals(presetDev, host = globalThis) {
    if (!presetDev?.enabled) {
        return () => {};
    }
    return claimAll(host, {
        pmReloadPresetText: presetDev.reloadFromText,
        pmPresetDevEnabled: true,
    });
}

/**
 * `window.pmExperimental`, from the result of `setupExperimentalBridge()`. Does
 * nothing when the bridge is not enabled.
 *
 * @param {{ enabled: boolean, api?: unknown }} experimental
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposeExperimentalGlobals(experimental, host = globalThis) {
    if (!experimental?.enabled || !experimental.api) {
        return () => {};
    }
    return claimAll(host, { pmExperimental: experimental.api });
}

/**
 * The inline-`onclick` names of the legacy panel hosts: `cycleAudioPlayer`,
 * `closeAudioPlayer`, `flacPlayer`, `modPlayer`, and -- when the controller has
 * them, as the popup controller does -- `openFlacPlayer` / `openModPlayer`.
 *
 * @param {import('./projectm-audio-player.js').AudioPlayerController} controller
 * @param {any} [host]
 * @returns {() => void}
 */
export function exposeAudioPlayerGlobals(controller, host = globalThis) {
    /** @type {Record<string, unknown>} */
    const entries = {
        cycleAudioPlayer: controller.cycleAudioPlayer,
        closeAudioPlayer: controller.closeAudioPlayer,
        flacPlayer: () => controller.showAudioPlayer('flac'),
        modPlayer: () => controller.showAudioPlayer('mod'),
    };
    if (controller.openFlacPlayer) {
        entries.openFlacPlayer = controller.openFlacPlayer;
    }
    if (controller.openModPlayer) {
        entries.openModPlayer = controller.openModPlayer;
    }
    return claimAll(host, entries);
}

/**
 * Replace `host.BroadcastChannel` with a constructor that runs every channel it
 * creates through `wrap`. This is the monkey-patch the song loader used to apply
 * on its own; it is here so that affecting every script on the page is a
 * decision a host makes, not a side effect of importing a module.
 *
 * The replacement carries a `projectMNativeBroadcastChannel` property pointing at
 * the real constructor, so code that needs an unwrapped channel (the song
 * loader's legacy ./flac/ post) can look through it. Patching again replaces the
 * earlier wrapper rather than stacking on it (both look through to the real
 * constructor, so one adapter can never wrap a channel twice); the earlier one
 * takes over again when the newer one is disposed. Disposing restores the real
 * constructor unless something else has replaced it since.
 *
 * @param {(name: string, channel: BroadcastChannel) => BroadcastChannel} wrap
 *   For the song loader, `wrapSongChannel` from projectm-song-loader.js.
 * @param {any} [host]
 * @returns {() => void}
 */
export function patchBroadcastChannel(wrap, host = globalThis) {
    const Native = host.BroadcastChannel;
    if (typeof Native !== 'function') {
        return () => {};
    }
    const NativeCtor = Native.projectMNativeBroadcastChannel ?? Native;

    /**
     * @param {string} name
     * @returns {BroadcastChannel}
     */
    function PatchedBroadcastChannel(name) {
        return wrap(name, new NativeCtor(name));
    }
    // Callable-as-constructor: the function returns the wrapped channel, so
    // `new PatchedBroadcastChannel(...)` yields it in place of the implicit this.
    PatchedBroadcastChannel.prototype = NativeCtor.prototype;
    /** @type {any} */ (PatchedBroadcastChannel).projectMNativeBroadcastChannel = NativeCtor;

    return claimGlobal(host, 'BroadcastChannel', PatchedBroadcastChannel);
}

/**
 * Install any subset of the legacy globals in one call and get one disposer
 * back. Each entry is optional; pass only what the page has.
 *
 * Hosts whose pieces come up at different times (the governor needs a booted
 * module) can call the individual `expose*` installers where they used to call
 * the setup functions instead.
 *
 * @param {object} [options]
 * @param {any} [options.host] Object to publish on. Defaults to `globalThis`.
 * @param {import('./projectm-fps-governor.js').FpsGovernorApi} [options.governor]
 * @param {{ setQuality: (quality: string) => string }} [options.meshQuality]
 * @param {() => string} [options.fboFormat]
 * @param {{ enabled: boolean, reloadFromText?: unknown }} [options.presetDev]
 * @param {{ enabled: boolean, api?: unknown }} [options.experimental]
 * @param {import('./projectm-audio-player.js').AudioPlayerController} [options.audioPlayer]
 * @param {(name: string, channel: BroadcastChannel) => BroadcastChannel} [options.broadcastChannel]
 *   A `wrap` function; see {@link patchBroadcastChannel}.
 * @returns {() => void} Removes everything this call installed.
 */
export function installLegacyGlobals({
    host = globalThis,
    governor,
    meshQuality,
    fboFormat,
    presetDev,
    experimental,
    audioPlayer,
    broadcastChannel,
} = {}) {
    /** @type {Array<() => void>} */
    const disposers = [];
    if (governor) disposers.push(exposeGovernorGlobals(governor, host));
    if (meshQuality) disposers.push(exposeMeshQualityGlobals(meshQuality, host));
    if (fboFormat) disposers.push(exposeFboFormatGlobals(fboFormat, host));
    if (presetDev) disposers.push(exposePresetDevGlobals(presetDev, host));
    if (experimental) disposers.push(exposeExperimentalGlobals(experimental, host));
    if (audioPlayer) disposers.push(exposeAudioPlayerGlobals(audioPlayer, host));
    if (broadcastChannel) disposers.push(patchBroadcastChannel(broadcastChannel, host));

    return () => {
        for (const dispose of disposers.reverse()) {
            dispose();
        }
    };
}
