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
// passed from JS as an argument of host creation (`create_host_with_config()`)
// and consumed at context-creation time. Each WasmHost owns one (#246), so
// engines in one Module can differ.
// Field defaults: MSAA off (#178), preserveDrawingBuffer off, depth/stencil off
// (#246 — FBO 0 is a fullscreen quad + sprites), alpha off (an opaque canvas,
// which the page compositor draws without blending), premultipliedAlpha on,
// high-performance GPU, RGBA16F dual-FBO precision, software GL accepted,
// implicit (browser) present, no desynchronized hint.
// =============================================================================
struct WasmContextConfig {
    int antialias = 0;                    //!< 0/1 — multisampled canvas (default off, #178).
    int preserveDrawingBuffer = 0;        //!< 0/1 — stable back-buffer for capture/readback.
    int depth = 0;                        //!< 0/1 — canvas depth attachment (default off, #246; sprites-with-depth opt in).
    int stencil = 0;                      //!< 0/1 — canvas stencil attachment (default off, #246).
    int alpha = 0;                        //!< 0/1 — WebGL alpha channel; only transparency mode needs one (default off).
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
};

// Decodes create_host_with_config()'s arguments. Out-of-range enums fall back
// to the defaults (high-performance, RGBA16F).
WasmContextConfig WasmContextConfigFromArgs(int flags, int powerPreference, int fboPrecision);

// The bits of `flags` this config sets (WasmContextConfigFlag numbering).
int WasmContextConfigFlags(const WasmContextConfig& cfg);

// What the context turned out to offer, probed once when it is created: the one
// place this host enables extensions (Emscripten's enableExtensionsByDefault
// enables them too; asking again here is how the answer is read). Independent
// of the dual-FBO format that was picked: a host that asked for fboPrecision
// "byte" still reports float color buffers as present.
struct WasmContextCaps {
    bool floatColorBuffer = false;     //!< EXT_color_buffer_float: float (RGBA16F / RGBA32F) render targets.
    bool halfFloatColorBuffer = false; //!< EXT_color_buffer_half_float: RGBA16F render targets.
    bool floatLinear = false;          //!< OES_texture_float_linear: RGBA32F can be sampled with GL_LINEAR.
    bool floatBlend = false;           //!< EXT_float_blend: blending into RGBA32F targets.
    bool loseContext = false;          //!< WEBGL_lose_context: the context can be lost and restored on demand.
    //! The attributes the context really has, read back from getContextAttributes()
    //! (WasmContextConfigFlag numbering). Can differ from the config: a browser may
    //! not offer antialias or desynchronized. explicitSwapControl is Emscripten's, not
    //! WebGL's, so it is copied from the config (it is honoured or init() fails).
    int attributeFlags = 0;
    int powerPreference = 2;      //!< As getContextAttributes() reports it, WasmContextConfig numbering.
    bool attributesKnown = false; //!< attributeFlags / powerPreference were read back.
};

// Bits and fields of get_context_snapshot()'s result. The JS decoder
// (decodeContextSnapshot() in html/projectm-context-config.js) mirrors them; tests/web reads this header
// to keep the two layouts identical.
enum WasmContextSnapshotBit : int
{
    kSnapshotValid = 1 << 0,            //!< The host has a context; everything else is 0 without it.
    kSnapshotFloatColorBuffer = 1 << 1, //!< WasmContextCaps::floatColorBuffer
    kSnapshotFloatBlend = 1 << 2,       //!< WasmContextCaps::floatBlend
    kSnapshotLoseContext = 1 << 3,      //!< WasmContextCaps::loseContext
    kSnapshotAttributesKnown = 1 << 4,  //!< WasmContextCaps::attributesKnown: the attribute fields below are set.
};
constexpr int kSnapshotFormatShift = 8;        //!< The active dual-FBO format (FboFloatFormat) sits at this bit...
constexpr int kSnapshotFormatMask = 0x3;       //!< ...in two bits.
constexpr int kSnapshotPowerShift = 12;        //!< WasmContextCaps::powerPreference sits at this bit...
constexpr int kSnapshotPowerMask = 0x3;        //!< ...in two bits.
constexpr int kSnapshotAttributesShift = 16;   //!< WasmContextCaps::attributeFlags sits at this bit...
constexpr int kSnapshotAttributesMask = 0x1FF; //!< ...in nine bits (every WasmContextConfigFlag).

// The active host's config (what its context was / will be created with).
const WasmContextConfig& WasmWebGLGetContextConfig();

// init() / create_host() failure codes for the context stage. Reported through
// js_report_init_error() and readable afterwards with get_last_init_error().
// See docs/EMSCRIPTEN.md "Init Error Codes".
constexpr int kInitContextCreateFailed = 2;     //!< emscripten_webgl_create_context returned 0 (no WebGL 2).
constexpr int kInitCanvasMissing = 6;           //!< Primary canvas selector resolves to nothing.
constexpr int kInitMakeCurrentFailed = 7;       //!< Context created but could not be made current.
constexpr int kInitPerformanceCaveat = 8;       //!< failIfMajorPerformanceCaveat refused a software context.
constexpr int kInitExplicitSwapUnavailable = 9; //!< explicitSwapControl asked of a build linked without OFFSCREEN_FRAMEBUFFER.

// Canvas selector configuration (Phase A of #168).
void WasmWebGLSetCanvasSelectors(const char* primary, const char* secondary);
void WasmWebGLApplyModuleCanvasSelectorsIfPresent();
const char* WasmWebGLGetMainCanvasSelector();
const char* WasmWebGLGetSecondaryCanvasSelector();
bool WasmWebGLCanvasElementExists(const char* selector);

// WebGL context lifecycle.
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE WasmWebGLGetContext();
// Returns 0 on success, otherwise one of the kInit* codes above (already
// reported through js_report_init_error()).
int WasmWebGLCreateAndActivateContext();
// Whether the active host's canvas has an alpha channel: the attribute read
// back from the context, or the requested one before that.
bool WasmWebGLCanvasHasAlpha();
// Presents the frame on a host created with explicitSwapControl (no-op
// otherwise): the only point at which such a canvas shows anything new.
void WasmWebGLCommitFrameIfExplicit();
void WasmWebGLDestroyContext();
void WasmWebGLResizeCanvases(int width, int height);
