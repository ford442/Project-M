// WasmWebGLContext.cpp
//
// WebGL 2 context create/destroy, extension enablement, and configurable canvas
// CSS selectors. See docs/EMSCRIPTEN.md § WebGL context attributes.
#include "WasmWebGLContext.hpp"
#include "WasmHost.hpp"
#include "WasmLog.hpp"

// Per-instance host state (#168 Phase B). The WebGL context handle and the
// canvas CSS selectors were process-global, so a second engine could not own a
// distinct canvas. They are now WasmHost members; mapping the former names to
// the active host's members (same-named local references) keeps the
// create/destroy/resize bodies unchanged. The selector defaults ("#mcanvas" /
// "#scanvas") live on the WasmHost member initialisers.

// WebGL context attributes + dual-FBO precision (#128 / #84 / #179 A5), passed
// from the JS host layer as an argument of create_host_with_config() and read
// at context creation.
//
// Per host (#246): each WasmHost owns the config its context was (or will be)
// created with, so two engines in one Module can differ in antialias /
// fboPrecision / powerPreference. There is no process-wide pending slot: the
// config travels with the create call, so nothing can land on the wrong host
// however the JS side interleaves its awaits.
//
// The config is the request. What the context really has is read back from
// getContextAttributes() into WasmContextCaps::attributeFlags when it is
// created, because the two can differ: a canvas keeps the first context it
// hands out and ignores the attributes of every later getContext() (see
// WasmWebGLCreateAndActivateContext(), which swaps in a fresh canvas for that),
// and a browser may not offer antialias or desynchronized at all.

WasmContextConfig WasmContextConfigFromArgs(int flags, int powerPreference, int fboPrecision)
{
    WasmContextConfig cfg;
    cfg.antialias = (flags & kContextFlagAntialias) != 0 ? 1 : 0;
    cfg.preserveDrawingBuffer = (flags & kContextFlagPreserveDrawingBuffer) != 0 ? 1 : 0;
    cfg.depth = (flags & kContextFlagDepth) != 0 ? 1 : 0;
    cfg.stencil = (flags & kContextFlagStencil) != 0 ? 1 : 0;
    cfg.alpha = (flags & kContextFlagAlpha) != 0 ? 1 : 0;
    cfg.premultipliedAlpha = (flags & kContextFlagPremultipliedAlpha) != 0 ? 1 : 0;
    cfg.failIfMajorPerformanceCaveat = (flags & kContextFlagFailIfMajorPerformanceCaveat) != 0 ? 1 : 0;
    cfg.explicitSwapControl = (flags & kContextFlagExplicitSwapControl) != 0 ? 1 : 0;
    cfg.desynchronized = (flags & kContextFlagDesynchronized) != 0 ? 1 : 0;
    cfg.powerPreference = (powerPreference >= 0 && powerPreference <= 2) ? powerPreference : 2;
    cfg.fboPrecision = (fboPrecision >= 0 && fboPrecision <= 2) ? fboPrecision : 0;
    return cfg;
}

int WasmContextConfigFlags(const WasmContextConfig& cfg)
{
    return (cfg.antialias != 0 ? kContextFlagAntialias : 0) |
           (cfg.preserveDrawingBuffer != 0 ? kContextFlagPreserveDrawingBuffer : 0) |
           (cfg.depth != 0 ? kContextFlagDepth : 0) |
           (cfg.stencil != 0 ? kContextFlagStencil : 0) |
           (cfg.alpha != 0 ? kContextFlagAlpha : 0) |
           (cfg.premultipliedAlpha != 0 ? kContextFlagPremultipliedAlpha : 0) |
           (cfg.failIfMajorPerformanceCaveat != 0 ? kContextFlagFailIfMajorPerformanceCaveat : 0) |
           (cfg.explicitSwapControl != 0 ? kContextFlagExplicitSwapControl : 0) |
           (cfg.desynchronized != 0 ? kContextFlagDesynchronized : 0);
}

const WasmContextConfig& WasmWebGLGetContextConfig()
{
    return Host().contextConfig;
}

extern "C" {
// Legacy shim, kept for host JS written against bundles that predate
// create_host_with_config(). New callers pass the config to
// create_host_with_config() instead. Only the original seven attributes;
// everything added since keeps its default.
//
// No process-global slot: the request lands on the active host. If that host
// has no context yet (before the first init(), or between teardown and
// re-init) it is its config. Otherwise it is held on that host for the next
// context creation — the old "set_context_config(); create_host();" order, in
// which the previous host is still active — which is exactly as racy as it
// always was and why in-tree callers no longer use it.
EMSCRIPTEN_KEEPALIVE
void set_context_config(int antialias, int preserveDrawingBuffer, int depth,
                        int stencil, int alpha, int powerPreference,
                        int fboPrecision)
{
    const int flags = (antialias != 0 ? kContextFlagAntialias : 0) |
                      (preserveDrawingBuffer != 0 ? kContextFlagPreserveDrawingBuffer : 0) |
                      (depth != 0 ? kContextFlagDepth : 0) |
                      (stencil != 0 ? kContextFlagStencil : 0) |
                      (alpha != 0 ? kContextFlagAlpha : 0) |
                      kContextFlagPremultipliedAlpha;
    const WasmContextConfig cfg = WasmContextConfigFromArgs(flags, powerPreference, fboPrecision);
    // Host() lazily allocates the compat default host when none exists; the
    // next create_host*() adopts that host, so this does not spend a slot.
    WasmHost& H = Host();
    if (H.glCtx == 0)
    {
        H.contextConfig = cfg;
        H.hasLegacyPendingContextConfig = false;
        return;
    }
    H.legacyPendingContextConfig = cfg;
    H.hasLegacyPendingContextConfig = true;
}
} // extern "C"

static void CopyCanvasSelector(char* dest, size_t destSize, const char* src, const char* fallback)
{
    const char* value = (src != nullptr && src[0] != '\0') ? src : fallback;
    std::snprintf(dest, destSize, "%s", value);
}

void WasmWebGLSetCanvasSelectors(const char* primary, const char* secondary)
{
    WasmHost& H = Host();
    auto& g_mainCanvasSelector = H.primarySelector;
    auto& g_secondaryCanvasSelector = H.secondarySelector;
    auto& g_canvasSelectorsExplicit = H.canvasSelectorsExplicit;
    if (primary != nullptr && primary[0] != '\0')
    {
        CopyCanvasSelector(g_mainCanvasSelector, sizeof(g_mainCanvasSelector), primary, "#mcanvas");
        g_canvasSelectorsExplicit = true;
    }
    if (secondary != nullptr && secondary[0] != '\0')
    {
        CopyCanvasSelector(g_secondaryCanvasSelector, sizeof(g_secondaryCanvasSelector), secondary, "#scanvas");
        g_canvasSelectorsExplicit = true;
    }
}

void WasmWebGLApplyModuleCanvasSelectorsIfPresent()
{
    WasmHost& H = Host();
    auto& g_mainCanvasSelector = H.primarySelector;
    auto& g_secondaryCanvasSelector = H.secondarySelector;
    auto& g_canvasSelectorsExplicit = H.canvasSelectorsExplicit;
    if (g_canvasSelectorsExplicit)
    {
        return;
    }

    // Pull optional Module factory config into the C selector buffers before
    // creating the WebGL context. Empty / missing properties keep defaults.
    // clang-format off
    EM_ASM({
        function copySel(key, fallback, ptr, len) {
            var sel = fallback;
            try {
                if (typeof Module !== 'undefined' && Module[key]) {
                    sel = String(Module[key]);
                }
            } catch (e) {}
            if (!sel) {
                sel = fallback;
            }
            stringToUTF8(sel, ptr, len);
        }
        copySel('primaryCanvasSelector', '#mcanvas', $0, $1);
        copySel('secondaryCanvasSelector', '#scanvas', $2, $3); }, g_mainCanvasSelector, static_cast<int>(sizeof(g_mainCanvasSelector)), g_secondaryCanvasSelector, static_cast<int>(sizeof(g_secondaryCanvasSelector)));
    // clang-format on
}

const char* WasmWebGLGetMainCanvasSelector()
{
    WasmHost& H = Host();
    auto& g_mainCanvasSelector = H.primarySelector;
    return g_mainCanvasSelector;
}

const char* WasmWebGLGetSecondaryCanvasSelector()
{
    WasmHost& H = Host();
    auto& g_secondaryCanvasSelector = H.secondarySelector;
    return g_secondaryCanvasSelector;
}

bool WasmWebGLCanvasElementExists(const char* selector)
{
    if (selector == nullptr || selector[0] == '\0')
    {
        return false;
    }
    // Resolve the selector the same way emscripten_webgl_create_context() will,
    // so this check cannot disagree with the call it guards: specialHTMLTargets
    // first, then a DOM query.
    //
    // This TU also runs in the OffscreenCanvas render worker, where there is no
    // DOM at all and the canvas arrives by transfer — the worker registers
    // it under this selector in specialHTMLTargets (see
    // html/projectm-render-worker.js). Querying only the DOM here reported
    // "not found" for a canvas the very next line would have resolved fine, and
    // failed init() with code 2 in every worker.
    // clang-format off
    return EM_ASM_INT({
               try {
                   const sel = UTF8ToString($0);
                   const targets = typeof specialHTMLTargets !== 'undefined' ? specialHTMLTargets : null;
                   if (targets && targets[sel]) { return 1; }
                   const doc = globalThis.document;
                   if (!doc) { return 0; }
                   return doc.querySelector(sel) ? 1 : 0;
               } catch (e) {
                   return 0;
               } }, selector) != 0;
    // clang-format on
}

// Builds the WebGL context attributes from the host-supplied WasmContextConfig
// (create_host_with_config() from the JS layer — see WasmWebGLContext.hpp).
//
// Canvas MSAA (governor v2, #178) defaults OFF: what draws into the canvas
// (FBO 0) is a fullscreen quad (the transition blend or final CopyTexture
// present) plus optional user sprites — everything else renders into the
// preset's own FBOs, where MSAA never applied. A fullscreen quad has no interior
// edges, so multisampling it is invisible; only sprite geometry benefits, so the
// host opts in with `antialias: true` (e.g. `?aa=1` parsed in host JS). The
// former `?aa=` / `?capture=` / `localStorage.canvasAA` scraping that lived here
// moved to the host JS layer per #128.
//
// Canvas depth/stencil (#246) default OFF for the same reason: Milkdrop's depth
// and stencil use lives on the preset FBOs, not the canvas. Hosts that draw
// sprites needing a depth buffer opt in with `depth: true` (`?depth=1`).
//
// proxyContextToMainThread is always DISALLOW: the context is created on the
// thread that renders it (the main thread, or the OffscreenCanvas render
// worker). OpenMP helpers and preset prepare threads never issue GL, and a GL
// call from the wrong thread is a bug to fix there, not one to paper over by
// proxying. (The attribute only has an effect in a build linked with
// OFFSCREEN_FRAMEBUFFER, i.e. the explicit-swap flavor; spelled out anyway so
// that flavor cannot silently start proxying.)
static EmscriptenWebGLContextAttributes ProjectMWebGLAttributes(const WasmContextConfig& cfg)
{
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = cfg.alpha != 0;
    attrs.depth = cfg.depth != 0;
    attrs.stencil = cfg.stencil != 0;
    attrs.antialias = cfg.antialias != 0;
    attrs.premultipliedAlpha = cfg.premultipliedAlpha != 0;
    attrs.preserveDrawingBuffer = cfg.preserveDrawingBuffer != 0;
    // Off: only ProjectMEnableRequiredWebGLExtensions() enables extensions, so behaviour does not depend on which
    // extensions a browser happens to offer, and get_context_snapshot() can list the set.
    attrs.enableExtensionsByDefault = false;
    attrs.failIfMajorPerformanceCaveat = cfg.failIfMajorPerformanceCaveat != 0;
    attrs.explicitSwapControl = cfg.explicitSwapControl != 0;
    attrs.desynchronized = cfg.desynchronized != 0;
    attrs.proxyContextToMainThread = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW;
    attrs.powerPreference =
        cfg.powerPreference == 1   ? EM_WEBGL_POWER_PREFERENCE_LOW_POWER
        : cfg.powerPreference == 0 ? EM_WEBGL_POWER_PREFERENCE_DEFAULT
                                   : EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    return attrs;
}

// After a failed create with failIfMajorPerformanceCaveat: would WebGL 2 have
// come up without it? Probed on a throwaway 1x1 OffscreenCanvas, never on the
// host's canvas — a canvas keeps the first context it hands out, so probing it
// would bind the very software context the host refused (and stop the page
// falling back to a 2D canvas there). Only runs on this failure path.
static bool WebGL2AvailableWithoutPerformanceCaveat()
{
    // clang-format off
    return EM_ASM_INT({
               try {
                   if (typeof OffscreenCanvas === 'undefined') { return 0; }
                   const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
                   if (!gl) { return 0; }
                   const lose = gl.getExtension('WEBGL_lose_context');
                   if (lose) { lose.loseContext(); }
                   return 1;
               } catch (e) {
                   return 0;
               } }) != 0;
    // clang-format on
}

// The one place this host enables WebGL extensions; everything else (the
// dual-FBO format choice included) reads the answers from WasmContextCaps.
// enableExtensionsByDefault is off, so this list is the context's whole
// extension set (get_context_snapshot() reports it). The perf HUD's GPU timer
// enables EXT_disjoint_timer_query_webgl2 itself, from JS, only when asked to time.
static WasmContextCaps ProjectMEnableRequiredWebGLExtensions(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx)
{
    WasmContextCaps caps;
    const auto enable = [ctx](const char* name) {
        return emscripten_webgl_enable_extension(ctx, name) == EM_TRUE;
    };
    // Float *textures* are core in WebGL 2; only rendering to them needs an
    // extension. (OES_texture_float / OES_texture_half_float[_linear] are
    // WebGL 1 names and do not exist on a WebGL 2 context.)
    caps.floatColorBuffer = enable("EXT_color_buffer_float");
    if (!caps.floatColorBuffer)
    {
        WASM_LOG_WARN("Warning: EXT_color_buffer_float not supported; float FBO rendering will not be available");
    }
    // RGBA16F alone, on GPUs that cannot render to RGBA32F.
    caps.halfFloatColorBuffer = enable("EXT_color_buffer_half_float");
    caps.floatLinear = enable("OES_texture_float_linear");
    caps.floatBlend = enable("EXT_float_blend");
    if (!caps.floatBlend)
    {
        WASM_LOG_WARN("Warning: EXT_float_blend not supported; float blending will not be available");
    }
    // libprojectM reads these itself: GlDevice::MaxTextureAnisotropy() and
    // SupportsParallelShaderCompile(). Emscripten's glGetStringi lists what the
    // browser supports, not what is enabled, so they must be enabled here.
    caps.textureFilterAnisotropic = enable("EXT_texture_filter_anisotropic");
    caps.parallelShaderCompile = enable("KHR_parallel_shader_compile");
    // Not needed to render: observed so get_context_snapshot() can tell a host
    // whether this context can be made to lose itself (context-loss testing).
    caps.loseContext = enable("WEBGL_lose_context");
    return caps;
}

/**
 * Tag the canvas color spaces after the context is current.
 *
 * Milkdrop presets are authored in an sRGB / Rec.709-like cube. Explicitly
 * tagging the drawing buffer and texture unpack path keeps that look stable
 * on Display-P3 (and future wide-gamut) panels: the browser/OS maps sRGB →
 * the panel, instead of silently reinterpreting RGB numbers as P3.
 *
 * A bundle built with ENABLE_HDR_P3 (PROJECTM_HDR_P3) encodes its composite
 * output in Display-P3 (ShaderTranspiler's HdrOutputFunctions), so its drawing
 * buffer is tagged display-p3; tagging it srgb would make the browser show P3
 * numbers as sRGB. Images are still sRGB files, so unpack stays srgb.
 *
 * Uses Emscripten's GLctx so this works for both the main-thread canvas and
 * the OffscreenCanvas render-worker path (no DOM query).
 * Properties are no-ops on browsers that lack WebGL color management.
 */
static void ProjectMApplyCanvasColorSpace()
{
#ifdef PROJECTM_HDR_P3
    constexpr int displayP3 = 1;
#else
    constexpr int displayP3 = 0;
#endif
    // clang-format off
    EM_ASM({
        try
        {
            var gl = (typeof GLctx !== 'undefined') ? GLctx : null;
            if (!gl)
            {
                return;
            }
            if ('drawingBufferColorSpace' in gl)
            {
                gl.drawingBufferColorSpace = $0 ? 'display-p3' : 'srgb';
            }
            if ('unpackColorSpace' in gl)
            {
                gl.unpackColorSpace = 'srgb';
            }
        }
        catch (e)
        {
        }
    }, displayP3);
    // clang-format on
}

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE WasmWebGLGetContext()
{
    WasmHost& H = Host();
    auto& g_glCtx = H.glCtx;
    return g_glCtx;
}

// The attributes a context created for requestedFlags really has when the
// browser grants everything: the explicit-swap flavor renders through an
// offscreen back buffer, for which Emscripten creates the real context with
// preserveDrawingBuffer.
static int GrantedContextFlags(int requestedFlags)
{
    return (requestedFlags & kContextFlagExplicitSwapControl) != 0 ? requestedFlags | kContextFlagPreserveDrawingBuffer
                                                                   : requestedFlags;
}

// A canvas keeps the first WebGL context it hands out: every later getContext()
// returns that one and ignores the attributes it was given. Destroying the
// Emscripten handle does not undo that. So each context this host creates is
// stamped, on the canvas object itself, with the request it was made for, and
// a create that lands on a canvas stamped with a different request has
// received an old context with old attributes.
//
// An unstamped canvas can still hold a context from before this host (an older
// bundle, or page script). Then the attributes a browser always grants exactly
// as asked (alpha, depth, stencil, premultipliedAlpha, preserveDrawingBuffer)
// give it away; antialias and desynchronized cannot, since a browser may
// legitimately refuse those.
//
// Reads the current context (GLctx).
static bool CurrentCanvasHeldAnotherContext(int requestedFlags, int powerPreference)
{
    const int grantedFlags = GrantedContextFlags(requestedFlags);
    // clang-format off
    return EM_ASM_INT({
               try {
                   const gl = typeof GLctx !== 'undefined' ? GLctx : null;
                   const canvas = gl ? gl.canvas : null;
                   if (!canvas) { return 0; }
                   const stamp = canvas[Symbol.for('projectm.webglContextRequest')];
                   if (stamp) { return (stamp.flags !== $0 || stamp.power !== $1) ? 1 : 0; }
                   const a = gl.getContextAttributes();
                   if (!a) { return 0; }
                   const want = (bit) => ($2 & bit) !== 0;
                   return (a.alpha !== want($3) || a.depth !== want($4) || a.stencil !== want($5)
                           || a.premultipliedAlpha !== want($6) || a.preserveDrawingBuffer !== want($7)) ? 1 : 0;
               } catch (e) {
                   return 0;
               } }, requestedFlags, powerPreference, grantedFlags, kContextFlagAlpha, kContextFlagDepth,
           kContextFlagStencil, kContextFlagPremultipliedAlpha, kContextFlagPreserveDrawingBuffer) != 0;
    // clang-format on
}

// Swaps the canvas element `selector` names for a fresh copy (cloneNode: same
// id, classes, inline style and width/height attributes; no context, no
// listeners) in the same place in the document, so the next create gets a new
// context with the attributes asked for. Fires `projectm-canvas-replaced`
// (bubbling, detail.previous = the old element) on the copy, for hosts that hold
// the element itself rather than its selector.
//
// Returns false where there is no element to swap: in the OffscreenCanvas render
// worker the canvas arrived by transfer, and only the page can give it a new one.
static bool ReplaceCanvasElement(const char* selector)
{
    // clang-format off
    return EM_ASM_INT({
               try {
                   const sel = UTF8ToString($0);
                   const targets = typeof specialHTMLTargets !== 'undefined' ? specialHTMLTargets : null;
                   const doc = globalThis.document;
                   const registered = targets && targets[sel];
                   if (!registered && !doc) {
                       return 0;
                   }
                   const old = registered || doc.querySelector(sel);
                   if (!old || typeof HTMLCanvasElement === 'undefined' || !(old instanceof HTMLCanvasElement) || !old.parentNode) {
                       return 0;
                   }
                   const fresh = old.cloneNode(false);
                   old.parentNode.replaceChild(fresh, old);
                   if (targets && targets[sel] === old) { targets[sel] = fresh; }
                   if (typeof Module !== 'undefined' && Module['canvas'] === old) { Module['canvas'] = fresh; }
                   fresh.dispatchEvent(new CustomEvent('projectm-canvas-replaced', { bubbles: true, detail: { previous: old } }));
                   return 1;
               } catch (e) {
                   return 0;
               } }, selector) != 0;
    // clang-format on
}

// Reads getContextAttributes() of the current context into caps, and stamps its
// canvas with the request it was created for (see
// CurrentCanvasHeldAnotherContext()).
static void ReadContextAttributes(WasmContextCaps& caps, int requestedFlags, int powerPreference)
{
    // Returns the flags with the power preference at bit 16, or -1 when the
    // context cannot say (lost). The body is a macro argument: a comma outside
    // parentheses (an object literal's) would split it.
    // clang-format off
    const int packed = EM_ASM_INT({
        try {
            const gl = typeof GLctx !== 'undefined' ? GLctx : null;
            const a = gl ? gl.getContextAttributes() : null;
            if (!a) { return -1; }
            try { gl.canvas[Symbol.for('projectm.webglContextRequest')] = ({ flags: $0, power: $1 }); } catch (e) {}
            let flags = $0 & $10;
            if (a.antialias) { flags |= $2; }
            if (a.preserveDrawingBuffer) { flags |= $3; }
            if (a.depth) { flags |= $4; }
            if (a.stencil) { flags |= $5; }
            if (a.alpha) { flags |= $6; }
            if (a.premultipliedAlpha) { flags |= $7; }
            if (a.failIfMajorPerformanceCaveat) { flags |= $8; }
            if (a.desynchronized) { flags |= $9; }
            const power = a.powerPreference === 'low-power' ? 1 : a.powerPreference === 'default' ? 0 : 2;
            return flags | (power << 16);
        } catch (e) {
            return -1;
        } }, requestedFlags, powerPreference, kContextFlagAntialias, kContextFlagPreserveDrawingBuffer,
        kContextFlagDepth, kContextFlagStencil, kContextFlagAlpha, kContextFlagPremultipliedAlpha,
        kContextFlagFailIfMajorPerformanceCaveat, kContextFlagDesynchronized, kContextFlagExplicitSwapControl);
    // clang-format on
    if (packed < 0)
    {
        return;
    }
    caps.attributeFlags = packed & 0xFFFF;
    caps.powerPreference = (packed >> 16) & 0x3;
    caps.attributesKnown = true;
}

// emscripten_webgl_create_context() + make current into H.glCtx; 0 or the
// kInit* code, already reported.
static int CreateAndActivate(WasmHost& H, const WasmContextConfig& cfg)
{
    const char* selector = H.primarySelector;
    EmscriptenWebGLContextAttributes webgl_attrs = ProjectMWebGLAttributes(cfg);
    H.glCtx = emscripten_webgl_create_context(selector, &webgl_attrs);
    if (!H.glCtx)
    {
        if (cfg.failIfMajorPerformanceCaveat != 0 && WebGL2AvailableWithoutPerformanceCaveat())
        {
            WASM_LOG_WARN("WebGL context on %s refused: failIfMajorPerformanceCaveat (software renderer)", selector);
            js_report_init_error(kInitPerformanceCaveat,
                                 "Only a software WebGL 2 renderer is available and failIfMajorPerformanceCaveat refused it");
            return kInitPerformanceCaveat;
        }
        WASM_LOG_ERROR("Failed to create WebGL context on %s", selector);
        js_report_init_error(kInitContextCreateFailed, "Failed to create WebGL 2 context");
        return kInitContextCreateFailed;
    }

    const EMSCRIPTEN_RESULT em_res = emscripten_webgl_make_context_current(H.glCtx);
    if (em_res != EMSCRIPTEN_RESULT_SUCCESS)
    {
        WASM_LOG_ERROR("Failed to activate the WebGL context for rendering");
        js_report_init_error(kInitMakeCurrentFailed, "Failed to activate the WebGL context for rendering");
        WasmWebGLDestroyContext();
        return kInitMakeCurrentFailed;
    }
    return 0;
}

int WasmWebGLCreateAndActivateContext()
{
    WasmHost& H = Host();
    auto& g_glCtx = H.glCtx;
    auto& g_mainCanvasSelector = H.primarySelector;
    WasmWebGLDestroyContext();

    // A legacy set_context_config() issued while this host still had its old
    // context (see WasmHost::legacyPendingContextConfig) applies to this one.
    if (H.hasLegacyPendingContextConfig)
    {
        H.contextConfig = H.legacyPendingContextConfig;
        H.hasLegacyPendingContextConfig = false;
    }
    const WasmContextConfig& cfg = H.contextConfig;

    if (!WasmWebGLCanvasElementExists(g_mainCanvasSelector))
    {
        WASM_LOG_ERROR("Failed to find primary canvas selector: %s", g_mainCanvasSelector);
        js_report_init_error(kInitCanvasMissing, "Primary canvas selector not found in document");
        return kInitCanvasMissing;
    }

#ifndef PROJECTM_WASM_OFFSCREEN_FRAMEBUFFER
    // Without OFFSCREENCANVAS_SUPPORT or OFFSCREEN_FRAMEBUFFER (neither is in
    // the production link, see cmake/EmscriptenWasmFlags.cmake) Emscripten's
    // create_context returns 0 for any explicitSwapControl request. Say why
    // rather than report it as "no WebGL 2".
    if (cfg.explicitSwapControl != 0)
    {
        WASM_LOG_ERROR("explicitSwapControl requested, but this bundle was linked without OFFSCREEN_FRAMEBUFFER");
        js_report_init_error(kInitExplicitSwapUnavailable,
                             "explicitSwapControl needs a bundle linked with PROJECTM_WASM_EXPLICIT_SWAP=1");
        return kInitExplicitSwapUnavailable;
    }
#endif

    if (const int rc = CreateAndActivate(H, cfg); rc != 0)
    {
        return rc;
    }

    // Rebind = new canvas: a context created for another request (a previous
    // host or Module on this canvas, a legacy set_context_config() before this
    // re-init) would otherwise be reused as is, and the config would describe
    // attributes the canvas does not have.
    const int requestedFlags = WasmContextConfigFlags(cfg);
    if (CurrentCanvasHeldAnotherContext(requestedFlags, cfg.powerPreference))
    {
        WasmWebGLDestroyContext();
        if (ReplaceCanvasElement(g_mainCanvasSelector))
        {
            WASM_LOG_WARN("WebGL context on %s had other attributes; created it on a fresh canvas element", g_mainCanvasSelector);
        }
        else
        {
            WASM_LOG_WARN("Warning: WebGL context on %s had other attributes and the canvas cannot be replaced here; "
                          "get_context_snapshot() reports the ones it has",
                          g_mainCanvasSelector);
        }
        if (const int rc = CreateAndActivate(H, cfg); rc != 0)
        {
            return rc;
        }
    }

    // Do NOT call gl* here. With USE_GLES, Renderer/OpenGL.h maps gl* → glad_gl*
    // function pointers that remain NULL until GladLoader::Initialize() runs inside
    // projectm_create(). Calling glHint here raises RuntimeError: null function
    // (projectm-v.035-thread regression). Hints are set in start_render() after GLAD loads.
    H.contextCaps = ProjectMEnableRequiredWebGLExtensions(g_glCtx);
    ReadContextAttributes(H.contextCaps, requestedFlags, cfg.powerPreference);
    if (H.contextCaps.attributesKnown &&
        (H.contextCaps.attributeFlags != GrantedContextFlags(requestedFlags) ||
         H.contextCaps.powerPreference != cfg.powerPreference))
    {
        WASM_LOG_WARN("WebGL context on %s: attributes 0x%x (power %d) requested, 0x%x (power %d) granted",
                      g_mainCanvasSelector, requestedFlags, cfg.powerPreference,
                      H.contextCaps.attributeFlags, H.contextCaps.powerPreference);
    }
    ProjectMApplyCanvasColorSpace();
    return 0;
}

bool WasmWebGLCanvasHasAlpha()
{
    const WasmHost& H = Host();
    return H.contextCaps.attributesKnown ? (H.contextCaps.attributeFlags & kContextFlagAlpha) != 0
                                         : H.contextConfig.alpha != 0;
}

void WasmWebGLCommitFrameIfExplicit()
{
    WasmHost& H = Host();
    if (H.glCtx == 0 || H.contextConfig.explicitSwapControl == 0)
    {
        return;
    }
    // With OFFSCREEN_FRAMEBUFFER this blits Emscripten's offscreen back buffer
    // (what FBO 0 maps to on such a context) onto the canvas; until it runs the
    // canvas keeps showing the last committed frame.
    emscripten_webgl_commit_frame();
    H.committedFrameCount++;
}

void WasmWebGLDestroyContext()
{
    WasmHost& H = Host();
    auto& g_glCtx = H.glCtx;
    if (g_glCtx)
    {
        // Release it first. Emscripten caches the calling thread's current handle in C, and
        // destroying the context does not clear that cache. With OFFSCREEN_FRAMEBUFFER, handles
        // are heap pointers, so the next context can get the same address back. Its
        // make_context_current() would then hit the "already current" early return and leave
        // GL.currentContext null (the explicit-swap present_pass crash in glGetStringi).
        if (emscripten_webgl_get_current_context() == g_glCtx)
        {
            emscripten_webgl_make_context_current(0);
        }
        emscripten_webgl_destroy_context(g_glCtx);
        g_glCtx = 0;
    }
    H.contextCaps = WasmContextCaps{};
}

extern "C" {
// The WebGL contract this host negotiated, in one int (see WasmContextSnapshotBit):
// float color buffer / float blend / WEBGL_lose_context as observed on the
// context, the dual-FBO format in the FboFloatFormat numbering at
// kSnapshotFormatShift, and the attributes the context really has
// (getContextAttributes()) at kSnapshotAttributesShift / kSnapshotPowerShift.
// All of it is settled during init(), except that the dual-FBO format can still
// drop to RGBA8 if a float framebuffer turns out incomplete at the first
// transition (CreateFBOWithFallback()). 0 while the host has no context, which
// is also what JS gets before init().
EMSCRIPTEN_KEEPALIVE
int get_context_snapshot()
{
    WasmHost& H = Host();
    if (H.glCtx == 0)
    {
        return 0;
    }
    const WasmContextCaps& caps = H.contextCaps;
    int snapshot = kSnapshotValid;
    snapshot |= caps.floatColorBuffer ? kSnapshotFloatColorBuffer : 0;
    snapshot |= caps.floatBlend ? kSnapshotFloatBlend : 0;
    snapshot |= caps.loseContext ? kSnapshotLoseContext : 0;
    snapshot |= caps.halfFloatColorBuffer ? kSnapshotHalfFloatColorBuffer : 0;
    snapshot |= caps.floatLinear ? kSnapshotFloatLinear : 0;
    snapshot |= caps.textureFilterAnisotropic ? kSnapshotTextureFilterAnisotropic : 0;
    snapshot |= caps.parallelShaderCompile ? kSnapshotParallelShaderCompile : 0;
    snapshot |= kSnapshotExtensionsKnown;
    snapshot |= (static_cast<int>(H.dualFbo.GetFormat()) & kSnapshotFormatMask) << kSnapshotFormatShift;
    if (caps.attributesKnown)
    {
        snapshot |= kSnapshotAttributesKnown;
        snapshot |= (caps.powerPreference & kSnapshotPowerMask) << kSnapshotPowerShift;
        snapshot |= (caps.attributeFlags & kSnapshotAttributesMask) << kSnapshotAttributesShift;
    }
    return snapshot;
}
} // extern "C"

void WasmWebGLResizeCanvases(int width, int height)
{
    WasmHost& H = Host();
    auto& g_mainCanvasSelector = H.primarySelector;
    auto& g_secondaryCanvasSelector = H.secondarySelector;
    emscripten_set_canvas_element_size(g_mainCanvasSelector, width, height);
    if (WasmWebGLCanvasElementExists(g_secondaryCanvasSelector))
    {
        emscripten_set_canvas_element_size(g_secondaryCanvasSelector, width, height);
    }
}
