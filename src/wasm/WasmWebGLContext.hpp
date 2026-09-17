// WasmWebGLContext.hpp
//
// WebGL 2 context creation/destruction, extension enablement, and configurable
// canvas CSS selectors for the projectM Emscripten/WASM host.
#pragma once

#include <emscripten/html5_webgl.h>

constexpr size_t kCanvasSelectorMax = 256;

// =============================================================================
// WebGL context configuration (#128 / #84 / #179 A5).
//
// The host used to scrape `?aa=`, `?capture=`, `canvasAA`, and `?fboPrecision=`
// out of window.location / localStorage from inside C++ via EM_ASM. The JS host
// layer is the correct place to read query strings, so those attributes are now
// set from JS through `set_context_config()` and consumed at context-creation
// time. Each WasmHost owns one (#246), so engines in one Module can differ.
// Field defaults: MSAA off (#178), preserveDrawingBuffer off, depth/stencil off
// (#246 — FBO 0 is a fullscreen quad + sprites), alpha on, high-performance
// GPU, RGBA16F dual-FBO precision.
// =============================================================================
struct WasmContextConfig {
    int antialias = 0;             //!< 0/1 — multisampled canvas (default off, #178).
    int preserveDrawingBuffer = 0; //!< 0/1 — stable back-buffer for capture/readback.
    int depth = 0;                 //!< 0/1 — canvas depth attachment (default off, #246; sprites-with-depth opt in).
    int stencil = 0;               //!< 0/1 — canvas stencil attachment (default off, #246).
    int alpha = 1;                 //!< 0/1 — alpha channel (transparency overlays).
    int powerPreference = 2;       //!< 0 default, 1 low-power, 2 high-performance.
    int fboPrecision = 0;          //!< Dual-FBO format: 0 half (RGBA16F), 1 high (RGBA32F), 2 byte (RGBA8).
};

// Configure WebGL context attributes + dual-FBO precision from the host JS layer.
// Applies to the active host if it has no context yet; otherwise it is held for
// the next host that creates a context (create_host()). Call it before init() /
// create_host().
void WasmWebGLSetContextConfig(const WasmContextConfig& cfg);
// The active host's config (what its context was / will be created with).
const WasmContextConfig& WasmWebGLGetContextConfig();

// Canvas selector configuration (Phase A of #168).
void WasmWebGLSetCanvasSelectors(const char* primary, const char* secondary);
void WasmWebGLApplyModuleCanvasSelectorsIfPresent();
const char* WasmWebGLGetMainCanvasSelector();
const char* WasmWebGLGetSecondaryCanvasSelector();
bool WasmWebGLCanvasElementExists(const char* selector);

// WebGL context lifecycle.
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE WasmWebGLGetContext();
bool WasmWebGLCreateAndActivateContext();
void WasmWebGLDestroyContext();
void WasmWebGLResizeCanvases(int width, int height);
