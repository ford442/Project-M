// WasmWebGLContext.hpp
//
// WebGL 2 context creation/destruction, extension enablement, and configurable
// canvas CSS selectors for the projectM Emscripten/WASM host.
#pragma once

#include <emscripten/html5_webgl.h>

constexpr size_t kCanvasSelectorMax = 256;

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
