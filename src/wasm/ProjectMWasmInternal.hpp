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
#include <optional>
#include <string>
#include <vector>

#include <MilkdropPreset/MilkdropStaticShaders.hpp>
#include <Renderer/ShaderTranspileCache.hpp>

struct WasmHost;

// =============================================================================
// AppData – per-instance engine/playlist/loading triple.
//
// Formerly a process-global. As of #168 Phase B it is a member of WasmHost
// (see WasmHost.hpp), one per engine instance, so two visualizers can share a
// single Module without iframes. The former g_* host-state globals (transition
// timeline, dual-FBO manager, quality governor, audio-source flag, WebGL
// context, canvas selectors) are likewise WasmHost members now; every export
// implementation is handed its `WasmHost& H` (WasmApiBarrier.hpp) and binds
// same-named reference aliases so the bodies read unchanged.
// =============================================================================
typedef struct {
    projectm_handle projectm_engine;
    projectm_playlist_handle playlist;
    EM_BOOL loading; //!< A preset preparation is in flight (rendering continues).
} AppData;

// ---- Worklet ring hand-off (defined in WasmAudioBridge.cpp) ---------------
// Publishes / withdraws one host's ring descriptor, tagged with its host
// handle, to the shared AudioWorklet and to the Module-side ring registry the
// postMessage fallback fans out over. Safe to call before the worklet exists.
void PublishPcmRingToWorklet(uintptr_t hostHandle, uintptr_t headerPtr, uintptr_t dataPtr,
                             int capacityFrames, int indexModulus);
// Returns whether a worklet may still hold views of the ring at headerPtr: the
// withdrawal was posted to one over shared memory. Its pcmRingDetached answer
// (WasmApi::pcm_ring_release_retired) says when it no longer does.
bool WithdrawPcmRingFromWorklet(uintptr_t hostHandle, uintptr_t headerPtr);

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
double WasmNow(const WasmHost& host);

// Advances the host's virtual clock by one frame and pushes it into its
// engine. Called once per frame from render_frame(); a no-op unless enabled.
void DeterministicFrameTick(WasmHost& host);

// ---- Engine lifecycle (defined in projectM_emscripten.cpp) ------------------
// InitHost() brings up a host's WebGL context, engine and playlist (init(),
// create_host*(), rebind_canvases()); 0 or an already-reported init error code.
// TearDownHostForContextLoss() drops the engine and GL state of a host whose
// context was lost, keeping the context handle for the restore check.
int InitHost(WasmHost& host);
// InitHost() on Host(), for main()'s legacy bring-up (WasmLegacyExports.cpp).
int InitDefaultHost();
void TearDownHostForContextLoss(WasmHost& host);

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

// ---- Live input (defined in WasmLiveInput.cpp) -----------------------------
// UploadLiveTextures() runs in render_frame() before the engine renders: every
// live texture the page wrote and committed since the last frame is uploaded
// once, however many frames it committed. ReapplyLiveInput() puts the host's
// live textures (with their last frame) and host variables back on a new engine
// (init() after a context loss or a rebind).
void UploadLiveTextures(WasmHost& host);
void ReapplyLiveInput(WasmHost& host);

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
// Applied once from init(), before the first preset renders: whatever the host
// set with set_render_path_overrides(), or else the page's own query string.
// See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
void ApplyRenderPathOverrides(WasmHost& host);

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

// JS glue + host-page notifications (WasmJsBindings.cpp); no DOM, no network
void js_update_preset_name(const char* name);
// `host` is EventHostHandle() of the engine whose preset failed.
void js_report_preset_switch_failed(double host, const char* preset_filename, const char* message);
void js_init_projectm_glue();
} // extern "C"

// Init outcome reports to the page (WasmJsBindings.cpp), for `host`; the
// ForEventHost form takes an EventHostHandle() (kNoEventHost for a create
// refused before any host existed). Each also sets get_last_init_error().
void ReportInitError(const WasmHost& host, int code, const char* detail);
void ReportInitErrorForEventHost(double host, int code, const char* detail);
void ReportInitSuccess(const WasmHost& host);
