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
#include <emscripten/bind.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <emscripten/val.h>
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
// AppData – per-instance engine/playlist/loading triple.
//
// Formerly a process-global. As of #168 Phase B it is a member of WasmHost
// (see WasmHost.hpp), one per engine instance, so two visualizers can share a
// single Module without iframes. The former g_* host-state globals (transition
// timeline, dual-FBO manager, quality governor, audio-source flag, WebGL
// context, canvas selectors) are likewise WasmHost members now; each TU reaches
// them through `WasmHost& H = Host();` plus same-named reference aliases so the
// export bodies read unchanged.
// =============================================================================
typedef struct {
    projectm_handle projectm_engine;
    projectm_playlist_handle playlist;
    EM_BOOL loading;
} AppData;

// ---- PCM ring (defined in WasmPcmRing.cpp) --------------------------------
// The single audio ingest path. render_frame() drains it once per frame; JS
// producers write into it at audio rate. See WasmPcmRing.cpp for the layout.
// Process-global on purpose: every source writes into one ring, and the active
// host's engine drains it. Per-host rings are a follow-up if two engines need
// independent audio.
extern "C" {
int pcm_ring_init(int capacity_frames);
void pcm_ring_shutdown();
int pcm_ring_drain();
}

// Frames to ignore right after a preset finishes loading. Shared between the
// render loop (projectM_emscripten.cpp) and the governor (WasmPerfGovernor.cpp).
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
void DeterministicFrameTick();

// ---- Render loop (defined in WasmRenderLoop.cpp) ---------------------------
// render_frame() is the single per-frame entry point: the Emscripten main loop
// registered by start_render() calls it, and so does the render worker, which
// pauses that loop and drives frames itself (see WasmDeterminism.cpp).
extern "C" {
void render_frame();
}

// ---- Transpiled-GLSL cache (defined in WasmShaderCache.cpp) ----------------
// Registers the lookup/store callbacks that bridge libprojectM's shader
// transpile cache to the host page. Called once from init().
void InstallShaderTranspileCacheHooks();

// ---- Render-path ablation switches (defined in WasmRenderPathOverrides.cpp) -
// URL query overrides applied once from init(), before the first preset
// renders. See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
void ApplyBlurPathOverride();
void ApplyCopyPathOverride();
bool WasmPreferHighPrecisionFbo();

// ---- Quality governor entry points (defined in WasmPerfGovernor.cpp) -------
void ResetGovernorCounters();
void UpdateQualityGovernor(double frameMs);

// ---- Preset switch callbacks (defined in WasmPlaylistBridge.cpp) -----------
// Registered with projectM/projectM-playlist from init() in
// projectM_emscripten.cpp. Kept at C++ linkage to match the historical
// signatures passed to the projectM callback setters.
void load_preset_callback_done(bool is_hard_cut, unsigned int index, void* user_data);
void on_preset_switch_requested(bool is_hard_cut, void* user_data);
void _on_preset_switch_failed(const char* preset_filename, const char* message, void* user_data);

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
void js_perf_hud_set_enabled(int enabled);
void js_perf_report_frame(double totalMs, double audioMs, double perFrameEvalMs,
                          double perPixelEvalMs, double blurMs, double waveformsShapesMs,
                          double compositeMs, double gpuMs, double fps);

// JS bindings / DOM + host-page notifications (WasmJsBindings.cpp)
void js_update_preset_name(const char* name);
void js_report_preset_switch_failed(const char* preset_filename, const char* message);
void js_init_projectm_dom();
void js_report_init_error(int code, const char* detail);
void js_report_init_success();
} // extern "C"
