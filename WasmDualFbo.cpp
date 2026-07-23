// WasmDualFbo.cpp
//
// Dual ping-pong FBO lifecycle and preset-crossfade transition controller.
// Owns the shared g_dualFbo / g_compositorShader instances and the transition
// timeline state. Exposes the dual_fbo_* and transition_* EMSCRIPTEN_KEEPALIVE
// C exports that JavaScript drives during a preset crossfade.
#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"

// Global dual ping-pong FBO manager instance (Emscripten/WASM build only).
DualPingPongFramebuffer g_dualFbo;

// Global compositing shader instance (Emscripten/WASM build only).
CompositingBlendShader g_compositorShader;

// =============================================================================
// Phase 5: Transition Controller State
//
// Manages the blend timeline that crossfades Preset A -> Preset B.
// =============================================================================
float  g_transitionDuration  = 3.0f;  //!< Crossfade duration in seconds (default 3 s).
bool   g_transitionActive    = false; //!< Whether a blend is currently in progress.
float  g_transitionBlend     = 0.0f;  //!< Current blend value in [0.0, 1.0].
double g_transitionStartTime = 0.0;   //!< emscripten_get_now() timestamp (ms) at blend start.

// =============================================================================
// Phase 2 + Phase 3: Dual ping-pong FBO lifecycle C API (EMSCRIPTEN_KEEPALIVE exports)
//
// These functions are the public interface for JavaScript / the transition
// layer to drive the dual FBO system:
//
//   dual_fbo_begin_transition()  – allocate Preset B FBOs (lazy, call once)
//   dual_fbo_end_transition()    – promote Preset B → Preset A (transition done)
//   dual_fbo_cancel_transition() – release Preset B FBOs without promoting
//   dual_fbo_swap_preset_a()     – ping-pong Preset A Read/Write each frame
//   dual_fbo_swap_preset_b()     – ping-pong Preset B Read/Write each frame
//   dual_fbo_get_a_read_fbo()    – FBO ID to bind as render target (Preset A)
//   dual_fbo_get_a_read_tex()    – texture ID to sample as history (Preset A)
//   dual_fbo_get_b_write_fbo()   – FBO ID to bind as render target (Preset B)
//   dual_fbo_get_b_read_tex()    – texture ID to sample as history (Preset B)
//   dual_fbo_is_preset_b_allocated() – query whether transition is active
//   dual_fbo_get_format()        – 0=RGBA32F, 1=RGBA16F, 2=RGBA8
//
// Phase 3 isolated render helpers (save/restore full GL state):
//   dual_fbo_render_preset_a()   – render Preset A into A_Write FBO w/ state guard
//   dual_fbo_render_preset_b()   – force-reset GL, render Preset B into B_Write FBO
// =============================================================================
extern "C" {

/**
 * @brief Lazily allocates Preset B ping-pong FBOs to start a transition.
 *
 * Uses the current Preset A dimensions.  Safe to call when a transition is
 * already active (no-op in that case).
 *
 * @return true on success.
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_begin_transition()
{
    int w = g_dualFbo.Width();
    int h = g_dualFbo.Height();
    if (w <= 0 || h <= 0)
    {
        fprintf(stderr, "DualFBO: Cannot begin transition – Preset A FBOs not allocated.\n");
        return false;
    }
    return g_dualFbo.AllocatePresetB(w, h);
}

/**
 * @brief Completes a transition by promoting Preset B's FBOs into Preset A.
 *
 * Old Preset A resources are freed; Preset B's resources become the new
 * Preset A. After this call Preset B is no longer allocated.
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_end_transition()
{
    g_dualFbo.PromoteBtoA();
}

/**
 * @brief Cancels an in-progress transition and releases Preset B FBOs.
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_cancel_transition()
{
    g_dualFbo.ReleasePresetB();
}

/**
 * @brief Swaps Preset A's Read/Write FBOs (call once per rendered frame).
 *
 * After the swap the former Write texture becomes the Read (history) texture
 * for the next frame, implementing the ping-pong feedback loop.
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_swap_preset_a()
{
    g_dualFbo.SwapPresetA();
}

/**
 * @brief Swaps Preset B's Read/Write FBOs (call once per rendered frame during a transition).
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_swap_preset_b()
{
    g_dualFbo.SwapPresetB();
}

// ---- Accessor functions (return raw OpenGL / WebGL handles) ----------------

/** @brief Returns the Preset A Read FBO ID (bind as render target). */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_a_read_fbo()   { return g_dualFbo.GetAReadFBO(); }

/** @brief Returns the Preset A Write FBO ID. */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_a_write_fbo()  { return g_dualFbo.GetAWriteFBO(); }

/** @brief Returns the Preset A Read texture ID (sample as history/feedback). */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_a_read_tex()   { return g_dualFbo.GetAReadTex(); }

/** @brief Returns the Preset A Write texture ID. */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_a_write_tex()  { return g_dualFbo.GetAWriteTex(); }

/** @brief Returns the Preset B Read FBO ID (bind as render target). */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_b_read_fbo()   { return g_dualFbo.GetBReadFBO(); }

/** @brief Returns the Preset B Write FBO ID. */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_b_write_fbo()  { return g_dualFbo.GetBWriteFBO(); }

/** @brief Returns the Preset B Read texture ID (sample as history/feedback). */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_b_read_tex()   { return g_dualFbo.GetBReadTex(); }

/** @brief Returns the Preset B Write texture ID. */
EMSCRIPTEN_KEEPALIVE
GLuint dual_fbo_get_b_write_tex()  { return g_dualFbo.GetBWriteTex(); }

/**
 * @brief Returns true if the Preset B FBOs are currently allocated
 *        (i.e., a transition is in progress).
 */
EMSCRIPTEN_KEEPALIVE
bool dual_fbo_is_preset_b_allocated()
{
    return g_dualFbo.IsPresetBAllocated();
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
    return g_presetBReady;
}

/**
 * @brief Returns the active FBO colour format as an integer.
 *
 * Values:
 *   0 = RGBA32F (GL_RGBA32F, 32-bit float)
 *   1 = RGBA16F (GL_RGBA16F, 16-bit half-float)
 *   2 = RGBA8   (GL_RGBA8, 8-bit normalized – shaders should clamp output)
 */
EMSCRIPTEN_KEEPALIVE
int dual_fbo_get_format()
{
    return static_cast<int>(g_dualFbo.GetFormat());
}

// ---- Phase 3: isolated render helpers --------------------------------------

/**
 * @brief Renders the current projectM frame for Preset A with full GL state
 *        save/restore isolation.
 *
 * Binds Preset A's Write FBO before rendering so that projectM's output is
 * captured into the dual FBO system. Saves all relevant GL state before the
 * render call and restores it afterward to prevent leakage into subsequent
 * pipeline phases or into the browser's WebGL layer.
 *
 * After this call, swap Preset A's ping-pong FBOs with dual_fbo_swap_preset_a().
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_render_preset_a()
{
    if (!pm || !g_dualFbo.IsPresetAAllocated())
    {
        fprintf(stderr, "dual_fbo_render_preset_a: not ready (pm=%p, presetAAllocated=%d)\n",
                static_cast<void*>(pm), static_cast<int>(g_dualFbo.IsPresetAAllocated()));
        return;
    }
    GLStateGuard guard;
    glBindFramebuffer(GL_FRAMEBUFFER, g_dualFbo.GetAWriteFBO());
    projectm_opengl_render_frame(pm);
}

/**
 * @brief Renders the current projectM frame for Preset B with full GL state
 *        save/restore isolation.
 *
 * Must be called after dual_fbo_render_preset_a() during a transition frame.
 * Before rendering, gl_reset_state_between_pipelines() is called to eliminate
 * any additive blend or texture state left by Preset A's draw – this prevents
 * the "white screen" / additive bleed artefacts.
 *
 * After this call, swap Preset B's ping-pong FBOs with dual_fbo_swap_preset_b().
 */
EMSCRIPTEN_KEEPALIVE
void dual_fbo_render_preset_b()
{
    if (!pm || !g_dualFbo.IsPresetBAllocated())
    {
        fprintf(stderr, "dual_fbo_render_preset_b: not ready (pm=%p, presetBAllocated=%d)\n",
                static_cast<void*>(pm), static_cast<int>(g_dualFbo.IsPresetBAllocated()));
        return;
    }
    // Force-reset GL state left by Preset A's draw before entering Preset B's pipeline.
    gl_reset_state_between_pipelines();
    GLStateGuard guard;
    glBindFramebuffer(GL_FRAMEBUFFER, g_dualFbo.GetBWriteFBO());
    projectm_opengl_render_frame(pm);
}

} // extern "C"

// =============================================================================
// Phase 5: Transition Controller C API
//
// Public C functions that JavaScript calls to drive the blend timeline.
//
//   transition_start()           – start the blend (requires dual_fbo_begin_transition()
//                                  to have been called first and at least one Preset B frame
//                                  to have been rendered to warm up the pipeline)
//   transition_cancel()          – abort an in-progress transition; resets to Preset A
//   transition_is_active()       – returns true while a blend is in progress
//   transition_get_blend()       – returns the current uBlend value in [0.0, 1.0]
//   transition_set_duration()    – set crossfade duration in seconds (0 = hard cut)
//   transition_get_duration()    – return the current crossfade duration
// =============================================================================
extern "C" {

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
    if (!g_dualFbo.IsPresetBAllocated())
    {
        fprintf(stderr, "transition_start: Preset B FBOs not allocated – call dual_fbo_begin_transition() first.\n");
        return;
    }
    g_transitionBlend     = 0.0f;
    g_transitionStartTime = emscripten_get_now(); // milliseconds
    g_transitionActive    = true;
    fprintf(stderr, "Phase5: Transition started (duration=%.2f s).\n",
            static_cast<double>(g_transitionDuration));
}

/**
 * @brief Cancels an in-progress transition and releases Preset B's FBOs.
 *
 * After this call Preset A continues rendering as normal and the blend
 * value is reset to 0.0.
 */
EMSCRIPTEN_KEEPALIVE
void transition_cancel()
{
    if (!g_transitionActive)
    {
        return;
    }
    g_transitionActive = false;
    g_transitionBlend  = 0.0f;
    g_presetBReady     = false;
    g_dualFbo.ReleasePresetB();
    fprintf(stderr, "Phase5: Transition cancelled.\n");
}

/**
 * @brief Returns true while a crossfade blend is in progress.
 */
EMSCRIPTEN_KEEPALIVE
bool transition_is_active()
{
    return g_transitionActive;
}

/**
 * @brief Returns the current blend value in the range [0.0, 1.0].
 *
 * 0.0 = 100 % Preset A, 1.0 = 100 % Preset B.
 */
EMSCRIPTEN_KEEPALIVE
float transition_get_blend()
{
    return g_transitionBlend;
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
    g_transitionDuration = seconds >= 0.0f ? seconds : 0.0f;
    fprintf(stderr, "Phase5: Transition duration set to %.2f s.\n",
            static_cast<double>(g_transitionDuration));
}

/**
 * @brief Returns the current crossfade duration in seconds.
 */
EMSCRIPTEN_KEEPALIVE
float transition_get_duration()
{
    return g_transitionDuration;
}

} // extern "C" (Phase 5)
