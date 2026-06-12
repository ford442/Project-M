const DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES = 300;

let transitionReadyToken = 0;

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
    timeoutFrames = DEFAULT_TRANSITION_READY_TIMEOUT_FRAMES
} = {}) {
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

            if (module._transition_is_active && module._transition_is_active()) {
                resolve(true);
                return;
            }

            if (module._dual_fbo_is_preset_b_ready()) {
                let allocated = module._dual_fbo_is_preset_b_allocated();
                if (!allocated) {
                    allocated = !!module._dual_fbo_begin_transition();
                }

                if (allocated && module._dual_fbo_is_preset_b_allocated()) {
                    module._transition_start();
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
