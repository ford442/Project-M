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
#include <unistd.h>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten/html5.h>
#include <projectM-4/playlist.h>
#include <projectM-4/projectM.h>
#include <projectM-4/projectm_perf.h>
#include <emscripten/html5_webgl.h>

#ifdef __EMSCRIPTEN__
#ifndef USE_GLES
#define USE_GLES
#endif
#endif

#include <cstdint>
#include <cstdio>
#include <vector>
#include <limits>
#include <cmath>
#include <algorithm>
#include <optional>
#include <string>

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
// AppData – ownership record for the process-global projectM engine instance.
//
// NOTE: this is still process-global for now (see #163 / #168). Canvas CSS
// selectors are configurable (Phase A); true multi-instance host state remains
// a follow-up. Until then, the globals below are declared here and defined
// once in ProjectMWasmMain (projectM_emscripten.cpp).
// =============================================================================
typedef struct {
    projectm_handle projectm_engine;
    projectm_playlist_handle playlist;
    EM_BOOL loading;
} AppData;

// ---- Core engine state (defined in projectM_emscripten.cpp) ----------------
extern projectm_handle pm;
extern AppData app_data;
extern projectm_playlist_handle playlist;

// ---- Async preset loading / transition gating (defined in projectM_emscripten.cpp) ----
extern bool g_presetBReady;
extern uint32_t g_renderedFrameCount;
extern uint32_t g_presetReadyFrame;
extern bool g_presetSwitchFailed;

// ---- Transition controller state (defined in WasmDualFbo.cpp) --------------
extern float  g_transitionDuration;
extern bool   g_transitionActive;
extern float  g_transitionBlend;
extern double g_transitionStartTime;

// ---- Audio bridge state (defined in WasmAudioBridge.cpp) -------------------
extern bool g_is_streaming_audio;

// ---- Perf HUD / quality governor state (defined in WasmPerfGovernor.cpp) ---
extern bool g_perfHudEnabled;
extern bool g_wasLoading;
extern int  g_postLoadGraceFrames;

// Frames to ignore right after a preset finishes loading. Shared between the
// render loop (projectM_emscripten.cpp) and the governor (WasmPerfGovernor.cpp).
constexpr int kPostLoadGraceFrames = 10;

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
void js_feed_stream_data_to_projectm(uintptr_t pm_handle, int buffer_size);
void js_initialize_stream_analyser();
void js_initialize_worklet_system_once(uintptr_t pm_handle_for_addpcm);

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
