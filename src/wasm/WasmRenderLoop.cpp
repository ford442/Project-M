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
#include "WasmGraphics.hpp"
#include "WasmHost.hpp"
#include "WasmWebGLContext.hpp"

// Preset A idle release (see ReleaseDualFboIfIdle()): the pair is reclaimed
// once this many seconds have passed since the last transition ended.
constexpr double kDualFboIdleReleaseSeconds = 5.0;

// Renders one frame for the currently-active host. renderLoop() makes each
// started host active in turn and calls this.
//
// A preset load no longer pauses this: the preset is prepared on the host's
// prepare thread while the current one keeps rendering, and render_frame()
// switches to it once it is ready (see WasmPresetPrepare.cpp).
static void RenderActiveHostFrame(WasmHost& host)
{
    // Real clock, deliberately: this measures how long the frame actually took,
    // which is what the governor steps quality on. WasmNow() may be virtual.
    const double frameStartMs = emscripten_get_now();
    // Phase 5: Route through render_frame(). Steady-state frames render directly
    // to the canvas; the dual-FBO compositor runs only during preset crossfades.
    if (host.perfHudEnabled)
    {
        js_perf_gpu_begin_frame();
    }
    render_frame();
    if (host.perfHudEnabled)
    {
        js_perf_gpu_end_frame();
    }
    // The compositor (and the legacy fallback) both leave the composited frame
    // in the default framebuffer (FBO 0). The browser presents the canvas directly;
    // no eglSwapBuffers() is required on wasm.
    if (host.perfHudEnabled)
    {
        projectm_perf_frame_timings timings;
        projectm_perf_get_frame_timings(&timings);
        js_perf_report_frame(
            EventHostHandle(host), timings.total_ms, timings.audio_analysis_ms, timings.per_frame_eval_ms,
            timings.per_pixel_eval_ms, timings.blur_ms, timings.waveforms_shapes_ms,
            timings.composite_ms, js_perf_gpu_get_last_ms(), timings.fps, timings.shader_link_pending,
            timings.per_pixel_eval_path, timings.rhythm_analysis_ms, FlashClampedFramesForHud(host));
    }
    UpdateQualityGovernor(host, emscripten_get_now() - frameStartMs);
}

// The single Emscripten main loop services every started host. With one host
// (the compat/default path) this is exactly the old single-instance loop; with
// two (#168 Phase B) each is made active — which makes its own WebGL context
// current — and rendered in turn within the same requestAnimationFrame tick.
//
// The host that was active before the tick is restored afterwards. JS selects a
// host with set_active_host() and may then yield (e.g. awaiting IndexedDB
// between shader_cache_begin_load() and shader_cache_import_glsl()); without the
// restore, a rAF tick in between would leave the last-rendered host active and
// the follow-up call would land on the wrong engine.
static void renderLoop()
{
    WasmHost* const previous = ActiveHostOrNull();
    const int slots = HostSlotCount();
    for (int i = 0; i < slots; ++i)
    {
        WasmHost* h = HostSlot(i);
        if (h == nullptr || !h->renderLoopStarted)
        {
            continue;
        }
        SetActiveHost(h);
        RenderActiveHostFrame(*h);
    }
    if (previous != nullptr && ActiveHostOrNull() != previous)
    {
        SetActiveHost(previous);
    }
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void start_render(int width, int height)
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    // No engine means no context to set state on (init() failed, or the
    // context was lost and not yet restored).
    if (engine == nullptr)
    {
        LOG_WARN("start_render: no engine on this host; call init() first");
        return;
    }
    // The canvas only has the buffers its context was created with (depth and
    // stencil are opt-in, see WasmContextConfig); clearing bits it lacks is a
    // no-op at best.
    GLbitfield clearBits = GL_COLOR_BUFFER_BIT;
    if (H.contextConfig.depth != 0)
    {
        clearBits |= GL_DEPTH_BUFFER_BIT;
    }
    if (H.contextConfig.stencil != 0)
    {
        clearBits |= GL_STENCIL_BUFFER_BIT;
    }
    glClear(clearBits);
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
    if (H.dualFbo.GetFormat() == FboFloatFormat::RGBA8)
    {
        glEnable(GL_DITHER);
    }
    else
    {
        glDisable(GL_DITHER);
    }
    glFrontFace(GL_CW);
    glCullFace(GL_BACK);
    // app_data.loading is left alone: it means "a preset preparation is in
    // flight", and starting the render loop does not change that.
    projectm_set_window_size(engine, width, height);
    // Phase 2: Persist dual-FBO dimensions now that the viewport is known.
    // Preset A/B textures are lazily allocated on first transition request.
    H.dualFbo.Resize(width, height);
    // Phase 5: Compile and link the compositing blend shader now that the GL
    // context is current.
    if (!H.compositorShader.Init())
    {
        LOG_ERROR("start_render: CompositingBlendShader failed to initialise; transitions will hard-cut");
    }

    // The state everything above established is what each preset render is
    // put back to (GLStateGuard), so capture it once here instead of reading
    // it back from GL every frame.
    H.glBaseline = GLStateSnapshot::Capture();

    // Opt this host into the shared render loop. Register the process-global
    // Emscripten main loop only once; it then iterates every started host.
    //
    // Paced by requestAnimationFrame, one frame per display refresh: vsync
    // aligned, never rendering frames the compositor will not show, and
    // throttled by the browser in a background tab. (It used to be
    // EM_TIMING_SETIMMEDIATE, which spun as fast as the postMessage shim
    // allowed.) The render worker and the deterministic harness pause this
    // loop and drive render_frame() themselves.
    H.renderLoopStarted = true;
    if (!g_mainLoopRegistered)
    {
        emscripten_set_main_loop(renderLoop, 0, 0);
        emscripten_set_main_loop_timing(EM_TIMING_RAF, 1);
        g_mainLoopRegistered = true;
    }
}

// The shared main loop's Emscripten timing mode (EM_TIMING_RAF = 1), or -1
// before any start_render() registered the loop. Test hook: under a software
// rasteriser a frame costs more than a display refresh, so the frame rate
// alone cannot tell rAF pacing from EM_TIMING_SETIMMEDIATE.
EMSCRIPTEN_KEEPALIVE
int debug_get_main_loop_timing_mode()
{
    if (!g_mainLoopRegistered)
    {
        return -1;
    }
    int mode = 0;
    int value = 0;
    emscripten_get_main_loop_timing(&mode, &value);
    return mode;
}
} // extern "C"

// Returns true when the dual-FBO compositor path is required this frame.
// Steady-state playback renders directly to the canvas (one pass); the
// offscreen ping-pong FBO + fullscreen compositor blit is only used while a
// preset crossfade is active.
static bool ShouldUseDualFboCompositor(const WasmHost& host)
{
    return host.transitionActive &&
           host.dualFbo.IsPresetAAllocated() &&
           host.dualFbo.IsPresetBAllocated() &&
           host.compositorShader.IsInitialized();
}

// Reclaims the Preset A ping-pong pair once it has been idle long enough.
//
// Preset A only ever feeds the crossfade compositor. Between transitions
// render_frame() renders straight to the default framebuffer and never samples
// it, so a resident pair is ~14 MB of VRAM (1280x720 RGBA16F; ~31 MB at
// 1920x1080) that nothing reads for the rest of the session. The grace period
// keeps back-to-back preset switches from thrashing glTexImage2D.
static void ReleaseDualFboIfIdle(WasmHost& host)
{
    if (host.transitionActive || !host.dualFbo.IsPresetAAllocated())
    {
        return;
    }
    // Preset B live without an active blend means a transition is mid-setup:
    // dual_fbo_begin_transition() has run and the host is still polling before
    // transition_start(). Pulling A out from under it would make that
    // transition_start() bail and degrade the crossfade into a hard cut.
    if (host.dualFbo.IsPresetBAllocated())
    {
        return;
    }
    // No transition has ever ended, so nothing has established an idle baseline.
    if (host.transitionEndTime <= 0.0)
    {
        return;
    }
    const double idleMs = WasmNow() - host.transitionEndTime;
    if (idleMs < kDualFboIdleReleaseSeconds * 1000.0)
    {
        return;
    }
    host.dualFbo.ReleasePresetA();
}

// A canvas whose context has an alpha channel lets the page show through every
// pixel the frame left with alpha < 1, and presets' composite shaders routinely
// write one: the image comes out dimmed (or tinted by the page background).
// That is only wanted in transparency mode, so otherwise the frame's alpha is
// set to 1 before the browser composites it. glClearBufferfv touches no clear
// color state, and with only the alpha channel unmasked it leaves the image
// alone. Hosts without context alpha (the default) skip this entirely.
static void MakeCanvasOpaqueUnlessTransparent(const WasmHost& host)
{
    if (host.contextConfig.alpha == 0 || projectm_get_transparency_mode(host.appData.Engine()))
    {
        return;
    }
    static const GLfloat kOpaque[4] = {0.0f, 0.0f, 0.0f, 1.0f};
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_TRUE);
    glClearBufferfv(GL_COLOR, 0, kOpaque);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
}

// The end of every rendered frame, whichever path drew it.
static void FinishFrame(WasmHost& host)
{
    MakeCanvasOpaqueUnlessTransparent(host);
    FlushRhythmEvents(host);
    // A requested capture reads what was just drawn, before the commit.
    TakeRequestedFrameCapture(host);
    // explicitSwapControl hosts present here, once per frame.
    WasmWebGLCommitFrameIfExplicit(host);
    host.renderedFrameCount++;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void render_frame()
{
    WasmHost& H = Host();
    if (H.appData.Engine() == nullptr)
    {
        return;
    }

    // Switch to a preset the prepare thread has finished, if any. Its GL half
    // (preset objects, shader compile + link) runs here, on this host's context,
    // between frames of the current preset rather than in place of them.
    ActivatePreparedPreset(H);
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return;
    }

    // Deterministic-clock tick (no-op unless the harness enabled it): pins this
    // frame to N/fps before anything reads the time.
    DeterministicFrameTick(H);

    // Single audio ingest: drain everything JS producers wrote into the PCM ring
    // since the last frame and hand it to the engine as one stereo block. Done
    // here rather than in renderLoop() so the render-worker path (which drives
    // render_frame() from its own loop) and any host calling render_frame()
    // directly get identical audio, with no window/AnalyserNode involved.
    PcmRingDrain(H);

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

    if (!ShouldUseDualFboCompositor(H))
    {
        // Direct-to-canvas path (steady state, startup, or compositor unavailable).
        ReleaseDualFboIfIdle(H);
        {
            GLStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
            projectm_opengl_render_frame(engine);
        }
        CollectRhythmEvents(H);
        FinishFrame(H);
        return;
    }

    DualPingPongFramebuffer& dualFbo = H.dualFbo;
    const int w = dualFbo.Width();
    const int h = dualFbo.Height();
    const bool ditherOutput = (dualFbo.GetFormat() == FboFloatFormat::RGBA8);
    const bool transparencyMode = projectm_get_transparency_mode(engine);
    const float transparencyThreshold = projectm_get_transparency_threshold(engine);

    // --- Step 1: Render Preset A into its Write FBO ---
    // Note: projectm_opengl_render_frame() hardcodes its final composite blit to
    // FBO 0 (the default framebuffer / canvas) regardless of which FBO is bound
    // when called. Use projectm_opengl_render_frame_fbo() so the final composite
    // lands in our Write FBO instead of clobbering the canvas directly.
    {
        GLStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
        projectm_opengl_render_frame_fbo(engine, dualFbo.GetAWriteFBO());
    }
    CollectRhythmEvents(H);
    dualFbo.SwapPresetA();

    // --- Step 2: Render Preset B into its Write FBO ---
    gl_reset_state_between_pipelines();
    {
        GLStateGuard guard(H.glBaseline ? &*H.glBaseline : nullptr);
        projectm_opengl_render_frame_fbo(engine, dualFbo.GetBWriteFBO());
    }
    CollectRhythmEvents(H);
    dualFbo.SwapPresetB();

    // --- Step 3: Composite to the default framebuffer (browser canvas) ---
    // Timed as the Present stage, like libprojectM's own output blit: with the
    // perf HUD on, this is the soft-cut cost gpuPresentMs carries.
    const projectm_perf_gpu_stage previousStage = projectm_perf_enter_gpu_stage(PROJECTM_PERF_GPU_STAGE_PRESENT);
    H.compositorShader.Draw(dualFbo.GetAReadTex(), dualFbo.GetBReadTex(),
                            H.transitionBlend, w, h, ditherOutput,
                            transparencyMode, transparencyThreshold);
    projectm_perf_enter_gpu_stage(previousStage);

    // --- Step 4: Advance blend timer ---
    float newBlend;
    if (H.activeTransitionDuration <= 0.0f)
    {
        // Hard cut: jump immediately to full B.
        newBlend = 1.0f;
    }
    else
    {
        // Time-based blend (WasmNow() returns milliseconds).
        const double now = WasmNow();
        newBlend = static_cast<float>((now - H.transitionStartTime) / (static_cast<double>(H.activeTransitionDuration) * 1000.0));
    }
    H.transitionBlend = newBlend < 1.0f ? newBlend : 1.0f;

    if (H.transitionBlend >= 1.0f)
    {
        // Transition complete: promote B → A, release B's FBOs, reset state.
        dualFbo.PromoteBtoA();
        H.transitionBlend = 0.0f;
        H.transitionActive = false;
        H.presetBReady = false;
        // Start the Preset A idle clock: from here nothing samples the pair
        // until the next transition, so ReleaseDualFboIfIdle() can reclaim it.
        H.transitionEndTime = WasmNow();
        LOG_DEBUG("Transition complete: preset B promoted to A");
    }
    FinishFrame(H);
}

EMSCRIPTEN_KEEPALIVE
void set_window_size(int width, int height)
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return;
    }
    WasmWebGLResizeCanvases(H, width, height);
    glViewport(0, 0, width, height);
    glScissor(0, 0, width, height);
    if (H.glBaseline)
    {
        H.glBaseline->SetViewportAndScissor(width, height);
    }
    projectm_set_window_size(engine, width, height);
    // Phase 2: Resize all allocated dual ping-pong FBOs to match the new viewport.
    H.dualFbo.Resize(width, height);
}
} // extern "C"
