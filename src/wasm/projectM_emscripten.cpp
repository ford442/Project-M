// projectM_emscripten.cpp  (ProjectMWasmMain)
//
// Engine lifecycle for the projectM Emscripten/WASM host: it builds and tears
// down the engine + playlist + GL context around the active WasmHost.
// Per-instance state lives in WasmHost (#168 Phase B). There is no main(): the
// glue is linked with INVOKE_RUN=0 and every host page brings its engine up
// with create_host_with_config() (or the legacy init()).
//
// The rest of the host glue lives in the focused WASM TUs:
//   WasmWebGLContext.cpp  WebGL context create/destroy + extensions + canvas selectors
//   WasmGraphics.hpp      dual-FBO classes + compositing shader
//   WasmDualFbo.cpp       dual_fbo_* / transition_* exports
//   WasmRenderLoop.cpp    Emscripten main loop + start_render/render_frame/set_window_size
//   WasmShaderCache.cpp   transpiled-GLSL cache hooks + shader_cache_* exports
//   WasmRenderPathOverrides.cpp  ?blurPath / ?copyPath / ?perPixelEval ablation switches
//   WasmAudioBridge.cpp   audio worklet + stream analyser + PCM feed
//   WasmPerfGovernor.cpp  perf HUD + adaptive quality governor + OpenMP info
//   WasmPlaylistBridge.cpp preset callbacks + playlist path helpers
//   WasmJsBindings.cpp    EM_JS DOM/VFS bootstrap + host-page notifications
//
// See docs/EMSCRIPTEN.md ("Where to add a WASM export").
#include "WasmGraphics.hpp"
#include "WasmHost.hpp"
#include "WasmWebGLContext.hpp"

#include <emscripten/threading.h>

// kWasmOpenMpThreads comes from cmake/generated/ProjectMWasmBuildConfig.hpp
// (generated from PROJECTM_WASM_OPENMP_THREADS in EmscriptenWasmFlags.cmake);
// PTHREAD_POOL_SIZE pre-spawns a Worker for each of its helper threads plus
// one per host's preset prepare thread.
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
//
// kWasmOpenMpThreads is only a ceiling. The team is clamped to one less than
// navigator.hardwareConcurrency so a 2- or 4-core phone keeps a core free for
// the page's AudioWorklet and the browser; PTHREAD_POOL_SIZE still pre-spawns
// kWasmOpenMpThreads - 1 Workers, the surplus just stays parked.
#ifdef _OPENMP
static int WasmOpenMpTeamSize()
{
    const int cores = emscripten_num_logical_cores();
    return std::clamp(cores - 1, 1, kWasmOpenMpThreads);
}
#endif

static void ConfigureWasmOpenMPThreadCount()
{
#ifdef _OPENMP
    omp_set_dynamic(0);
    omp_set_num_threads(WasmOpenMpTeamSize());
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
// Must accompany every dualFbo.ReleaseAll() teardown: ReleaseAll() clears the
// allocation flags but not the blend timeline, and a transitionActive left set
// across teardown both blocks ReleaseDualFboIfIdle() and makes the next
// allocation resume a blend against a stale transitionStartTime.
static void ResetTransitionState(WasmHost& host)
{
    host.transitionActive = false;
    host.transitionBlend = 0.0f;
    host.transitionStartTime = 0.0;
    host.transitionEndTime = 0.0;
    host.presetBReady = false;
}

// Destroys the host's playlist and engine, in that order: the playlist holds
// the engine handle and unregisters its callbacks from it.
//
// Every teardown path (destruct, context loss, rebind) goes through here.
// destruct() and pm_handle_context_loss() used to destroy only the engine, and
// the latter nulled the playlist pointer outright, so each destroy_host() and
// each lost context leaked a playlist still pointing at a freed engine.
static void DestroyEngineAndPlaylist(WasmHost& host)
{
    // A preparation still running is for this engine; its result must not be
    // loaded into the next one init() creates.
    if (host.presetPrepare)
    {
        host.presetPrepare->DiscardAll();
    }
    host.switchRequestDeferred = false;
    host.pendingSwitch.reset();
    host.appData.playlist.reset();
    host.appData.engine.reset();
    host.appData.loading = EM_FALSE;
}

// Releases the host's GL-side resources. The compositor program and dual-FBO
// textures are deleted while their own context is still current: GL object ids
// are global to the Emscripten GL layer, so a stale id deleted later under a
// different context would raise GL_INVALID_OPERATION there (or delete a
// sibling's object).
static void ReleaseGraphics(WasmHost& host)
{
    ReleaseFrameCapture(host);
    host.compositorShader.Release();
    host.dualFbo.ReleaseAll();
    host.glBaseline.reset();
    ResetTransitionState(host);
}

// ReleaseGraphics(), then destroys the host's WebGL context.
static void ReleaseGraphicsAndContext(WasmHost& host)
{
    ReleaseGraphics(host);
    WasmWebGLDestroyContext(host);
}

// The host's context exists and is not lost.
static bool HostContextIsLive(const WasmHost& host)
{
    return host.glCtx != 0 && !emscripten_is_webgl_context_lost(host.glCtx);
}

// Puts back the engine settings the page applied to this host's previous
// engine (see EngineSettings), so a context-loss restore or a rebind does not
// silently drop the mesh size, transparency, lock, etc. back to defaults.
static void ReapplyEngineSettings(WasmHost& host)
{
    projectm_handle engine = host.appData.Engine();
    const EngineSettings& settings = host.engineSettings;
    if (settings.meshSize)
    {
        projectm_set_mesh_size(engine, settings.meshSize->first, settings.meshSize->second);
    }
    if (settings.aspectCorrection)
    {
        projectm_set_aspect_correction(engine, *settings.aspectCorrection);
    }
    if (settings.presetLocked)
    {
        projectm_set_preset_locked(engine, *settings.presetLocked);
    }
    if (settings.transparencyMode)
    {
        projectm_set_transparency_mode(engine, *settings.transparencyMode);
    }
    if (settings.transparencyThreshold)
    {
        projectm_set_transparency_threshold(engine, *settings.transparencyThreshold);
    }
    if (settings.rhythmHint)
    {
        projectm_set_rhythm_hint(engine, *settings.rhythmHint);
    }
    if (settings.presetSwitchPolicy)
    {
        projectm_set_preset_switch_policy(engine, static_cast<projectm_preset_switch_policy>(settings.presetSwitchPolicy->first),
                                          settings.presetSwitchPolicy->second);
    }
    if (settings.transitionBeats)
    {
        projectm_set_soft_cut_duration_beats(engine, *settings.transitionBeats);
    }
    if (settings.hardCutOnBeat)
    {
        projectm_set_hard_cut_on_beat(engine, *settings.hardCutOnBeat);
    }
    if (settings.flashLimitThreshold)
    {
        projectm_set_flash_limit_threshold(engine, *settings.flashLimitThreshold);
    }
    if (settings.flashLimitEnabled)
    {
        projectm_set_flash_limit_enabled(engine, *settings.flashLimitEnabled);
    }
    ReapplyQualityTierLimits(host);
}

static void TearDownEngineForRebind(WasmHost& host)
{
    // Take this host out of the shared render loop until start_render() opts it
    // back in. The Emscripten main loop itself is process-global and services
    // every started host, so it is left running: cancelling it here used to stop
    // a sibling host's rendering too (and dropped a paused loop's pause, e.g. the
    // render worker's).
    host.renderLoopStarted = false;

    DestroyEngineAndPlaylist(host);
    ReleaseGraphicsAndContext(host);
}

// Creates the host's engine and playlist on its (current, live) context.
static WasmInitError CreateEngine(WasmHost& host)
{
    projectm_handle engine = projectm_create();
    if (engine == nullptr)
    {
        js_report_init_error(WasmInitError::kEngineCreateFailed, "projectm_create() returned null");
        return WasmInitError::kEngineCreateFailed;
    }
    host.appData.engine.reset(engine);
    host.appData.playlist.reset(projectm_playlist_create(engine));
    projectm_playlist_handle playlist = host.appData.Playlist();
    projectm_playlist_add_path(playlist, "/presets/", true, true);
    // Every callback is addressed to this host (not to whichever is active
    // when it fires); see WasmPlaylistBridge.cpp.
    projectm_playlist_set_preset_switched_event_callback(playlist, &load_preset_callback_done, &host);
    // Every playlist-driven load (manual, timer, switch_preset) is prepared on
    // this host's prepare thread instead of loading synchronously.
    projectm_playlist_set_preset_load_event_callback(playlist, &on_playlist_preset_load, &host);
    if (!host.presetPrepare)
    {
        host.presetPrepare = std::make_unique<PresetPrepareQueue>(HostHandle(host));
    }
    const char* texture_search_paths[] = {"textures"};
    projectm_set_texture_search_paths(engine, texture_search_paths, 1);
    projectm_set_fps(engine, host.targetFps > 0 ? host.targetFps : 60);
    SeedPresetDurationRng(host);
    projectm_set_preset_duration(engine, NextPresetDuration(host));
    projectm_set_soft_cut_duration(engine, 17.0);
    projectm_set_beat_sensitivity(engine, 1.50);
    projectm_playlist_set_shuffle(playlist, true);
    projectm_set_preset_switch_failed_event_callback(engine, &on_preset_switch_failed, &host);
    projectm_set_preset_switch_requested_event_callback(engine, &on_preset_switch_requested, &host);
    // Must happen before the first preset renders: the blur and per-pixel paths
    // are decided as each preset is initialized.
    ApplyRenderPathOverrides(host);
    // A re-created engine (context-loss restore, rebind) gets back what the
    // page had set on the one it replaces.
    ReapplyEngineSettings(host);
    return WasmInitError::kOk;
}

extern "C" {
// ---- Test hooks (PROJECTM_WASM_DEBUG_EXPORTS) -------------------------------

// Spawns a hard-coded demo user sprite (smoke test of the sprite path).
EMSCRIPTEN_KEEPALIVE
void debug_create_sprite()
{
    projectm_handle engine = Host().appData.Engine();
    if (engine == nullptr)
    {
        return;
    }
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
    projectm_sprite_create(engine, "milkdrop", new_sprite_code);
}

// The active host's engine pointer, which projectm_pcm_add_float_wrapper()
// accepts in place of 0.
EMSCRIPTEN_KEEPALIVE
uintptr_t debug_get_projectm_handle()
{
    return reinterpret_cast<uintptr_t>(Host().appData.Engine());
}

// Hosts holding a playlist. Every teardown path (destroy_host, context loss,
// rebind) must free it with the engine; the smoke test checks this goes back down.
EMSCRIPTEN_KEEPALIVE
int debug_live_playlist_count()
{
    return LivePlaylistCount();
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE int init();

EMSCRIPTEN_KEEPALIVE
void set_canvas_selectors(const char* primary, const char* secondary)
{
    WasmWebGLSetCanvasSelectors(Host(), primary, secondary);
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
    WasmHost& H = Host();
    // Rebinds the active host only: tear down its engine/GL context and re-init
    // against new canvas selectors. A second engine in the same Module is a
    // create_host(), not a rebind.
    WasmWebGLSetCanvasSelectors(H, primary, secondary);
    if (H.appData.Engine() != nullptr || H.glCtx != 0)
    {
        TearDownEngineForRebind(H);
    }
    return init();
}

// Brings up the active host: WebGL context, engine, playlist, PCM ring.
// Returns 0, or the WasmInitError it reported (pmReportInitError,
// get_last_init_error()).
EMSCRIPTEN_KEEPALIVE
int init()
{
    WasmHost& H = Host();
    InstallWasmLogSink();
    if (H.appData.Engine() != nullptr)
    {
        // Already initialized — but only if the engine's context is still the
        // live one. An engine left on a lost context holds GL names that no
        // longer exist; rebuild it rather than report success.
        if (HostContextIsLive(H) &&
            (emscripten_webgl_get_current_context() == H.glCtx ||
             emscripten_webgl_make_context_current(H.glCtx) == EMSCRIPTEN_RESULT_SUCCESS))
        {
            js_report_init_success();
            return static_cast<int>(WasmInitError::kOk);
        }
        DestroyEngineAndPlaylist(H);
        ReleaseGraphics(H);
        H.renderLoopStarted = false;
    }
    // A context that is lost (pm_handle_context_loss() keeps its handle for
    // exactly this check) cannot be rebuilt on until the browser restores it:
    // the canvas would hand the same dead context straight back, and an engine
    // made on it would be left holding GL names that vanish on restore. The
    // context-loss overlay's "tap to restore" can call this early.
    if (H.glCtx != 0 && emscripten_is_webgl_context_lost(H.glCtx))
    {
        js_report_init_error(WasmInitError::kContextLost, "WebGL context is lost; waiting for the browser to restore it");
        return static_cast<int>(WasmInitError::kContextLost);
    }
    ConfigureWasmOpenMPThreadCount();
    WasmWebGLApplyModuleCanvasSelectorsIfPresent(H);
    js_init_projectm_dom();
    // Canvas missing / create failed / make-current failed / software context
    // refused each have their own code, already reported.
    if (const WasmInitError contextRc = WasmWebGLCreateAndActivateContext(H); contextRc != WasmInitError::kOk)
    {
        return static_cast<int>(contextRc);
    }

    // Phase 2: Detect the best available floating-point texture format for the
    // dual ping-pong FBO system. Default is RGBA16F -> RGBA32F -> RGBA8.
    // Hosts can opt into RGBA32F-first probing with ?fboPrecision=high.
    // This must be called after the WebGL context is made current so that
    // extension availability can be probed reliably.
    H.dualFbo.DetectFormat(H.glCtx, H.contextConfig.fboPrecision);

    if (const WasmInitError engineRc = CreateEngine(H); engineRc != WasmInitError::kOk)
    {
        return static_cast<int>(engineRc);
    }
    InstallShaderTranspileCacheHooks();
    // Allocate this host's PCM ring before any producer can look for it: the
    // worklet bootstrap below reads the ring registry as soon as its module
    // resolves, and an already-running worklet (a second create_host()) is sent
    // the new host's descriptor by PcmRingInit() itself.
    PcmRingInit(H, 0);
    js_initialize_worklet_system_once();
    js_report_init_success();
    return static_cast<int>(WasmInitError::kOk);
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
void set_mesh(int w, int h)
{
    WasmHost& H = Host();
    if (w <= 0 || h <= 0)
    {
        return;
    }
    H.engineSettings.meshSize = std::make_pair(static_cast<size_t>(w), static_cast<size_t>(h));
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_mesh_size(engine, w, h);
    }
}

EMSCRIPTEN_KEEPALIVE
void destruct()
{
    WasmHost& H = Host();
    // Out of the shared render loop until a start_render() opts it back in.
    H.renderLoopStarted = false;
    DestroyEngineAndPlaylist(H);
    // Release this host's PCM ring (#246: one ring per host, so a sibling's
    // ring and producers are untouched). The worklet is told to detach it.
    PcmRingShutdown(H);
    // Phase 2: Release dual FBO resources before destroying the WebGL context
    // to avoid calling OpenGL functions with an invalid context.
    ReleaseGraphicsAndContext(H);
}

// Tears down one host whose WebGL context was lost. The host must be active
// (its context current).
//
// Every GL call in here (projectm_destroy(), the compositor release,
// dualFbo.ReleaseAll()) is a no-op on a lost context per the WebGL spec; they
// only reset projectM's bookkeeping so the next init() takes the full
// re-initialization path. The context *handle* is kept: init() asks it whether
// the context is still lost and refuses until the browser has restored it
// (it then replaces the handle with a fresh one on the restored context).
static void TearDownHostForContextLoss(WasmHost& host)
{
    host.renderLoopStarted = false;
    DestroyEngineAndPlaylist(host);
    ReleaseGraphics(host);
}

// Called from the host page's "webglcontextlost" handler (see
// html/projectm-context-loss.js), before the browser's "webglcontextrestored"
// event fires.
//
// The loss belongs to the host that owns the canvas, which need not be the
// active one: every host whose context reports lost is torn down, and the last
// of them is left active so the restore path's init() / start_render() rebuild
// that host rather than a healthy sibling. Called when no context actually
// reports lost (a page simulating the event), it tears down the active host,
// as it always has.
EMSCRIPTEN_KEEPALIVE
void pm_handle_context_loss()
{
    WasmHost* lostHost = nullptr;
    const int slots = HostSlotCount();
    for (int i = 0; i < slots; ++i)
    {
        WasmHost* host = HostSlot(i);
        if (host == nullptr || host->glCtx == 0 || !emscripten_is_webgl_context_lost(host->glCtx))
        {
            continue;
        }
        SetActiveHost(host);
        TearDownHostForContextLoss(*host);
        lostHost = host;
    }
    if (lostHost == nullptr)
    {
        TearDownHostForContextLoss(Host());
    }
}

EMSCRIPTEN_KEEPALIVE
void set_aspect_correction(bool enabled)
{
    WasmHost& H = Host();
    H.engineSettings.aspectCorrection = enabled;
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_aspect_correction(engine, enabled);
    }
}

EMSCRIPTEN_KEEPALIVE
void set_preset_locked(bool locked)
{
    WasmHost& H = Host();
    H.engineSettings.presetLocked = locked;
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_preset_locked(engine, locked);
    }
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_mode(bool enabled)
{
    WasmHost& H = Host();
    H.engineSettings.transparencyMode = enabled;
    if (enabled && H.contextConfig.alpha == 0)
    {
        LOG_WARN("set_transparency_mode: this host's WebGL context has no alpha channel (create it with contextAlpha), so the canvas stays opaque");
    }
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_transparency_mode(engine, enabled);
    }
}

EMSCRIPTEN_KEEPALIVE
bool get_transparency_mode()
{
    projectm_handle engine = Host().appData.Engine();
    return engine != nullptr && projectm_get_transparency_mode(engine);
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_threshold(float threshold)
{
    WasmHost& H = Host();
    H.engineSettings.transparencyThreshold = threshold;
    if (projectm_handle engine = H.appData.Engine())
    {
        projectm_set_transparency_threshold(engine, threshold);
    }
}

} // extern "C"
