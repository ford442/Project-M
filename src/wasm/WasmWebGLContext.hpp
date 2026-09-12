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
// time. Field defaults match the historical behavior (MSAA off since #178,
// preserveDrawingBuffer off, depth/stencil/alpha on, high-performance GPU,
// RGBA16F dual-FBO precision).
// =============================================================================
struct WasmContextConfig {
    int antialias = 0;             //!< 0/1 — multisampled canvas (default off, #178).
    int preserveDrawingBuffer = 0; //!< 0/1 — stable back-buffer for capture/readback.
    int depth = 1;                 //!< 0/1 — canvas depth attachment.
    int stencil = 1;               //!< 0/1 — canvas stencil attachment.
    int alpha = 1;                 //!< 0/1 — alpha channel (transparency overlays).
    int powerPreference = 2;       //!< 0 default, 1 low-power, 2 high-performance.
    int fboPrecision = 0;          //!< Dual-FBO format: 0 half (RGBA16F), 1 high (RGBA32F), 2 byte (RGBA8).
};

// Configure WebGL context attributes + dual-FBO precision from the host JS layer.
// Read at each context creation, so call it before init() / create_host().
void WasmWebGLSetContextConfig(const WasmContextConfig& cfg);
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
