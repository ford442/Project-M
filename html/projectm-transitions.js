import {
    dualFboBeginTransition,
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
                let allocated = dualFboIsPresetBAllocated(module);
                if (!allocated) {
                    allocated = !!dualFboBeginTransition(module);
                }

                if (allocated && dualFboIsPresetBAllocated(module)) {
                    transitionStart(module);
                    resolve(true);
                    return;
                }
            }

            frames += 1;
            if (frames >= maxFrames) {
                console.warn('[projectM transitions] timed out waiting for preset readiness');
                resolve(false);
                return;
            }

            requestAnimationFrame(poll);
        };

        requestAnimationFrame(poll);
    });
}
