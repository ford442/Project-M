// WasmWebGLContext.cpp
//
// WebGL 2 context create/destroy, extension enablement, and configurable canvas
// CSS selectors. See docs/EMSCRIPTEN.md § WebGL context attributes.
#include "WasmWebGLContext.hpp"
#include "WasmHost.hpp"

// Per-instance host state (#168 Phase B). The WebGL context handle and the
// canvas CSS selectors were process-global, so a second engine could not own a
// distinct canvas. They are now WasmHost members, and every function here acts
// on the host it is given. The selector defaults ("#mcanvas" / "#scanvas") live
// on the WasmHost member initialisers.

// WebGL context attributes + dual-FBO precision (#128 / #84 / #179 A5), passed
// from the JS host layer as an argument of create_host_with_config() and read
// at context creation.
//
// Per host (#246): each WasmHost owns the config its context was (or will be)
// created with, so two engines in one Module can differ in antialias /
// fboPrecision / powerPreference. Attributes are baked at create time, so a
// host's config is never rewritten once its context exists — the struct always
// describes the live context. There is no process-wide pending slot: the config
// travels with the create call, so nothing can land on the wrong host however
// the JS side interleaves its awaits.

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

void WasmWebGLSetCanvasSelectors(WasmHost& host, const char* primary, const char* secondary)
{
    if (primary != nullptr && primary[0] != '\0')
    {
        CopyCanvasSelector(host.primarySelector, sizeof(host.primarySelector), primary, "#mcanvas");
        host.canvasSelectorsExplicit = true;
    }
    if (secondary != nullptr && secondary[0] != '\0')
    {
        CopyCanvasSelector(host.secondarySelector, sizeof(host.secondarySelector), secondary, "#scanvas");
        host.canvasSelectorsExplicit = true;
    }
}

void WasmWebGLApplyModuleCanvasSelectorsIfPresent(WasmHost& host)
{
    if (host.canvasSelectorsExplicit)
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
        copySel('secondaryCanvasSelector', '#scanvas', $2, $3); }, host.primarySelector, static_cast<int>(sizeof(host.primarySelector)), host.secondarySelector, static_cast<int>(sizeof(host.secondarySelector)));
    // clang-format on
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
    attrs.enableExtensionsByDefault = true;
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

// Probe for WasmWebGLSoftwareRendererOnly(): 1 when a hardware WebGL 2 context
// cannot be had (failIfMajorPerformanceCaveat refuses) but a software one can.
// Same throwaway-OffscreenCanvas rule as above; each probe context is lost right
// away so it does not count against the browser's live-context limit.
// clang-format off
EM_JS(int, js_webgl2_software_only, (), {
    try {
        if (typeof OffscreenCanvas === 'undefined') { return 0; }
        const probe = (attributes) => {
            const gl = new OffscreenCanvas(1, 1).getContext('webgl2', attributes);
            if (!gl) { return false; }
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) { lose.loseContext(); }
            return true;
        };
        if (probe({ failIfMajorPerformanceCaveat: true })) { return 0; }
        return probe({}) ? 1 : 0;
    } catch (e) {
        return 0;
    }
});
// clang-format on

bool WasmWebGLSoftwareRendererOnly()
{
    static const bool softwareOnly = js_webgl2_software_only() != 0;
    return softwareOnly;
}

/**
 * Pin the canvas color spaces to sRGB after the context is current.
 *
 * Milkdrop presets are authored in an sRGB / Rec.709-like cube. Explicitly
 * tagging the drawing buffer and texture unpack path keeps that look stable
 * on Display-P3 (and future wide-gamut) panels: the browser/OS maps sRGB →
 * the panel, instead of silently reinterpreting RGB numbers as P3.
 *
 * Uses Emscripten's GLctx so this works for both the main-thread canvas and
 * the OffscreenCanvas render-worker path (no DOM query).
 * Properties are no-ops on browsers that lack WebGL color management.
 */
static void ProjectMApplySrgbCanvasColorSpace()
{
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
                gl.drawingBufferColorSpace = 'srgb';
            }
            if ('unpackColorSpace' in gl)
            {
                gl.unpackColorSpace = 'srgb';
            }
        }
        catch (e)
        {
        }
    });
    // clang-format on
}

WasmInitError WasmWebGLCreateAndActivateContext(WasmHost& host)
{
    WasmWebGLDestroyContext(host);

    // A legacy set_context_config() issued while this host still had its old
    // context (see WasmHost::legacyPendingContextConfig) applies to this one.
    if (host.hasLegacyPendingContextConfig)
    {
        host.contextConfig = host.legacyPendingContextConfig;
        host.hasLegacyPendingContextConfig = false;
    }
    const WasmContextConfig& cfg = host.contextConfig;

    if (!WasmWebGLCanvasElementExists(host.primarySelector))
    {
        js_report_init_error(WasmInitError::kCanvasMissing,
                             WasmLogFormat("Primary canvas selector %s not found", host.primarySelector).c_str());
        return WasmInitError::kCanvasMissing;
    }

#ifndef PROJECTM_WASM_OFFSCREEN_FRAMEBUFFER
    // Without OFFSCREENCANVAS_SUPPORT or OFFSCREEN_FRAMEBUFFER (neither is in
    // the production link, see cmake/EmscriptenWasmFlags.cmake) Emscripten's
    // create_context returns 0 for any explicitSwapControl request. Say why
    // rather than report it as "no WebGL 2".
    if (cfg.explicitSwapControl != 0)
    {
        js_report_init_error(WasmInitError::kExplicitSwapUnavailable,
                             "explicitSwapControl needs a bundle linked with PROJECTM_WASM_EXPLICIT_SWAP=1");
        return WasmInitError::kExplicitSwapUnavailable;
    }
#endif

    EmscriptenWebGLContextAttributes webgl_attrs = ProjectMWebGLAttributes(cfg);
    host.glCtx = emscripten_webgl_create_context(host.primarySelector, &webgl_attrs);
    if (!host.glCtx)
    {
        if (cfg.failIfMajorPerformanceCaveat != 0 && WebGL2AvailableWithoutPerformanceCaveat())
        {
            js_report_init_error(WasmInitError::kPerformanceCaveat,
                                 "Only a software WebGL 2 renderer is available and failIfMajorPerformanceCaveat refused it");
            return WasmInitError::kPerformanceCaveat;
        }
        js_report_init_error(WasmInitError::kContextCreateFailed,
                             WasmLogFormat("Failed to create a WebGL 2 context on %s", host.primarySelector).c_str());
        return WasmInitError::kContextCreateFailed;
    }

    const EMSCRIPTEN_RESULT em_res = emscripten_webgl_make_context_current(host.glCtx);
    if (em_res != EMSCRIPTEN_RESULT_SUCCESS)
    {
        js_report_init_error(WasmInitError::kMakeCurrentFailed, "Failed to activate the WebGL context for rendering");
        WasmWebGLDestroyContext(host);
        return WasmInitError::kMakeCurrentFailed;
    }

    // Do NOT call gl* here. With USE_GLES, Renderer/OpenGL.h maps gl* → glad_gl*
    // function pointers that remain NULL until GladLoader::Initialize() runs inside
    // projectm_create(). Calling glHint here raises RuntimeError: null function
    // (projectm-v.035-thread regression). Hints are set in start_render() after GLAD loads.
    //
    // No extension enabling either: enableExtensionsByDefault already turned on
    // everything float rendering needs (EXT_color_buffer_float, EXT_float_blend,
    // OES_texture_float_linear), and DualPingPongFramebuffer::DetectFormat()
    // reports when one is missing.
    ProjectMApplySrgbCanvasColorSpace();

    // A context that was allowed to be software-rendered may be: tell the
    // governor, which then starts on its cheapest tier instead of discovering it
    // over the first few hundred frames. (A failIfMajorPerformanceCaveat context
    // is hardware by construction.)
    host.softwareRenderer = cfg.failIfMajorPerformanceCaveat == 0 && WasmWebGLSoftwareRendererOnly();
    return WasmInitError::kOk;
}

void WasmWebGLCommitFrameIfExplicit(WasmHost& host)
{
    if (host.glCtx == 0 || host.contextConfig.explicitSwapControl == 0)
    {
        return;
    }
    // With OFFSCREEN_FRAMEBUFFER this blits Emscripten's offscreen back buffer
    // (what FBO 0 maps to on such a context) onto the canvas; until it runs the
    // canvas keeps showing the last committed frame.
    emscripten_webgl_commit_frame();
    host.committedFrameCount++;
}

void WasmWebGLDestroyContext(WasmHost& host)
{
    if (host.glCtx)
    {
        emscripten_webgl_destroy_context(host.glCtx);
        host.glCtx = 0;
    }
}

void WasmWebGLResizeCanvases(const WasmHost& host, int width, int height)
{
    emscripten_set_canvas_element_size(host.primarySelector, width, height);
    if (WasmWebGLCanvasElementExists(host.secondarySelector))
    {
        emscripten_set_canvas_element_size(host.secondarySelector, width, height);
    }
}
