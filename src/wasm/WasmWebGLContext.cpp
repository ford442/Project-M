// WasmWebGLContext.cpp
//
// WebGL 2 context create/destroy, extension enablement, and configurable canvas
// CSS selectors. See docs/EMSCRIPTEN.md § WebGL context attributes.
#include "WasmWebGLContext.hpp"
#include "WasmHost.hpp"

using namespace emscripten;

// Per-instance host state (#168 Phase B). The WebGL context handle and the
// canvas CSS selectors were process-global, so a second engine could not own a
// distinct canvas. They are now WasmHost members; mapping the former names to
// the active host's members keeps the create/destroy/resize bodies unchanged.
// The selector defaults ("#mcanvas" / "#scanvas") live on the WasmHost member
// initialisers. None of the EM_ASM/EM_JS bodies below reference these
// identifiers, so these object-like macros do not rewrite the embedded JS.
#define g_glCtx (Host().glCtx)
#define g_mainCanvasSelector (Host().primarySelector)
#define g_secondaryCanvasSelector (Host().secondarySelector)
#define g_canvasSelectorsExplicit (Host().canvasSelectorsExplicit)

// WebGL context attributes + dual-FBO precision, set from the JS host layer via
// set_context_config() and read at context creation (#128 / #84 / #179 A5).
// Process-global "current" config: create_host() calls are sequential and JS
// sets this immediately before each one, so a context created here always sees
// the config intended for it. Defaults live on the struct.
static WasmContextConfig g_contextConfig;

void WasmWebGLSetContextConfig(const WasmContextConfig& cfg)
{
    g_contextConfig = cfg;
}

const WasmContextConfig& WasmWebGLGetContextConfig()
{
    return g_contextConfig;
}

extern "C" {
// Host-driven context configuration. Individual numeric args (rather than a
// packed struct pointer) keep the ccall marshalling simple and robust. Call
// before init() / init_with_canvases() / create_host(); attributes are baked
// into the WebGL context at creation and cannot change afterward.
EMSCRIPTEN_KEEPALIVE
void set_context_config(int antialias, int preserveDrawingBuffer, int depth,
                        int stencil, int alpha, int powerPreference,
                        int fboPrecision)
{
    WasmContextConfig cfg;
    cfg.antialias = antialias ? 1 : 0;
    cfg.preserveDrawingBuffer = preserveDrawingBuffer ? 1 : 0;
    cfg.depth = depth ? 1 : 0;
    cfg.stencil = stencil ? 1 : 0;
    cfg.alpha = alpha ? 1 : 0;
    cfg.powerPreference = (powerPreference >= 0 && powerPreference <= 2) ? powerPreference : 2;
    cfg.fboPrecision = (fboPrecision >= 0 && fboPrecision <= 2) ? fboPrecision : 0;
    WasmWebGLSetContextConfig(cfg);
}
} // extern "C"

static void CopyCanvasSelector(char* dest, size_t destSize, const char* src, const char* fallback)
{
    const char* value = (src != nullptr && src[0] != '\0') ? src : fallback;
    std::snprintf(dest, destSize, "%s", value);
}

void WasmWebGLSetCanvasSelectors(const char* primary, const char* secondary)
{
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
    return g_mainCanvasSelector;
}

const char* WasmWebGLGetSecondaryCanvasSelector()
{
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
// (set via set_context_config() from the JS layer — see WasmWebGLContext.hpp).
//
// Canvas MSAA (governor v2, #178) defaults OFF: what draws into the canvas
// (FBO 0) is a fullscreen quad (the transition blend or final CopyTexture
// present) plus optional user sprites — everything else renders into the
// preset's own FBOs, where MSAA never applied. A fullscreen quad has no interior
// edges, so multisampling it is invisible; only sprite geometry benefits, so the
// host opts in with `antialias: true` (e.g. `?aa=1` parsed in host JS). The
// former `?aa=` / `?capture=` / `localStorage.canvasAA` scraping that lived here
// moved to the host JS layer per #128.
static EmscriptenWebGLContextAttributes ProjectMDefaultWebGLAttributes()
{
    const WasmContextConfig& cfg = WasmWebGLGetContextConfig();

    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = cfg.alpha ? EM_TRUE : EM_FALSE;
    attrs.depth = cfg.depth ? EM_TRUE : EM_FALSE;
    attrs.stencil = cfg.stencil ? EM_TRUE : EM_FALSE;
    attrs.antialias = cfg.antialias ? EM_TRUE : EM_FALSE;
    attrs.premultipliedAlpha = EM_TRUE;
    attrs.preserveDrawingBuffer = cfg.preserveDrawingBuffer ? EM_TRUE : EM_FALSE;
    attrs.enableExtensionsByDefault = EM_TRUE;
    attrs.powerPreference =
        cfg.powerPreference == 1   ? EM_WEBGL_POWER_PREFERENCE_LOW_POWER
        : cfg.powerPreference == 0 ? EM_WEBGL_POWER_PREFERENCE_DEFAULT
                                   : EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    return attrs;
}

static void ProjectMEnableRequiredWebGLExtensions(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx)
{
    emscripten_webgl_enable_extension(ctx, "OES_texture_float");
    emscripten_webgl_enable_extension(ctx, "OES_texture_half_float");
    emscripten_webgl_enable_extension(ctx, "OES_texture_half_float_linear");
    if (emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_float") != EM_TRUE)
    {
        fprintf(stderr, "Warning: EXT_color_buffer_float not supported; float FBO rendering will not be available\n");
    }
    if (emscripten_webgl_enable_extension(ctx, "EXT_float_blend") != EM_TRUE)
    {
        fprintf(stderr, "Warning: EXT_float_blend not supported; float blending will not be available\n");
    }
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

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE WasmWebGLGetContext()
{
    return g_glCtx;
}

bool WasmWebGLCreateAndActivateContext()
{
    WasmWebGLDestroyContext();

    EmscriptenWebGLContextAttributes webgl_attrs = ProjectMDefaultWebGLAttributes();
    if (!WasmWebGLCanvasElementExists(g_mainCanvasSelector))
    {
        fprintf(stderr, "Failed to find primary canvas selector: %s\n", g_mainCanvasSelector);
        js_report_init_error(2, "Primary canvas selector not found in document");
        return false;
    }

    g_glCtx = emscripten_webgl_create_context(g_mainCanvasSelector, &webgl_attrs);
    if (!g_glCtx)
    {
        fprintf(stderr, "Failed to create WebGL context on %s\n", g_mainCanvasSelector);
        js_report_init_error(2, "Failed to create WebGL 2 context");
        return false;
    }

    const EMSCRIPTEN_RESULT em_res = emscripten_webgl_make_context_current(g_glCtx);
    if (em_res != EMSCRIPTEN_RESULT_SUCCESS)
    {
        fprintf(stderr, "Failed to activate the WebGL context for rendering\n");
        js_report_init_error(2, "Failed to activate the WebGL context for rendering");
        WasmWebGLDestroyContext();
        return false;
    }

    // Do NOT call gl* here. With USE_GLES, Renderer/OpenGL.h maps gl* → glad_gl*
    // function pointers that remain NULL until GladLoader::Initialize() runs inside
    // projectm_create(). Calling glHint here raises RuntimeError: null function
    // (projectm-v.035-thread regression). Hints are set in start_render() after GLAD loads.
    ProjectMEnableRequiredWebGLExtensions(g_glCtx);
    ProjectMApplySrgbCanvasColorSpace();
    return true;
}

void WasmWebGLDestroyContext()
{
    if (g_glCtx)
    {
        emscripten_webgl_destroy_context(g_glCtx);
        g_glCtx = 0;
    }
}

void WasmWebGLResizeCanvases(int width, int height)
{
    emscripten_set_canvas_element_size(g_mainCanvasSelector, width, height);
    if (WasmWebGLCanvasElementExists(g_secondaryCanvasSelector))
    {
        emscripten_set_canvas_element_size(g_secondaryCanvasSelector, width, height);
    }
}
