// WasmDualFbo.cpp
//
// Dual ping-pong FBO lifecycle and preset-crossfade transition controller
// exports. The dual-FBO manager, compositing shader and transition timeline are
// members of each WasmHost, so every engine crossfades independently; the
// exports act on the active host (set_active_host(), or the render loop).
// render_frame() (WasmRenderLoop.cpp) drives the blend itself once
// transition_start() has armed it, and reclaims the idle Preset A pair.
//
//   dual_fbo_begin_transition()  – lazily allocate Preset A/B FBOs (call once)
//   dual_fbo_cancel_transition() – release Preset B FBOs without promoting
//   dual_fbo_is_preset_{a,b}_allocated(), dual_fbo_is_preset_b_ready()
//   dual_fbo_get_format()        – 0=RGBA16F, 1=RGBA32F, 2=RGBA8 (FboFloatFormat)
//   transition_start() / transition_is_active() / transition_set_duration()
//
// Test hooks (debug_ prefix, exported with PROJECTM_WASM_DEBUG_EXPORTS=1):
//   debug_dual_fbo_end_transition()   – promote Preset B → Preset A now
//   debug_dual_fbo_render_preset_{a,b}() – render one preset into its Write FBO
#include "WasmHost.hpp"

extern "C" {

/**
 * @brief Lazily allocates both ping-pong FBO pairs to start a transition.
 *
 * Neither pair is allocated at startup, so on a cold start this call brings up
 * Preset A *and* Preset B. Dimensions come from the viewport recorded by
 * start_render() via DualPingPongFramebuffer::Resize(), which is why that call
 * must have run first — hence the w/h guard below.
 *
 * The host must treat a @c false return as "not ready yet" and retry on a later
 * frame rather than starting the blend: transition_start() without both pairs
 * live degrades the crossfade into a hard cut.
 *
 * Safe to call when a transition is already active (no-op in that case).
 *
 * @return true when both Preset A and Preset B pairs are allocated.
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_begin_transition()
{
    DualPingPongFramebuffer& dualFbo = Host().dualFbo;
    const int w = dualFbo.Width();
    const int h = dualFbo.Height();
    if (w <= 0 || h <= 0)
    {
        LOG_WARN("dual_fbo_begin_transition: viewport size unknown (start_render() has not run)");
        return false;
    }

    // Remember whether this call is what brought Preset A up, so a Preset B
    // failure below can unwind it instead of leaving a resident pair that
    // nothing will ever sample.
    const bool allocatedAHere = !dualFbo.IsPresetAAllocated();
    if (allocatedAHere && !dualFbo.AllocatePresetA(w, h))
    {
        return false;
    }

    if (!dualFbo.AllocatePresetB(w, h))
    {
        if (allocatedAHere)
        {
            dualFbo.ReleasePresetA();
        }
        return false;
    }
    return true;
}

/**
 * @brief Cancels an in-progress transition and releases Preset B FBOs.
 *
 * Also the abandon path for a transition that was allocated but never armed
 * (host gave up waiting for the incoming preset's shaders). Starts the Preset A
 * idle clock so the pair this transition brought up does not stay resident for
 * the rest of the session.
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_cancel_transition()
{
    WasmHost& H = Host();
    H.dualFbo.ReleasePresetB();
    H.transitionEndTime = WasmNow();
}

/**
 * @brief Returns true if the Preset B FBOs are currently allocated
 *        (i.e., a transition is in progress).
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_is_preset_b_allocated()
{
    return Host().dualFbo.IsPresetBAllocated();
}

/**
 * @brief Returns true if the Preset A FBOs are currently allocated.
 *
 * False at startup and again after the idle grace period following a
 * transition — the pair is crossfade scratch, not a steady-state render target.
 * The host must confirm this (alongside dual_fbo_is_preset_b_allocated()) before
 * calling transition_start(), or the blend silently degrades to a hard cut.
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_is_preset_a_allocated()
{
    return Host().dualFbo.IsPresetAAllocated();
}

/**
 * @brief Phase 4: Returns true when the incoming preset's shaders have been
 *        compiled and linked successfully.
 *
 * JavaScript must poll this function and confirm it returns @c true before
 * calling @c dual_fbo_begin_transition() to start the visual blend.  This
 * ensures the transition compositing never samples an incompletely linked
 * shader program.
 *
 * The flag is set to @c false at the start of every @c load_preset_file() call
 * and to @c true once the projectm-playlist preset-switched callback fires
 * (which runs only after @c GL_LINK_STATUS == GL_TRUE has been confirmed
 * inside @c Shader::CompileProgram).
 *
 * @return @c true  – the new preset is fully compiled; safe to begin blending.
 * @return @c false – preset loading is still in progress; do NOT start blend.
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_is_preset_b_ready()
{
    return Host().presetBReady;
}

/**
 * @brief Returns the active FBO colour format as an integer.
 *
 * Values (FboFloatFormat — the same numbering create_host_with_config() takes
 * for its fboPrecision preference):
 *   0 = RGBA16F (GL_RGBA16F, 16-bit half-float)
 *   1 = RGBA32F (GL_RGBA32F, 32-bit float)
 *   2 = RGBA8   (GL_RGBA8, 8-bit normalized – shaders should clamp output)
 */
EMSCRIPTEN_KEEPALIVE
int dual_fbo_get_format()
{
    return static_cast<int>(Host().dualFbo.GetFormat());
}

/**
 * @brief Starts the visual crossfade blend from Preset A to Preset B.
 *
 * Prerequisites before calling this function:
 *   1. dual_fbo_begin_transition() must have been called (Preset B FBOs allocated).
 *   2. dual_fbo_is_preset_b_ready() must return true (shaders compiled).
 *   3. At least one Preset B frame should have been rendered to warm up the pipeline.
 *
 * If transition duration is 0, an immediate hard cut is performed.
 */
EMSCRIPTEN_KEEPALIVE
void transition_start()
{
    WasmHost& H = Host();
    if (!H.dualFbo.IsPresetAAllocated() || !H.dualFbo.IsPresetBAllocated())
    {
        LOG_WARN(WasmLogFormat("transition_start: dual FBOs not allocated (A=%d, B=%d); call dual_fbo_begin_transition() first",
                               static_cast<int>(H.dualFbo.IsPresetAAllocated()),
                               static_cast<int>(H.dualFbo.IsPresetBAllocated())));
        return;
    }
    if (!H.compositorShader.IsInitialized())
    {
        // ShouldUseDualFboCompositor() would reject every frame, so arming the
        // blend here would wedge transitionActive at true forever: the blend
        // timer only advances inside the compositor branch of render_frame(),
        // so B would never be promoted and both pairs would stay resident for
        // the rest of the session. Fall back to an explicit hard cut instead.
        LOG_WARN("transition_start: compositor unavailable; hard-cutting to preset B");
        H.dualFbo.PromoteBtoA();
        H.transitionBlend = 0.0f;
        H.transitionActive = false;
        H.presetBReady = false;
        H.transitionEndTime = WasmNow();
        return;
    }
    H.transitionBlend = 0.0f;
    H.transitionStartTime = WasmNow(); // milliseconds
    H.transitionActive = true;
    // transition_set_duration_beats() is resolved against the tempo now, once: a
    // tempo change mid-crossfade must not make the blend jump.
    H.activeTransitionDuration = ResolveTransitionDuration(H);
    LOG_DEBUG(WasmLogFormat("Transition started (%.2f s, configured %.2f s)",
                            static_cast<double>(H.activeTransitionDuration),
                            static_cast<double>(H.transitionDuration)));
}

/**
 * @brief Returns true while a crossfade blend is in progress.
 */
EMSCRIPTEN_KEEPALIVE
bool transition_is_active()
{
    return Host().transitionActive;
}

/**
 * @brief Sets the crossfade duration in seconds.
 *
 * Pass 0.0 to enable hard cuts (instant preset switch with no blend).
 *
 * @param seconds Duration of the blend in seconds (≥ 0).
 */
EMSCRIPTEN_KEEPALIVE
void transition_set_duration(float seconds)
{
    Host().transitionDuration = seconds >= 0.0f ? seconds : 0.0f;
}

// ---- Test hooks (PROJECTM_WASM_DEBUG_EXPORTS) -------------------------------

/**
 * @brief Completes a transition now by promoting Preset B's FBOs into Preset A.
 *
 * Old Preset A resources are freed; Preset B's resources become the new
 * Preset A. render_frame() does this itself when a blend reaches 1.
 */
EMSCRIPTEN_KEEPALIVE
void debug_dual_fbo_end_transition()
{
    WasmHost& H = Host();
    H.dualFbo.PromoteBtoA();
    // Preset A is idle again from here; render_frame() reclaims it after the
    // idle grace period.
    H.transitionEndTime = WasmNow();
}

/**
 * @brief Renders the current projectM frame into Preset A's Write FBO, with
 *        full GL state save/restore isolation.
 */
EMSCRIPTEN_KEEPALIVE
void debug_dual_fbo_render_preset_a()
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr || !H.dualFbo.IsPresetAAllocated())
    {
        return;
    }
    GLStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
    projectm_opengl_render_frame_fbo(engine, H.dualFbo.GetAWriteFBO());
}

/**
 * @brief Renders the current projectM frame into Preset B's Write FBO.
 *
 * Before rendering, gl_reset_state_between_pipelines() eliminates any additive
 * blend or texture state left by Preset A's draw – the "white screen" /
 * additive bleed artefacts.
 */
EMSCRIPTEN_KEEPALIVE
void debug_dual_fbo_render_preset_b()
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr || !H.dualFbo.IsPresetBAllocated())
    {
        return;
    }
    gl_reset_state_between_pipelines();
    GLStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
    projectm_opengl_render_frame_fbo(engine, H.dualFbo.GetBWriteFBO());
}

} // extern "C"
