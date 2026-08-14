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

const DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES = 300;
export const DEFAULT_TRANSITION_DURATION_SEC = 1.5;

let transitionReadyToken = 0;

export function setTransitionDuration(module = currentProjectMModule(), seconds = DEFAULT_TRANSITION_DURATION_SEC) {
    if (!module) return false;
    const sec = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_TRANSITION_DURATION_SEC;
    try {
        transitionSetDuration(module, sec);
        return true;
    } catch {
        return false;
    }
}

function currentProjectMModule() {
    return globalThis.Module;
}

function hasTransitionApi(moduleInstance) {
    return !!(
        moduleInstance &&
        moduleInstance._dual_fbo_is_preset_b_ready &&
        moduleInstance._dual_fbo_is_preset_b_allocated &&
        moduleInstance._dual_fbo_begin_transition &&
        moduleInstance._transition_start
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
 * @param {*} moduleInstance The Emscripten module instance.
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
                if (module._dual_fbo_cancel_transition) {
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
