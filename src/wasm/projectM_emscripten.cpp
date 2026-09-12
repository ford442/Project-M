// projectM_emscripten.cpp  (ProjectMWasmMain)
//
// Engine lifecycle for the projectM Emscripten/WASM host: it defines the
// process-global engine state (`pm`, `app_data`, `playlist`), builds and tears
// down the engine + playlist + GL context around it, and owns `main()`.
//
// The rest of the host glue lives in the focused WASM TUs:
//   WasmWebGLContext.cpp  WebGL context create/destroy + extensions + canvas selectors
//   WasmGraphics.hpp      dual-FBO classes + compositing shader
//   WasmDualFbo.cpp       dual_fbo_* / transition_* exports
//   WasmRenderLoop.cpp    Emscripten main loop + start_render/render_frame/set_window_size
//   WasmShaderCache.cpp   transpiled-GLSL cache hooks + shader_cache_* exports
//   WasmRenderPathOverrides.cpp  ?blurPath / ?copyPath / ?fboPrecision ablation switches
//   WasmAudioBridge.cpp   audio worklet + stream analyser + PCM feed
//   WasmPerfGovernor.cpp  perf HUD + adaptive quality governor + OpenMP info
//   WasmPlaylistBridge.cpp preset callbacks + playlist path helpers
//   WasmJsBindings.cpp    EM_JS DOM/VFS bootstrap + host-page notifications
//
// See docs/EMSCRIPTEN.md ("Where to add a WASM export").
#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"
#include "WasmWebGLContext.hpp"

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
    // KMP_VERSION_MAJOR is defined only by their omp.h (the one bundled in omp/
    // and used by the wasm build), so this compiles away rather than failing to
    // link if the file is ever built against GCC's libgomp.
    //
    // Do NOT gate this on __KAI_KMPC_CONVENTION: libomp's own omp.h #undefs that
    // macro at the end of the header (it is a calling-convention helper for the
    // declarations, not a feature flag), so the guard is always false and the
    // blocktime call silently vanishes — which is exactly how this fix sat
    // inert while the 036 audio/framerate regression was being investigated.
    // KMP_VERSION_MAJOR is defined near the top of the same header and survives.
#if defined(KMP_VERSION_MAJOR)
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
    g_dualFbo.DetectFormat(WasmWebGLGetContext(), WasmPreferHighPrecisionFbo());

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
} // extern "C"

int main()
{
    init();
    return 0;
}
