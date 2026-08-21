import {
    dualFboBeginTransition,
    dualFboCancelTransition,
    dualFboIsPresetAAllocated,
    dualFboIsPresetBAllocated,
    dualFboIsPresetBReady,
    transitionIsActive,
    transitionSetDuration,
    transitionStart,
} from './generated/projectm-wasm-api.js';

/**
 * @typedef {import('./projectm-host-types.ts').ProjectMModuleLike} ProjectMModuleLike
 * @typedef {import('./generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 */

const DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES = 300;
export const DEFAULT_TRANSITION_DURATION_SEC = 1.5;

let transitionReadyToken = 0;

/**
 * `transitionSetDuration()` touches only this one export, so it is narrowed
 * separately from the full {@link hasTransitionApi} check.
 *
 * @param {ProjectMModuleLike | null | undefined} moduleInstance
 * @returns {moduleInstance is ProjectMModule}
 */
function canSetTransitionDuration(moduleInstance) {
    return !!moduleInstance?._transition_set_duration;
}

/**
 * @param {ProjectMModuleLike | null | undefined} [module]
 * @param {number} [seconds]
 * @returns {boolean} true if the duration reached the engine.
 */
export function setTransitionDuration(module = currentProjectMModule(), seconds = DEFAULT_TRANSITION_DURATION_SEC) {
    if (!canSetTransitionDuration(module)) return false;
    const sec = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_TRANSITION_DURATION_SEC;
    try {
        transitionSetDuration(module, sec);
        return true;
    } catch {
        return false;
    }
}

/** @returns {ProjectMModuleLike | undefined} */
function currentProjectMModule() {
    return globalThis.Module;
}

/**
 * Narrows the defensively-optional module handle to the full type the generated
 * wrappers require, by feature-detecting every dual-FBO export this module
 * calls. Builds without ENABLE_WASM_TRANSITIONS export none of them.
 *
 * @param {ProjectMModuleLike | null | undefined} moduleInstance
 * @returns {moduleInstance is ProjectMModule}
 */
function hasTransitionApi(moduleInstance) {
    return !!(
        moduleInstance &&
        moduleInstance._dual_fbo_is_preset_b_ready &&
        moduleInstance._dual_fbo_is_preset_b_allocated &&
        moduleInstance._dual_fbo_begin_transition &&
        moduleInstance._transition_start &&
        moduleInstance._transition_is_active
    );
}

/**
 * Whether both ping-pong FBO pairs are live, i.e. `transition_start()` will
 * actually blend rather than bail out into a hard cut.
 *
 * Neither pair is resident at startup, and the preset-A pair is reclaimed again
 * once it has been idle past `dual_fbo_set_idle_release_seconds()`, so a cold
 * start and a long-idle session both need `dual_fbo_begin_transition()` to bring
 * A *and* B up before the blend is armed. `_dual_fbo_is_preset_a_allocated` is
 * absent on bundles built before that export existed; there the B check alone is
 * the best signal available.
 *
 * @param {ProjectMModule} moduleInstance The Emscripten module instance.
 * @returns {boolean} True when the blend can safely be started.
 */
function presetPairsAllocated(moduleInstance) {
    if (!dualFboIsPresetBAllocated(moduleInstance)) {
        return false;
    }
    if (!moduleInstance._dual_fbo_is_preset_a_allocated) {
        return true;
    }
    return dualFboIsPresetAAllocated(moduleInstance);
}

/**
 * Polls until Preset B's shaders are ready, then allocates its FBOs and starts
 * the crossfade. Resolves false if the API is unavailable, the poll times out,
 * or a later call superseded this one.
 *
 * @param {object} [options]
 * @param {ProjectMModuleLike | null} [options.module]
 * @param {number} [options.timeoutFrames]
 * @param {number} [options.durationSec]
 * @returns {Promise<boolean>}
 */
export function startTransitionWhenReady({
    module = currentProjectMModule(),
    timeoutFrames = DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES,
    durationSec = DEFAULT_TRANSITION_DURATION_SEC,
} = {}) {
    setTransitionDuration(module, durationSec);
    if (!hasTransitionApi(module)) {
        console.debug('[projectM transitions] dual-FBO transition API unavailable; keeping legacy preset switch');
        return Promise.resolve(false);
    }

    const token = ++transitionReadyToken;
    const maxFrames = Number.isFinite(timeoutFrames) && timeoutFrames > 0
        ? Math.floor(timeoutFrames)
        : DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES;

    return new Promise((resolve) => {
        let frames = 0;

        const poll = () => {
            if (token !== transitionReadyToken) {
                resolve(false);
                return;
            }

            if (transitionIsActive(module)) {
                resolve(true);
                return;
            }

            if (dualFboIsPresetBReady(module)) {
                // Allocate on demand whenever either pair is missing — on a cold
                // start that is both of them. Re-verify afterwards so a partial
                // or failed allocation keeps polling instead of arming a blend
                // that would silently degrade into a hard cut.
                let allocated = presetPairsAllocated(module);
                if (!allocated) {
                    allocated = !!dualFboBeginTransition(module);
                }

                if (allocated && presetPairsAllocated(module)) {
                    transitionStart(module);
                    resolve(true);
                    return;
                }
            }

            frames += 1;
            if (frames >= maxFrames) {
                console.warn('[projectM transitions] timed out waiting for preset readiness');
                // The poll may have already allocated the FBO pairs for a
                // transition that will now never start. Hand them back, or they
                // stay resident until some later transition happens to reuse
                // them (the engine only reclaims preset A once preset B is gone).
                if (typeof module._dual_fbo_cancel_transition === 'function') {
                    dualFboCancelTransition(module);
                }
                resolve(false);
                return;
            }

            requestAnimationFrame(poll);
        };

        requestAnimationFrame(poll);
    });
}
