// projectM_emscripten.cpp  (ProjectMWasmMain)
//
// Engine lifecycle for the projectM Emscripten/WASM host: it builds and tears
// down the engine + playlist + GL context around the active WasmHost, and owns
// `main()`. Per-instance state lives in WasmHost (#168 Phase B).
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
#include "WasmLog.hpp"
#include "WasmWebGLContext.hpp"

#include <emscripten/threading.h>

// Per-instance host state (#168 Phase B). Former process-global engine /
// playlist / dual-FBO / transition fields are WasmHost members; each body binds
// same-named local references (`auto& pm = H.appData.projectm_engine;`) so the
// lifecycle code reads the same as before.

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
// Must accompany every g_dualFbo.ReleaseAll() teardown: ReleaseAll() clears the
// allocation flags but not the blend timeline, and a g_transitionActive left set
// across teardown both blocks ReleaseDualFboIfIdle() and makes the next
// allocation resume a blend against a stale g_transitionStartTime.
static void ResetTransitionState(WasmHost& H)
{
    auto& g_presetBReady = H.presetBReady;
    auto& g_transitionActive = H.transitionActive;
    auto& g_transitionBlend = H.transitionBlend;
    auto& g_transitionStartTime = H.transitionStartTime;
    auto& g_transitionEndTime = H.transitionEndTime;
    g_transitionActive = false;
    g_transitionBlend = 0.0f;
    g_transitionStartTime = 0.0;
    g_transitionEndTime = 0.0;
    g_presetBReady = false;
}

// Playlists created by init() and not yet destroyed, across every host. Only
// read by live_playlist_count(), which the smoke test uses to prove that
// destroy_host / context loss / rebind free the playlist along with the engine.
static int g_livePlaylistCount = 0;

// Destroys the host's playlist and engine, in that order: the playlist holds
// the engine handle and unregisters its callbacks from it.
//
// Every teardown path (destruct, context loss, rebind) goes through here.
// destruct() and pm_handle_context_loss() used to destroy only the engine, and
// the latter nulled the playlist pointer outright, so each destroy_host() and
// each lost context leaked a playlist still pointing at a freed engine.
static void DestroyEngineAndPlaylist(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    auto& playlist = H.appData.playlist;
    // A preparation still running is for this engine; its result must not be
    // loaded into the next one init() creates.
    if (H.presetPrepare)
    {
        H.presetPrepare->DiscardAll();
    }
    H.switchRequestDeferred = false;
    H.pendingSwitch.reset();
    if (playlist)
    {
        projectm_playlist_destroy(playlist);
        playlist = nullptr;
        --g_livePlaylistCount;
    }
    if (pm)
    {
        projectm_destroy(pm);
        pm = nullptr;
    }
    H.appData.loading = EM_FALSE;
}

// Releases the host's GL-side resources and destroys its WebGL context. The
// compositor program and dual-FBO textures are deleted first, while their own
// context is still current: GL object ids are global to the Emscripten GL
// layer, so a stale id deleted later under a different context would raise
// GL_INVALID_OPERATION there (or delete a sibling's object).
static void ReleaseGraphics(WasmHost& H)
{
    ReleaseFrameCapture(H);
    H.compositorShader.Release();
    H.dualFbo.ReleaseAll();
    H.glBaseline.reset();
    ResetTransitionState(H);
}

static void ReleaseGraphicsAndContext(WasmHost& H)
{
    ReleaseGraphics(H);
    WasmWebGLDestroyContext(H);
}

// init()'s return code while the host's WebGL context is lost: the engine
// cannot be rebuilt until the browser fires "webglcontextrestored".
constexpr int kInitContextLost = 5;

// The active host's context exists and is not lost.
static bool HostContextIsLive(const WasmHost& host)
{
    return host.glCtx != 0 && !emscripten_is_webgl_context_lost(host.glCtx);
}

// Puts back the engine settings the page applied to this host's previous
// engine (see EngineSettings), so a context-loss restore or a rebind does not
// silently drop the mesh size, transparency, lock, etc. back to defaults.
static void ReapplyEngineSettings(WasmHost& host)
{
    projectm_handle pm = host.appData.projectm_engine;
    const EngineSettings& settings = host.engineSettings;
    if (settings.meshSize)
    {
        projectm_set_mesh_size(pm, settings.meshSize->first, settings.meshSize->second);
    }
    if (settings.aspectCorrection)
    {
        projectm_set_aspect_correction(pm, *settings.aspectCorrection);
    }
    if (settings.presetLocked)
    {
        projectm_set_preset_locked(pm, *settings.presetLocked);
    }
    if (settings.transparencyMode)
    {
        projectm_set_transparency_mode(pm, *settings.transparencyMode);
    }
    if (settings.transparencyThreshold)
    {
        projectm_set_transparency_threshold(pm, *settings.transparencyThreshold);
    }
    if (settings.rhythmHint)
    {
        projectm_set_rhythm_hint(pm, *settings.rhythmHint);
    }
    if (settings.presetSwitchPolicy)
    {
        projectm_set_preset_switch_policy(pm, static_cast<projectm_preset_switch_policy>(settings.presetSwitchPolicy->first),
                                          settings.presetSwitchPolicy->second);
    }
    if (settings.transitionBeats)
    {
        projectm_set_soft_cut_duration_beats(pm, *settings.transitionBeats);
    }
    if (settings.hardCutOnBeat)
    {
        projectm_set_hard_cut_on_beat(pm, *settings.hardCutOnBeat);
    }
    if (settings.rhythmLatencyMs)
    {
        projectm_set_rhythm_latency(pm, *settings.rhythmLatencyMs);
    }
    if (settings.presetSwitchPhrase)
    {
        projectm_set_preset_switch_phrase(pm, *settings.presetSwitchPhrase);
    }
    if (settings.sectionHardCut)
    {
        projectm_set_section_hard_cut(pm, *settings.sectionHardCut);
    }
    if (settings.flashLimitThreshold)
    {
        projectm_set_flash_limit_threshold(pm, *settings.flashLimitThreshold);
    }
    if (settings.flashLimitEnabled)
    {
        projectm_set_flash_limit_enabled(pm, *settings.flashLimitEnabled);
    }
    ReapplyLiveInput(host);
    ReapplyQualityTierLimits(host);
}

static void TearDownEngineForRebind(WasmHost& H)
{
    // Take this host out of the shared render loop until start_render() opts it
    // back in. The Emscripten main loop itself is process-global and services
    // every started host, so it is left running: cancelling it here used to stop
    // a sibling host's rendering too (and dropped a paused loop's pause, e.g. the
    // render worker's).
    H.renderLoopStarted = false;

    DestroyEngineAndPlaylist(H);
    ReleaseGraphicsAndContext(H);
}

namespace WasmApi {

// Re-reads a texture file the host rewrote in the VFS (the experimental bridge's
// /textures/pm_depth_map.png) into the host's loaded texture, so a running
// preset samples the new image without a reload. 1 if a loaded texture was updated.
int reload_texture(WasmHost& H, const char* name)
{
    if (!H.appData.projectm_engine || name == nullptr)
    {
        return 0;
    }
    return projectm_reload_texture(H.appData.projectm_engine, name) ? 1 : 0;
}

// The host's engine as the pmHandle the compat PCM and sprite exports take, or
// 0 without an engine. It is the host's handle (HostHandle()), not the engine's
// address: a handle kept past destroy_host() then names no host instead of
// driving whatever engine reuses that memory.
uintptr_t get_projectm_handle(WasmHost& H)
{
    return H.appData.projectm_engine != nullptr ? HostHandle(H) : 0;
}

// User sprites: the projectm_sprite_* C API on the host's engine. libprojectM's
// own projectm_sprite_* exports take a raw engine pointer, which JS cannot be
// trusted with; these reach the engine through the host the barrier resolved,
// and are no-ops (0) for a host without one.
uint32_t sprite_create(WasmHost& H, const char* type, const char* code)
{
    if (!H.appData.projectm_engine || type == nullptr || code == nullptr)
    {
        return 0;
    }
    return projectm_sprite_create(H.appData.projectm_engine, type, code);
}

void sprite_destroy(WasmHost& H, uint32_t spriteId)
{
    if (projectm_handle engine = H.appData.projectm_engine)
    {
        projectm_sprite_destroy(engine, spriteId);
    }
}

void sprite_destroy_all(WasmHost& H)
{
    if (projectm_handle engine = H.appData.projectm_engine)
    {
        projectm_sprite_destroy_all(engine);
    }
}

uint32_t sprite_get_sprite_count(WasmHost& H)
{
    projectm_handle engine = H.appData.projectm_engine;
    return engine != nullptr ? projectm_sprite_get_sprite_count(engine) : 0;
}

// `spriteIds` must hold sprite_get_sprite_count() entries.
void sprite_get_sprite_ids(WasmHost& H, uint32_t* spriteIds)
{
    if (projectm_handle engine = H.appData.projectm_engine; engine != nullptr && spriteIds != nullptr)
    {
        projectm_sprite_get_sprite_ids(engine, spriteIds);
    }
}

void sprite_set_max_sprites(WasmHost& H, uint32_t maxSprites)
{
    if (projectm_handle engine = H.appData.projectm_engine)
    {
        projectm_sprite_set_max_sprites(engine, maxSprites);
    }
}

uint32_t sprite_get_max_sprites(WasmHost& H)
{
    projectm_handle engine = H.appData.projectm_engine;
    return engine != nullptr ? projectm_sprite_get_max_sprites(engine) : 0;
}

double sprite_get_var(WasmHost& H, uint32_t spriteId, const char* varName)
{
    projectm_handle engine = H.appData.projectm_engine;
    return engine != nullptr && varName != nullptr ? projectm_sprite_get_var(engine, spriteId, varName) : 0.0;
}

void sprite_set_var(WasmHost& H, uint32_t spriteId, const char* varName, double value)
{
    projectm_handle engine = H.appData.projectm_engine;
    if (engine != nullptr && varName != nullptr)
    {
        projectm_sprite_set_var(engine, spriteId, varName, value);
    }
}

// Tears the host's engine and GL context down and re-inits it against new
// canvas selectors. A second engine in the same Module is a create_host(), not
// a rebind.
int rebind_canvases(WasmHost& H, const char* primary, const char* secondary)
{
    WasmWebGLSetCanvasSelectors(H, primary, secondary);
    if (H.appData.projectm_engine || WasmWebGLGetContext(H))
    {
        TearDownEngineForRebind(H);
    }
    return InitHost(H);
}

} // namespace WasmApi

// Brings up `H`'s WebGL context, engine and playlist (the body of init() and
// create_host*()). Returns 0 or an init error code (docs/EMSCRIPTEN.md), which
// it has already reported to the page.
int InitHost(WasmHost& H)
{
    // Before the engine exists, so libprojectM's own LOG_* messages reach the console too.
    WasmInstallLogSink();
    auto& pm = H.appData.projectm_engine;
    auto& app_data = H.appData;
    auto& playlist = H.appData.playlist;
    auto& g_dualFbo = H.dualFbo;
    if (pm)
    {
        // Already initialized — but only if the engine's context is still the
        // live one. An engine left on a lost context holds GL names that no
        // longer exist; rebuild it rather than report success.
        if (HostContextIsLive(H) &&
            (emscripten_webgl_get_current_context() == H.glCtx ||
             emscripten_webgl_make_context_current(H.glCtx) == EMSCRIPTEN_RESULT_SUCCESS))
        {
            ReportInitSuccess(H);
            return 0;
        }
        DestroyEngineAndPlaylist(H);
        ReleaseGraphics(H);
        H.renderLoopStarted = false;
    }
    // A context that is lost (context loss teardown keeps its handle for
    // exactly this check) cannot be rebuilt on until the browser restores it:
    // the canvas would hand the same dead context straight back, and an engine
    // made on it would be left holding GL names that vanish on restore. The
    // context-loss overlay's "tap to restore" can call this early.
    if (H.glCtx != 0 && emscripten_is_webgl_context_lost(H.glCtx))
    {
        WASM_LOG_WARN("init: refused – the WebGL context is lost; retry after webglcontextrestored.");
        ReportInitError(H, kInitContextLost, "WebGL context is lost; waiting for the browser to restore it");
        return kInitContextLost;
    }
    ConfigureWasmOpenMPThreadCount();
    WasmWebGLApplyModuleCanvasSelectorsIfPresent(H);
    js_init_projectm_glue();
    // Canvas missing / create failed / make-current failed / software context
    // refused each have their own code (WasmWebGLContext.hpp), already reported.
    if (const int contextRc = WasmWebGLCreateAndActivateContext(H); contextRc != 0)
    {
        return contextRc;
    }

    // Pick the dual-FBO colour format from the extensions the context reported
    // (FboFloatFormat in WasmGraphics.hpp): RGBA16F when renderable, RGBA32F
    // only for fboPrecision "high", RGBA8 for "byte" or as the fallback. The
    // preference comes from the host's create_host_with_config() config (the JS
    // layer maps ?fboPrecision= onto it); nothing here reads the URL.
    g_dualFbo.DetectFormat(H.contextCaps, H.contextConfig.fboPrecision);

    pm = CreateHostEngine(H);
    if (!pm)
    {
        WASM_LOG_ERROR("Failed to create projectM handle");
        ReportInitError(H, 3, "projectm_create() returned null");
        return 3;
    }
    app_data.projectm_engine = pm;
    // Before the first preset the page loads: an engine decides each path the
    // first time it needs it.
    ApplyRenderPathOverrides(H);
    ApplyDeterministicClock(H);
    playlist = projectm_playlist_create(pm);
    ++g_livePlaylistCount;
    const char* loc = "/presets/";
    projectm_playlist_add_path(playlist, loc, true, true);
    // Every callback is addressed to this host (not to whichever is active
    // when it fires); see WasmPlaylistBridge.cpp.
    projectm_playlist_set_preset_switched_event_callback(playlist, &load_preset_callback_done, &H);
    // Every playlist-driven load (manual, timer, switch_preset) is prepared on
    // this host's prepare thread instead of loading synchronously.
    projectm_playlist_set_preset_load_event_callback(playlist, &on_playlist_preset_load, &H);
    if (!H.presetPrepare)
    {
        H.presetPrepare = std::make_unique<PresetPrepareQueue>(HostHandle(H));
    }
    const char* texture_search_paths[] = {"textures"};
    projectm_set_texture_search_paths(pm, texture_search_paths, 1);
    projectm_set_fps(pm, H.targetFps > 0 ? H.targetFps : 60);
    projectm_set_preset_duration(pm, 30.0);
    projectm_set_soft_cut_duration(pm, 17.0);
    // projectm_set_hard_cut_duration(pm, 48.0);
    // projectm_set_hard_cut_enabled(pm, true);
    projectm_set_beat_sensitivity(pm, 1.50);
    projectm_playlist_set_shuffle(playlist, true);
    projectm_set_preset_switch_failed_event_callback(pm, &on_preset_switch_failed, &H);
    projectm_set_preset_switch_requested_event_callback(pm, &on_preset_switch_requested, &H);
    // A re-created engine (context-loss restore, rebind) gets back what the
    // page had set on the one it replaces.
    ReapplyEngineSettings(H);
    InstallShaderTranspileCacheHooks();
    // projectm_playlist_connect(app_data.playlist,app_data.projectm_engine);
    WASM_LOG_INFO("  --==  projectM initialized!  ==--");
    // Allocate this host's PCM ring before any producer can look for it: a
    // worklet the page attaches later reads the ring registry
    // (_attach_worklet_ingest()), and an already-running one (a second
    // create_host()) is sent the new host's descriptor by pcm_ring_init() itself.
    WasmApi::pcm_ring_init(H, 0);
    ReportInitSuccess(H);
    return 0;
}

// Tears down a host whose WebGL context was lost.
//
// Every GL call in here (projectm_destroy(), the compositor release,
// dualFbo.ReleaseAll()) is a no-op on a lost context per the WebGL spec; they
// only reset projectM's bookkeeping so the next init takes the full
// re-initialization path. The context *handle* is kept: InitHost() asks it
// whether the context is still lost and refuses until the browser has restored
// it (it then replaces the handle with a fresh one on the restored context).
void TearDownHostForContextLoss(WasmHost& H)
{
    H.renderLoopStarted = false;
    DestroyEngineAndPlaylist(H);
    ReleaseGraphics(H);
}

namespace WasmApi {

void set_mesh(WasmHost& H, int w, int h)
{
    auto& pm = H.appData.projectm_engine;
    if (w <= 0 || h <= 0)
    {
        return;
    }
    H.engineSettings.meshSize = std::make_pair(static_cast<size_t>(w), static_cast<size_t>(h));
    if (!pm)
    {
        return;
    }
    projectm_set_mesh_size(pm, w, h);
    return;
}

void destruct(WasmHost& H)
{
    // Out of the shared render loop until a start_render() opts it back in.
    H.renderLoopStarted = false;
    DestroyEngineAndPlaylist(H);
    // Release this host's PCM ring (#246: one ring per host, so a sibling's
    // ring and producers are untouched). The worklet is told to detach it.
    pcm_ring_shutdown(H);
    // Phase 2: Release dual FBO resources before destroying the WebGL context
    // to avoid calling OpenGL functions with an invalid context.
    ReleaseGraphicsAndContext(H);
}

// Called from the host page's "webglcontextlost" handler (see
// html/projectm-context-loss.js) for the host that owns the canvas, before the
// browser's "webglcontextrestored" event fires.
void context_lost(WasmHost& H)
{
    TearDownHostForContextLoss(H);
}

// Playlists created by init() that no teardown path has destroyed yet, summed
// over every host. Test hook for the playlist lifecycle (see g_livePlaylistCount).
int live_playlist_count()
{
    return g_livePlaylistCount;
}

void set_aspect_correction(WasmHost& H, bool enabled)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.aspectCorrection = enabled;
    if (!pm)
    {
        return;
    }
    projectm_set_aspect_correction(pm, enabled);
    return;
}

void set_preset_locked(WasmHost& H, bool locked)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.presetLocked = locked;
    if (!pm)
    {
        return;
    }
    projectm_set_preset_locked(pm, locked);
    WASM_LOG_INFO("Preset lock set to: %s", locked ? "true" : "false");
    return;
}

void set_transparency_mode(WasmHost& H, bool enabled)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.transparencyMode = enabled;
    if (!pm)
    {
        return;
    }
    projectm_set_transparency_mode(pm, enabled);
    return;
}

bool get_transparency_mode(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return false;
    }
    return projectm_get_transparency_mode(pm);
}

void set_transparency_threshold(WasmHost& H, float threshold)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.transparencyThreshold = threshold;
    if (!pm)
    {
        return;
    }
    projectm_set_transparency_threshold(pm, threshold);
    return;
}

float get_transparency_threshold(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return 0.01f;
    }
    return projectm_get_transparency_threshold(pm);
}

} // namespace WasmApi

int main()
{
    // The legacy single-engine bring-up: the implicit default host on
    // #mcanvas, if the page has one (else it stays unused for create_host*()
    // to adopt).
    InitDefaultHost();
    return 0;
}
