// WasmWebGLContext.hpp
//
// WebGL 2 context creation/destruction, extension enablement, and configurable
// canvas CSS selectors for the projectM Emscripten/WASM host.
#pragma once

#include "ProjectMWasmInitErrors.hpp"

#include <emscripten/html5_webgl.h>

#include <cstddef>

constexpr size_t kCanvasSelectorMax = 256;

// =============================================================================
// WebGL context configuration (#128 / #84 / #179 A5).
//
// The host used to scrape `?aa=`, `?capture=`, `canvasAA`, and `?fboPrecision=`
// out of window.location / localStorage from inside C++ via EM_ASM. The JS host
// layer is the correct place to read query strings, so those attributes are now
// passed from JS as an argument of host creation (`create_host_with_config()`)
// and consumed at context-creation time. Each WasmHost owns one (#246), so
// engines in one Module can differ.
// Field defaults: MSAA off (#178), preserveDrawingBuffer off, depth/stencil off
// (#246 — FBO 0 is a fullscreen quad + sprites), alpha off (an opaque canvas;
// transparency hosts opt in), premultipliedAlpha on, high-performance GPU,
// RGBA16F dual-FBO precision, software GL accepted, implicit (browser) present,
// no desynchronized hint.
// =============================================================================
struct WasmContextConfig {
    int antialias = 0;                    //!< 0/1 — multisampled canvas (default off, #178).
    int preserveDrawingBuffer = 0;        //!< 0/1 — stable back-buffer for capture/readback.
    int depth = 0;                        //!< 0/1 — canvas depth attachment (default off, #246; sprites-with-depth opt in).
    int stencil = 0;                      //!< 0/1 — canvas stencil attachment (default off, #246).
    int alpha = 0;                        //!< 0/1 — WebGL alpha channel (transparency mode needs it).
    int premultipliedAlpha = 1;           //!< 0/1 — canvas compositing assumes premultiplied colour.
    int failIfMajorPerformanceCaveat = 0; //!< 0/1 — refuse a software (SwiftShader / llvmpipe) context.
    int explicitSwapControl = 0;          //!< 0/1 — present only on emscripten_webgl_commit_frame().
    int desynchronized = 0;               //!< 0/1 — low-latency (desynchronized) canvas hint.
    int powerPreference = 2;              //!< 0 default, 1 low-power, 2 high-performance.
    int fboPrecision = 0;                 //!< Preferred dual-FBO format, as FboFloatFormat: 0 half (RGBA16F), 1 high (RGBA32F), 2 byte (RGBA8).
};

// Bits of create_host_with_config()'s `flags` argument. The JS encoder
// (html/projectm-context-config.js) mirrors these; tests/web reads this header
// to keep the two numberings identical.
enum WasmContextConfigFlag : int
{
    kContextFlagAntialias = 1 << 0,
    kContextFlagPreserveDrawingBuffer = 1 << 1,
    kContextFlagDepth = 1 << 2,
    kContextFlagStencil = 1 << 3,
    kContextFlagAlpha = 1 << 4,
    kContextFlagPremultipliedAlpha = 1 << 5,
    kContextFlagFailIfMajorPerformanceCaveat = 1 << 6,
    kContextFlagExplicitSwapControl = 1 << 7,
    kContextFlagDesynchronized = 1 << 8,
    // Not context attributes: the host's render-path ablation switches
    // (projectm_set_render_path()), which are per engine and so travel with the
    // create call too. Read only when kContextFlagRenderPathSet is present, so a
    // host JS that predates them leaves set_render_path_overrides() in charge.
    kContextFlagBlurCopyPath = 1 << 9,
    kContextFlagCopyShaderPath = 1 << 10,
    kContextFlagPerPixelForceCpu = 1 << 11,
    kContextFlagRenderPathSet = 1 << 12,
};

// Decodes create_host_with_config()'s arguments. Out-of-range enums fall back
// to the defaults (high-performance, RGBA16F).
WasmContextConfig WasmContextConfigFromArgs(int flags, int powerPreference, int fboPrecision);

struct WasmHost;

// Canvas selector configuration (Phase A of #168), per host.
void WasmWebGLSetCanvasSelectors(WasmHost& host, const char* primary, const char* secondary);
void WasmWebGLApplyModuleCanvasSelectorsIfPresent(WasmHost& host);
bool WasmWebGLCanvasElementExists(const char* selector);

// WebGL context lifecycle. Each acts on the host passed in.
// Creates the host's context from host.contextConfig and makes it current.
// Returns kOk, or the failure it already reported through js_report_init_error().
WasmInitError WasmWebGLCreateAndActivateContext(WasmHost& host);
// Presents the frame on a host created with explicitSwapControl (no-op
// otherwise): the only point at which such a canvas shows anything new.
void WasmWebGLCommitFrameIfExplicit(WasmHost& host);
void WasmWebGLDestroyContext(WasmHost& host);
void WasmWebGLResizeCanvases(const WasmHost& host, int width, int height);

// Whether WebGL 2 is available here only through a software renderer
// (SwiftShader, llvmpipe): probed once per Module, on a throwaway 1x1
// OffscreenCanvas with failIfMajorPerformanceCaveat, so the quality governor can
// start such a host on its cheapest tier.
bool WasmWebGLSoftwareRendererOnly();
