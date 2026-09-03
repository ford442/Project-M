// projectM_emscripten.cpp  (ProjectMWasmMain)
//
// Init orchestration and AppData ownership for the projectM Emscripten/WASM
// host. Owns the process-global engine state, the transpiled-GLSL shader cache
// hooks, the render loop, and the engine-lifecycle / render C exports.
//
// The rest of the host glue lives in the focused WASM TUs:
//   WasmWebGLContext.cpp  WebGL context create/destroy + extensions + canvas selectors
//   WasmGraphics.hpp      dual-FBO classes + compositing shader
//   WasmDualFbo.cpp       dual_fbo_* / transition_* exports
//   WasmAudioBridge.cpp   audio worklet + stream analyser + PCM feed
//   WasmPerfGovernor.cpp  perf HUD + adaptive quality governor + OpenMP info
//   WasmPlaylistBridge.cpp preset callbacks + playlist path helpers
//   WasmJsBindings.cpp    EM_JS DOM/VFS bootstrap + host-page notifications
//
// See docs/EMSCRIPTEN.md ("Where to add a WASM export").
#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"
#include "WasmWebGLContext.hpp"

#include <cstdlib>

using namespace emscripten;

// ---- Core engine state (declared extern in ProjectMWasmInternal.hpp) -------
projectm_handle pm;
AppData app_data;
projectm_playlist_handle playlist = {};

// ---- Async preset loading / transition gating (declared extern in header) --
bool g_presetBReady = false;
uint32_t g_renderedFrameCount = 0;
uint32_t g_presetReadyFrame = 0;
bool g_presetSwitchFailed = false;

// kWasmPthreadPoolSize comes from cmake/generated/ProjectMWasmBuildConfig.hpp
// (generated from PROJECTM_WASM_PTHREAD_POOL_SIZE in EmscriptenWasmFlags.cmake).
//
// The blocktime call is what keeps the browser's audio thread alive. LLVM
// libomp parks a team's helper threads in a *spin* wait after every parallel
// region and only lets them sleep once KMP_BLOCKTIME elapses; the default is
// 200 ms. PerPixelMesh::CalculateMesh opens a parallel region every rendered
// frame (the default 80x60 / 64x48 meshes are 4941 / 3185 verts, both well
// over OpenMp::kMinPerPixelMeshVerts), so at 60 fps the next region always
// arrives ~17 ms in — two orders of magnitude inside the spin interval. The
// helpers therefore never reach the sleep path and burn 100% of their cores
// for the whole session, not just while projectM is computing.
//
// That is a visualiser stealing cores from the page's AudioWorklet, which has
// to produce a 128-sample quantum every ~2.7 ms at 48 kHz. Starve it and
// playback crackles and drops out; the same contention drags the render loop
// down, which is why the 036 bundle regressed audio *and* framerate together
// while 032 (linked without any libomp at all) was clean on the same host.
//
// KMP_BLOCKTIME cannot be set the usual way here: libomp reads it via getenv()
// during its own init, and a wasm module has no environment to inherit one
// from. kmp_set_blocktime() is the programmatic equivalent and must run before
// the first parallel region, which init() guarantees.
static void ConfigureWasmOpenMPThreadCount()
{
#ifdef _OPENMP
    omp_set_dynamic(0);
    omp_set_num_threads(kWasmPthreadPoolSize);
    // Sleep helpers immediately instead of spinning between frames. Costs a
    // futex wake per parallel region; buys back three idle cores.
    //
    // kmp_set_blocktime() is an LLVM/Intel libomp extension, not base OpenMP.
    // __KAI_KMPC_CONVENTION is defined only by their omp.h (the one bundled in
    // omp/ and used by the wasm build), so this compiles away rather than
    // failing to link if the file is ever built against GCC's libgomp.
#if defined(__KAI_KMPC_CONVENTION)
    kmp_set_blocktime(0);
#endif
#endif
}

// Clears the transition controller back to its cold-start state.
//
// Must accompany every g_dualFbo.ReleaseAll() teardown: ReleaseAll() clears the
// allocation flags but not the blend timeline, and a g_transitionActive left set
// across teardown both blocks ReleaseDualFboIfIdle() and makes the next
// allocation resume a blend against a stale g_transitionStartTime.
static void ResetTransitionState()
{
    g_transitionActive = false;
    g_transitionBlend = 0.0f;
    g_transitionStartTime = 0.0;
    g_transitionEndTime = 0.0;
    g_presetBReady = false;
}

static void TearDownEngineForRebind()
{
    // Cancel the Emscripten main loop if one is running so rebind can restart it
    // via start_render() after a fresh init().
    emscripten_cancel_main_loop();

    if (playlist)
    {
        projectm_playlist_destroy(playlist);
        playlist = nullptr;
    }
    if (pm)
    {
        projectm_destroy(pm);
        pm = nullptr;
    }
    app_data.projectm_engine = nullptr;
    app_data.playlist = nullptr;
    app_data.loading = EM_FALSE;

    g_dualFbo.ReleaseAll();
    ResetTransitionState();
    WasmWebGLDestroyContext();
}

// =============================================================================
// Transpiled GLSL cache (browser IndexedDB via JS hooks)
// =============================================================================

static std::string g_shaderCacheKey;
static std::optional<std::string> g_importedWarpGlsl;
static std::optional<std::string> g_importedCompGlsl;

// clang-format off
EM_JS(void, js_on_transpiled_shader_stored, (const char* key, int kind, const char* glsl), {
    if (typeof globalThis.pmOnTranspiledShaderStored === 'function')
    {
        globalThis.pmOnTranspiledShaderStored(UTF8ToString(key), kind, UTF8ToString(glsl));
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_dual_fbo_prefer_high_precision, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('fboPrecision');
        return (value && value.toLowerCase() === 'high') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_blur_force_copy_path, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('blurPath');
        return (value && value.toLowerCase() === 'copy') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// clang-format off
EM_JS(int, js_copy_force_shader_path, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const value = new URLSearchParams(globalThis.location.search).get('copyPath');
        return (value && value.toLowerCase() === 'shader') ? 1 : 0;
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// Ablation switch for benchmarking the texture-copy path: ?copyPath=shader restores the
// pre-#179 fullscreen-quad copy so it can be A/B'd against the default glBlitFramebuffer
// resolve on one build. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
static void ApplyCopyPathOverride()
{
    if (js_copy_force_shader_path() != 0)
    {
        setenv("PROJECTM_COPY_SHADER_PATH", "1", 1);
    }
}

// Ablation switch for benchmarking the blur chain: ?blurPath=copy restores the legacy
// render-to-scratch + glCopyTexSubImage2D behaviour so it can be A/B'd against the
// default render-to-texture path on one build. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
static void ApplyBlurPathOverride()
{
    if (js_blur_force_copy_path() != 0)
    {
        setenv("PROJECTM_BLUR_COPY_PATH", "1", 1);
    }
}

static void InstallShaderTranspileCacheHooks()
{
    libprojectM::Renderer::SetTranspiledGlslCacheCallbacks(
        [](const std::string& key, int shaderType) -> std::optional<std::string> {
            if (key != g_shaderCacheKey)
            {
                return std::nullopt;
            }
            if (shaderType == 0 && g_importedWarpGlsl)
            {
                return g_importedWarpGlsl;
            }
            if (shaderType == 1 && g_importedCompGlsl)
            {
                return g_importedCompGlsl;
            }
            return std::nullopt;
        },
        [](const std::string& key, int shaderType, const std::string& glsl) {
            js_on_transpiled_shader_stored(key.c_str(), shaderType, glsl.c_str());
        });
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void shader_cache_begin_load(const char* key)
{
    g_shaderCacheKey = key ? key : "";
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
    libprojectM::Renderer::SetTranspiledGlslCacheKey(g_shaderCacheKey);
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_import_glsl(int shaderType, const char* glsl)
{
    if (!glsl)
    {
        return;
    }
    if (shaderType == 0)
    {
        g_importedWarpGlsl = glsl;
    }
    else if (shaderType == 1)
    {
        g_importedCompGlsl = glsl;
    }
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_end_load()
{
    libprojectM::Renderer::ClearTranspiledGlslCacheKey();
    g_shaderCacheKey.clear();
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
}

EMSCRIPTEN_KEEPALIVE
int get_glsl_generator_version()
{
    return static_cast<int>(
        libprojectM::MilkdropPreset::MilkdropStaticShaders::Get()->GetGlslGeneratorVersion());
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
void create_sprite()
{
    const char* new_sprite_code =
        "[preset01]"
        "img='textures/rv_IP_20250421_060250.png';"
        "per_frame_1=blendmode=1;"
        "per_frame_2=x = 0.5;"       // Center X
        "per_frame_3=y = 0.5;"       // Center Y
        "per_frame_4=z = 0.0;"       // Center Y
        "per_frame_5=scaling = 1.0;" // Make it huge (twice the screen height)
        "per_pixel_2=a = 1;"         // Fully opaque
        "per_pixel_3=r = 1.0;"       // Bright Red
        "per_pixel_4=g = 0.0;"
        "per_pixel_5=b = 1.0;";

    projectm_sprite_create(app_data.projectm_engine, "milkdrop", new_sprite_code);
    return;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t get_projectm_handle()
{
    return reinterpret_cast<uintptr_t>(app_data.projectm_engine);
}
} // extern "C"

// Forward declaration: render_frame() is defined later in this file (Phase 5
// dual-FBO compositor pipeline), but renderLoop() — registered as the
// Emscripten main loop by start_render() — must call it every frame.
extern "C" void render_frame();

void renderLoop()
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

extern "C" {
EMSCRIPTEN_KEEPALIVE int init();

EMSCRIPTEN_KEEPALIVE
void set_canvas_selectors(const char* primary, const char* secondary)
{
    WasmWebGLSetCanvasSelectors(primary, secondary);
}

EMSCRIPTEN_KEEPALIVE
int init_with_canvases(const char* primary, const char* secondary)
{
    set_canvas_selectors(primary, secondary);
    return init();
}

EMSCRIPTEN_KEEPALIVE
int rebind_canvases(const char* primary, const char* secondary)
{
    // Single-instance rebind: tear down the active engine/GL context and re-init
    // against new canvas selectors. Does not support two simultaneous engines in
    // one Module (INITIAL_MEMORY ≈ 1 GiB per Module instance).
    set_canvas_selectors(primary, secondary);
    if (pm || WasmWebGLGetContext())
    {
        TearDownEngineForRebind();
    }
    return init();
}

EMSCRIPTEN_KEEPALIVE
int init()
{
    if (pm)
    {
        js_report_init_success();
        return 0;
    }
    ConfigureWasmOpenMPThreadCount();
    WasmWebGLApplyModuleCanvasSelectorsIfPresent();
    js_init_projectm_dom();
    if (!WasmWebGLCreateAndActivateContext())
    {
        return 2;
    }

    // Phase 2: Detect the best available floating-point texture format for the
    // dual ping-pong FBO system. Default is RGBA16F -> RGBA32F -> RGBA8.
    // Hosts can opt into RGBA32F-first probing with ?fboPrecision=high.
    // This must be called after the WebGL context is made current so that
    // extension availability can be probed reliably.
    g_dualFbo.DetectFormat(WasmWebGLGetContext(), js_dual_fbo_prefer_high_precision() != 0);

    // Must happen before the first preset renders, since both paths are decided once.
    ApplyBlurPathOverride();
    ApplyCopyPathOverride();

    pm = projectm_create();
    if (!pm)
    {
        fprintf(stderr, "Failed to create projectM handle\n");
        js_report_init_error(3, "projectm_create() returned null");
        return 3;
    }
    app_data.projectm_engine = pm;
    playlist = projectm_playlist_create(pm);
    app_data.playlist = playlist;
    const char* loc = "/presets/";
    projectm_playlist_add_path(playlist, loc, true, true);
    projectm_playlist_set_preset_switched_event_callback(playlist, &load_preset_callback_done, &app_data);
    const char* texture_search_paths[] = {"textures"};
    projectm_set_texture_search_paths(pm, texture_search_paths, 1);
    projectm_set_fps(pm, 60);
    projectm_set_preset_duration(pm, 30.0);
    projectm_set_soft_cut_duration(pm, 17.0);
    // projectm_set_hard_cut_duration(pm, 48.0);
    // projectm_set_hard_cut_enabled(pm, true);
    projectm_set_beat_sensitivity(pm, 1.50);
    projectm_playlist_set_shuffle(playlist, true);
    projectm_set_preset_switch_failed_event_callback(pm, &_on_preset_switch_failed, nullptr);
    projectm_set_preset_switch_requested_event_callback(pm, &on_preset_switch_requested, &app_data);
    InstallShaderTranspileCacheHooks();
    // projectm_playlist_connect(app_data.playlist,app_data.projectm_engine);
    printf("  --==  projectM initialized!  ==--\n");
    // Allocate the PCM ring before any producer can look for it: the worklet
    // bootstrap below reads the descriptor as soon as its module resolves.
    pcm_ring_init(0);
    js_initialize_worklet_system_once();
    js_report_init_success();
    return 0;
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
void set_mesh(int w, int h)
{
    projectm_set_mesh_size(pm, w, h);
    return;
}

EMSCRIPTEN_KEEPALIVE
void destruct()
{
    if (pm)
    {
        projectm_destroy(pm);
    }
    pm = NULL;
    // Release the PCM ring here and nowhere else. rebind_canvases() deliberately
    // keeps it: the ring is engine-independent, JS producers (the worklet in
    // particular, which holds raw views and cannot call back into WASM) keep
    // writing across a rebind, and it is allocated exactly once, so leaving it
    // alone costs nothing and freeing it under a live producer would not be safe.
    pcm_ring_shutdown();
    // Phase 2: Release dual FBO resources before destroying the WebGL context
    // to avoid calling OpenGL functions with an invalid context.
    g_dualFbo.ReleaseAll();
    ResetTransitionState();
    WasmWebGLDestroyContext();
    return;
}

// Called from the host page's "webglcontextlost" handler (see
// html/projectm-context-loss.js), before the browser's "webglcontextrestored"
// event fires. At this point the WebGL context is already gone, so every GL
// call below (inside projectm_destroy() and g_dualFbo.ReleaseAll()) is a
// no-op per the WebGL spec; they only exist to reset projectM's bookkeeping
// (pm, playlist, gl_ctx, dual-FBO allocation flags) so that a subsequent
// init() call takes the full re-initialization path instead of the
// "already initialized" early return.
EMSCRIPTEN_KEEPALIVE
void pm_handle_context_loss()
{
    if (pm)
    {
        projectm_destroy(pm);
    }
    pm = NULL;
    app_data.projectm_engine = NULL;
    playlist = NULL;
    app_data.playlist = NULL;
    g_dualFbo.ReleaseAll();
    ResetTransitionState();
    WasmWebGLDestroyContext();
    return;
}

EMSCRIPTEN_KEEPALIVE
void set_aspect_correction(bool enabled)
{
    if (!pm)
        return;
    projectm_set_aspect_correction(pm, enabled);
    return;
}

EMSCRIPTEN_KEEPALIVE
void set_preset_locked(bool locked)
{
    if (!pm)
        return;
    projectm_set_preset_locked(pm, locked);
    printf("Preset lock set to: %s\n", locked ? "true" : "false");
    return;
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_mode(bool enabled)
{
    if (!pm)
        return;
    projectm_set_transparency_mode(pm, enabled);
    return;
}

EMSCRIPTEN_KEEPALIVE
bool get_transparency_mode()
{
    if (!pm)
        return false;
    return projectm_get_transparency_mode(pm);
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_threshold(float threshold)
{
    if (!pm)
        return;
    projectm_set_transparency_threshold(pm, threshold);
    return;
}

EMSCRIPTEN_KEEPALIVE
float get_transparency_threshold()
{
    if (!pm)
        return 0.01f;
    return projectm_get_transparency_threshold(pm);
}

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
    const double idleMs = emscripten_get_now() - g_transitionEndTime;
    if (idleMs < static_cast<double>(g_dualFboIdleReleaseSec) * 1000.0)
    {
        return;
    }
    g_dualFbo.ReleasePresetA();
}

EMSCRIPTEN_KEEPALIVE
void render_frame()
{
    if (!pm)
        return;

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
        // Time-based blend (emscripten_get_now() returns milliseconds).
        const double now = emscripten_get_now();
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
        g_transitionEndTime = emscripten_get_now();
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

int main()
{
    init();
    return 0;
}
