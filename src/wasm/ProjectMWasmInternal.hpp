// ProjectMWasmInternal.hpp
//
// Shared internal declarations for the projectM Emscripten/WASM host wrapper.
//
// The WASM host glue was historically a single ~3100-line translation unit
// (projectM_emscripten.cpp). It is now split into focused compilation units
// that all share this header for the common Emscripten/projectM/GL includes
// and for the small amount of cross-TU state that the render loop, audio
// bridge, quality governor, dual-FBO transition system, and playlist bridge
// must agree on.
//
// See docs/EMSCRIPTEN.md ("Where to add a WASM export") for the file layout
// and how new EMSCRIPTEN_KEEPALIVE exports are wired into the build.
#pragma once

#include "ProjectMWasmBuildConfig.hpp"
#include "ProjectMWasmInitErrors.hpp"
#include "omp.h"
#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <projectM-4/playlist.h>
#include <projectM-4/projectM.h>
#include <projectM-4/projectm_perf.h>
#include <unistd.h>

#ifdef __EMSCRIPTEN__
#ifndef USE_GLES
#define USE_GLES
#endif
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <Logging.hpp>
#include <MilkdropPreset/MilkdropStaticShaders.hpp>
#include <Renderer/ShaderTranspileCache.hpp>

#ifndef USE_GLES
#define GL_GLEXT_PROTOTYPES
#define GL_FRAGMENT_PRECISION_HIGH
#include <GL/gl.h>
#include <GL/glext.h>
#include <GLES3/gl31.h>
// #include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <GLES3/gl3.h>
#endif

#ifndef GL_CONTEXT_PROFILE_MASK
#define GL_CONTEXT_PROFILE_MASK 0x9126
#endif
#ifndef GL_CONTEXT_COMPATIBILITY_PROFILE_BIT
#define GL_CONTEXT_COMPATIBILITY_PROFILE_BIT 0x00000002
#endif
#ifndef GL_CONTEXT_CORE_PROFILE_BIT
#define GL_CONTEXT_CORE_PROFILE_BIT 0x00000001
#endif
#ifndef CONTEXT_FLAG_NO_ERROR_BIT_KHR
#define CONTEXT_FLAG_NO_ERROR_BIT_KHR 0x00000008
#endif
#ifndef GL_ANISOTROPIC_FILTER
#define GL_ANISOTROPIC_FILTER 0x3000
#endif
#ifndef GL_TEXTURE_MAX_ANISOTROPY_EXT
#define GL_TEXTURE_MAX_ANISOTROPY_EXT 0x84FE
#endif
#ifndef GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT
#define GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT 0x84FF
#endif

// =============================================================================
// Logging.
//
// The wrapper logs through libprojectM's LOG_* macros (Logging.hpp), like the
// library itself; InstallWasmLogSink() (called once by init()) routes both to
// the browser console. LOG_DEBUG / LOG_TRACE compile away unless the build
// defines ENABLE_DEBUG_LOGGING, so per-frame and per-call chatter costs nothing
// in a release bundle; the sink drops anything below Warning there as well.
// Init failures are not logged here: js_report_init_error() is their channel to
// the page (the overlay and ProjectMContext's `error` event).
// =============================================================================

// The LOG_* macros name the class unqualified.
using libprojectM::Logging;

// printf-style formatting for a LOG_*() message. The macros only evaluate their
// argument when the level is enabled, so a disabled message is never formatted.
std::string WasmLogFormat(const char* format, ...) __attribute__((format(printf, 1, 2)));

// Registers the console sink as libprojectM's global log callback. Idempotent.
void InstallWasmLogSink();

// =============================================================================
// AppData – per-instance engine/playlist/loading triple.
//
// Formerly a process-global. As of #168 Phase B it is a member of WasmHost
// (see WasmHost.hpp), one per engine instance, so two visualizers can share a
// single Module without iframes. The former g_* host-state globals (transition
// timeline, dual-FBO manager, quality governor, audio-source flag, WebGL
// context, canvas selectors) are likewise WasmHost members now: an export
// resolves the active host once (`WasmHost& H = Host();`) and passes it on to
// whatever it calls.
// =============================================================================
struct EngineDeleter {
    void operator()(projectm_handle engine) const
    {
        projectm_destroy(engine);
    }
};

struct PlaylistDeleter {
    void operator()(projectm_playlist_handle playlist) const
    {
        projectm_playlist_destroy(playlist);
    }
};

struct AppData {
    // Members are destroyed in reverse order, so the playlist goes first: it
    // holds the engine handle and unregisters its callbacks from it.
    std::unique_ptr<projectm, EngineDeleter> engine;
    std::unique_ptr<projectm_playlist, PlaylistDeleter> playlist;
    EM_BOOL loading = EM_FALSE; //!< A preset preparation is in flight (rendering continues).

    projectm_handle Engine() const
    {
        return engine.get();
    }

    projectm_playlist_handle Playlist() const
    {
        return playlist.get();
    }
};

// ---- PCM ring (defined in WasmPcmRing.cpp) --------------------------------
// The single audio ingest path. render_frame() drains it once per frame; JS
// producers write into it at audio rate. See WasmPcmRing.cpp for the layout.
// One ring per WasmHost (#246), so draining host A never consumes host B's
// writes. PcmRingInit() returns 1 on success (idempotent for an unchanged
// capacity, 0 = the default); PcmRingDrain() returns the frames it fed.
struct WasmHost;
int PcmRingInit(WasmHost& host, int capacityFrames);
void PcmRingShutdown(WasmHost& host);
int PcmRingDrain(WasmHost& host);

// ---- Worklet ring hand-off (defined in WasmAudioBridge.cpp) ---------------
// Publishes / withdraws one host's ring descriptor, tagged with its host
// handle, to the shared AudioWorklet and to the Module-side ring registry the
// postMessage fallback fans out over. Safe to call before the worklet exists.
void PublishPcmRingToWorklet(uintptr_t hostHandle, uintptr_t headerPtr, uintptr_t dataPtr,
                             int capacityFrames, int indexModulus);
void WithdrawPcmRingFromWorklet(uintptr_t hostHandle);

// Frames to ignore right after a preset finishes loading. Shared between preset
// activation (WasmPresetPrepare.cpp) and the governor (WasmPerfGovernor.cpp).
constexpr int kPostLoadGraceFrames = 10;

// ---- Deterministic clock (defined in WasmDeterminism.cpp) -----------------
// WasmNow() is the host's time base for anything whose *result* must be
// reproducible (transition blend progress, dual-FBO idle release). It returns
// emscripten_get_now() unless the harness enabled the virtual clock, in which
// case frame N reads exactly N/fps. Code that measures how long something
// actually took — the quality governor's frame cost — must keep calling
// emscripten_get_now() directly. See WasmDeterminism.cpp.
double WasmNow();

// Advances the virtual clock by one frame and pushes it into the engine.
// Called once per frame from render_frame(); a no-op unless enabled.
void DeterministicFrameTick(WasmHost& host);

// ---- Render loop (defined in WasmRenderLoop.cpp) ---------------------------
// render_frame() is the single per-frame entry point: the Emscripten main loop
// registered by start_render() calls it, and so does the render worker, which
// pauses that loop and drives frames itself (see WasmDeterminism.cpp).
extern "C" {
void render_frame();
}

// ---- Musical-time events (defined in WasmRhythm.cpp) -----------------------
// CollectRhythmEvents() runs after every engine render inside render_frame() and
// remembers the beat/bar/section events of the frame; FlushRhythmEvents() runs once
// at the end of render_frame() and reports them to the page, if it asked for them
// with set_rhythm_events(). Two calls because a crossfade renders the engine twice
// per frame, and only the first render of the frame sees the events.
void CollectRhythmEvents(WasmHost& host);
void FlushRhythmEvents(WasmHost& host);

// The crossfade length transition_start() should arm: transition_set_duration_beats()
// resolved against the current tempo, or the duration in seconds.
float ResolveTransitionDuration(WasmHost& host);

// ---- Present pass (defined in WasmPresent.cpp) -----------------------------
// TakeRequestedFrameCapture() runs at the end of render_frame(), after the
// compositor and before the manual-present commit: if the page asked for this
// frame with capture_frame_request(), it is read from the drawing buffer here.
// ReleaseFrameCapture() frees the host's readback buffers with its other GL
// resources (context loss, rebind, destroy).
void TakeRequestedFrameCapture(WasmHost& host);
void ReleaseFrameCapture(WasmHost& host);
// The host's flash-limiter clamp count for the perf HUD: read back from the GPU
// at most every ~0.5 s, the cached value in between; -1 while the limiter is
// off or the host has no engine.
double FlashClampedFramesForHud(WasmHost& host);

// ---- Transpiled-GLSL cache (defined in WasmShaderCache.cpp) ----------------
// Registers the lookup/store callbacks that bridge libprojectM's shader
// transpile cache to the host page. Called once from init().
void InstallShaderTranspileCacheHooks();

// ---- Render-path ablation switches (defined in WasmRenderPathOverrides.cpp) -
// Applied from init(), before the first preset renders: whatever the host set
// with the create call or set_render_path_overrides(), or else the page's own
// query string. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
void ApplyRenderPathOverrides(WasmHost& host);
// create_host_with_config()'s render-path bits as projectm_render_path_flags,
// or nullopt when the caller did not send them (kContextFlagRenderPathSet).
std::optional<uint32_t> RenderPathFromContextFlags(int flags);

// ---- Quality governor entry points (defined in WasmPerfGovernor.cpp) -------
void ResetGovernorCounters(WasmHost& host);
void UpdateQualityGovernor(WasmHost& host, double frameMs);
// Re-applies the host's current tier's blur cap and blur resolution to a
// freshly created engine (the tier's mesh travels in EngineSettings). No-op
// until the governor has picked a tier.
void ReapplyQualityTierLimits(WasmHost& host);

// ---- Preset switch callbacks (defined in WasmPlaylistBridge.cpp) -----------
// Registered with projectM/projectM-playlist from init() in
// projectM_emscripten.cpp. Kept at C++ linkage to match the historical
// signatures passed to the projectM callback setters.
void load_preset_callback_done(bool is_hard_cut, unsigned int index, void* user_data);
bool on_playlist_preset_load(unsigned int index, const char* filename, bool hard_cut, void* user_data);
void on_preset_switch_requested(bool is_hard_cut, void* user_data);
void on_preset_switch_failed(const char* preset_filename, const char* message, void* user_data);

// The host's preset-duration policy (set_preset_duration()): the duration the
// preset just switched to should run, drawing the random part from the host's
// RNG; and (re)seeding that RNG from libprojectM's RandomSeed, which init() and
// set_deterministic_seed() do.
double NextPresetDuration(WasmHost& host);
void SeedPresetDurationRng(WasmHost& host);

// ---- EM_JS host-page hooks called across TU boundaries ---------------------
// Each is implemented via EM_JS (C linkage) in the TU noted; declared here so
// the render loop / init path / callbacks can invoke them.
extern "C" {
// Audio bridge (WasmAudioBridge.cpp)
void js_initialize_worklet_system_once();

// Perf HUD (WasmPerfGovernor.cpp)
void js_perf_gpu_begin_frame();
void js_perf_gpu_end_frame();
double js_perf_gpu_get_last_ms();
void js_perf_hud_set_enabled(double host, int enabled);
void js_perf_report_frame(double host, double totalMs, double audioMs, double perFrameEvalMs,
                          double perPixelEvalMs, double blurMs, double waveformsShapesMs,
                          double compositeMs, double gpuMs, double fps, int shaderLinkPending,
                          int perPixelEvalPath, double rhythmMs, double flashClampedFrames);

// JS bindings / DOM + host-page notifications (WasmJsBindings.cpp)
void js_update_preset_name(const char* name);
void js_report_preset_switch_failed(const char* preset_filename, const char* message);
void js_init_projectm_dom();
void js_report_init_success();
} // extern "C"

// Reports an init() / create_host*() failure to the page (pmReportInitError) and
// records it for get_last_init_error(). Both report for the active host
// (EventHostHandle()); _for_host names it. Defined in WasmJsBindings.cpp.
void js_report_init_error(WasmInitError code, const char* detail);
void js_report_init_error_for_host(double host, WasmInitError code, const char* detail);
