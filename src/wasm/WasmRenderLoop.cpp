// WasmRenderLoop.cpp
//
// The per-frame path of the Emscripten host: the Emscripten main loop, the
// GL state that start_render() establishes once for it, the dual-FBO
// compositor decision, and render_frame() itself.
//
// Two callers drive this. start_render() registers renderLoop() as the
// Emscripten main loop for the classic in-page host; the render worker
// (html/projectm-render-worker.js) instead pauses that loop — see
// set_render_loop_paused() in WasmDeterminism.cpp — and calls render_frame()
// from its own loop. Everything that must happen once per rendered frame
// therefore lives in render_frame(), not renderLoop(); renderLoop() only adds
// the perf-HUD instrumentation and quality governor, which are main-loop
// concerns.
//
// Engine lifecycle (init/destruct/rebind) and AppData ownership live in
// projectM_emscripten.cpp; the FBO/compositor classes live in WasmGraphics.hpp
// and their exports in WasmDualFbo.cpp.
#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"
#include "WasmWebGLContext.hpp"

static void renderLoop()
{
    if (app_data.loading == EM_TRUE)
    {
        g_wasLoading = true;
        return;
    }
    if (g_wasLoading)
    {
        g_wasLoading = false;
        g_postLoadGraceFrames = kPostLoadGraceFrames;
        ResetGovernorCounters();
    }
    // Real clock, deliberately: this measures how long the frame actually took,
    // which is what the governor steps quality on. WasmNow() may be virtual.
    const double frameStartMs = emscripten_get_now();
    // Phase 5: Route through render_frame(). Steady-state frames render directly
    // to the canvas; the dual-FBO compositor runs only during preset crossfades.
    if (g_perfHudEnabled)
    {
        js_perf_gpu_begin_frame();
    }
    render_frame();
    if (g_perfHudEnabled)
    {
        js_perf_gpu_end_frame();
    }
    // The compositor (and the legacy fallback) both leave the composited frame
    // in the default framebuffer (FBO 0). The browser presents the canvas directly;
    // no eglSwapBuffers() is required on wasm.
    if (g_perfHudEnabled)
    {
        projectm_perf_frame_timings timings;
        projectm_perf_get_frame_timings(&timings);
        js_perf_report_frame(
            timings.total_ms, timings.audio_analysis_ms, timings.per_frame_eval_ms,
            timings.per_pixel_eval_ms, timings.blur_ms, timings.waveforms_shapes_ms,
            timings.composite_ms, js_perf_gpu_get_last_ms(), timings.fps);
    }
    UpdateQualityGovernor(emscripten_get_now() - frameStartMs);
    return;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void start_render(int width, int height)
{
    // glClearColor( 1.0, 1.0, 1.0, 0.0 );
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    printf("Setting window size: %i x %i\n", width, height);
    glViewport(0, 0, width, height); //  viewport/scissor after UsePrg runs at full resolution
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, width, height);
    glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT, GL_NICEST);
    glHint(GL_GENERATE_MIPMAP_HINT, GL_NICEST);
    // GL_DITHER only affects fixed-function/blit paths on most GLES drivers and
    // is a no-op for the shader-based render passes used here, but in the
    // degraded RGBA8 dual-FBO fallback (DetectFormat() already ran in init())
    // every bit of extra entropy on the final blit helps hide 8-bit banding, so
    // leave it enabled in that case instead of unconditionally disabling it.
    if (g_dualFbo.GetFormat() == FboFloatFormat::RGBA8)
    {
        glEnable(GL_DITHER);
    }
    else
    {
        glDisable(GL_DITHER);
    }
    glFrontFace(GL_CW);
    glCullFace(GL_BACK);
    app_data.loading = EM_FALSE;
    projectm_set_window_size(pm, width, height);
    // Phase 2: Persist dual-FBO dimensions now that the viewport is known.
    // Preset A/B textures are lazily allocated on first transition request.
    g_dualFbo.Resize(width, height);
    // Phase 5: Compile and link the compositing blend shader now that the GL
    // context is current.
    if (!g_compositorShader.Init())
    {
        fprintf(stderr, "start_render: CompositingBlendShader failed to initialise – transitions will be unavailable.\n");
    }
    emscripten_set_main_loop(renderLoop, 0, 0);


    emscripten_set_main_loop_timing(2, 1);


    return;
}
} // extern "C"

// Returns true when the dual-FBO compositor path is required this frame.
// Steady-state playback renders directly to the canvas (one pass); the
// offscreen ping-pong FBO + fullscreen compositor blit is only used while a
// preset crossfade is active.
static bool ShouldUseDualFboCompositor()
{
    return g_transitionActive &&
           g_dualFbo.IsPresetAAllocated() &&
           g_dualFbo.IsPresetBAllocated() &&
           g_compositorShader.IsInitialized();
}

// Reclaims the Preset A ping-pong pair once it has been idle long enough.
//
// Preset A only ever feeds the crossfade compositor. Between transitions
// render_frame() renders straight to the default framebuffer and never samples
// it, so a resident pair is ~14 MB of VRAM (1280x720 RGBA16F; ~31 MB at
// 1920x1080) that nothing reads for the rest of the session. The grace period
// keeps back-to-back preset switches from thrashing glTexImage2D; hosts can tune
// or disable it via dual_fbo_set_idle_release_seconds().
static void ReleaseDualFboIfIdle()
{
    if (g_dualFboIdleReleaseSec < 0.0f || g_transitionActive || !g_dualFbo.IsPresetAAllocated())
    {
        return;
    }
    // Preset B live without an active blend means a transition is mid-setup:
    // dual_fbo_begin_transition() has run and the host is still polling before
    // transition_start(). Pulling A out from under it would make that
    // transition_start() bail and degrade the crossfade into a hard cut.
    if (g_dualFbo.IsPresetBAllocated())
    {
        return;
    }
    // No transition has ever ended, so nothing has established an idle baseline.
    if (g_transitionEndTime <= 0.0)
    {
        return;
    }
    const double idleMs = WasmNow() - g_transitionEndTime;
    if (idleMs < static_cast<double>(g_dualFboIdleReleaseSec) * 1000.0)
    {
        return;
    }
    g_dualFbo.ReleasePresetA();
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void render_frame()
{
    if (!pm)
        return;

    // Deterministic-clock tick (no-op unless the harness enabled it): pins this
    // frame to N/fps before anything reads the time.
    DeterministicFrameTick();

    // Single audio ingest: drain everything JS producers wrote into the PCM ring
    // since the last frame and hand it to the engine as one stereo block. Done
    // here rather than in renderLoop() so the render-worker path (which drives
    // render_frame() from its own loop) and any host calling render_frame()
    // directly get identical audio, with no window/AnalyserNode involved.
    pcm_ring_drain();

    // Phase 5: Integrated dual-FBO render pipeline (transitions only).
    //
    // When a crossfade is active, the render loop orchestrates:
    //
    //   1. Render Preset A → FBO_A_Write, ping-pong to FBO_A_Read.
    //   2. Render Preset B → FBO_B_Write, ping-pong to FBO_B_Read.
    //   3. Composite to screen: blend FBO_A_Read + FBO_B_Read using uBlend.
    //   4. Advance blend timer; auto-complete when uBlend >= 1.0.
    //
    // Between transitions (the common case), render straight to the default
    // framebuffer via projectm_opengl_render_frame() — the same path used before
    // the dual-FBO work landed — avoiding an extra FBO resolve + fullscreen blit
    // every frame.

    if (!ShouldUseDualFboCompositor())
    {
        // Direct-to-canvas path (steady state, startup, or compositor unavailable).
        ReleaseDualFboIfIdle();
        GLStateGuard guard;
        projectm_opengl_render_frame(pm);
        g_renderedFrameCount++;
        return;
    }

    const int w = g_dualFbo.Width();
    const int h = g_dualFbo.Height();
    const bool ditherOutput = (g_dualFbo.GetFormat() == FboFloatFormat::RGBA8);
    const bool transparencyMode = projectm_get_transparency_mode(pm);
    const float transparencyThreshold = projectm_get_transparency_threshold(pm);

    // --- Step 1: Render Preset A into its Write FBO ---
    // Note: projectm_opengl_render_frame() hardcodes its final composite blit to
    // FBO 0 (the default framebuffer / canvas) regardless of which FBO is bound
    // when called. Use projectm_opengl_render_frame_fbo() so the final composite
    // lands in our Write FBO instead of clobbering the canvas directly.
    {
        GLStateGuard guard;
        projectm_opengl_render_frame_fbo(pm, g_dualFbo.GetAWriteFBO());
    }
    g_dualFbo.SwapPresetA();

    // --- Step 2: Render Preset B into its Write FBO ---
    gl_reset_state_between_pipelines();
    {
        GLStateGuard guard;
        projectm_opengl_render_frame_fbo(pm, g_dualFbo.GetBWriteFBO());
    }
    g_dualFbo.SwapPresetB();

    // --- Step 3: Composite to the default framebuffer (browser canvas) ---
    g_compositorShader.Draw(g_dualFbo.GetAReadTex(), g_dualFbo.GetBReadTex(),
                            g_transitionBlend, w, h, ditherOutput,
                            transparencyMode, transparencyThreshold);

    // --- Step 4: Advance blend timer ---
    float newBlend;
    if (g_transitionDuration <= 0.0f)
    {
        // Hard cut: jump immediately to full B.
        newBlend = 1.0f;
    }
    else
    {
        // Time-based blend (WasmNow() returns milliseconds).
        const double now = WasmNow();
        newBlend = static_cast<float>((now - g_transitionStartTime) / (static_cast<double>(g_transitionDuration) * 1000.0));
    }
    g_transitionBlend = newBlend < 1.0f ? newBlend : 1.0f;

    if (g_transitionBlend >= 1.0f)
    {
        // Transition complete: promote B → A, release B's FBOs, reset state.
        g_dualFbo.PromoteBtoA();
        g_transitionBlend = 0.0f;
        g_transitionActive = false;
        g_presetBReady = false;
        // Start the Preset A idle clock: from here nothing samples the pair
        // until the next transition, so ReleaseDualFboIfIdle() can reclaim it.
        g_transitionEndTime = WasmNow();
        fprintf(stderr, "Phase5: Transition complete – Preset B promoted to A.\n");
    }
    g_renderedFrameCount++;
    return;
}

EMSCRIPTEN_KEEPALIVE
void set_window_size(int width, int height)
{
    if (!pm)
        return;
    WasmWebGLResizeCanvases(width, height);
    glViewport(0, 0, width, height);
    glScissor(0, 0, width, height);
    projectm_set_window_size(pm, width, height);
    // Phase 2: Resize all allocated dual ping-pong FBOs to match the new viewport.
    g_dualFbo.Resize(width, height);
    return;
}
} // extern "C"
