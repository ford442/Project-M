// WasmWebGLContext.cpp
//
// WebGL 2 context create/destroy, extension enablement, and configurable canvas
// CSS selectors. See docs/EMSCRIPTEN.md § WebGL context attributes.
#include "WasmWebGLContext.hpp"
#include "ProjectMWasmInternal.hpp"

using namespace emscripten;

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_glCtx = 0;

static char g_mainCanvasSelector[kCanvasSelectorMax] = "#mcanvas";
static char g_secondaryCanvasSelector[kCanvasSelectorMax] = "#scanvas";
static bool g_canvasSelectorsExplicit = false;

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
    return EM_ASM_INT({
               try {
                   return document.querySelector(UTF8ToString($0)) ? 1 : 0;
               } catch (e) {
                   return 0;
               } }, selector) != 0;
}

static EmscriptenWebGLContextAttributes ProjectMDefaultWebGLAttributes()
{
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = EM_TRUE;
    attrs.depth = EM_TRUE;
    attrs.stencil = EM_TRUE;
    attrs.antialias = EM_TRUE;
    attrs.premultipliedAlpha = EM_TRUE;
    attrs.preserveDrawingBuffer = EM_ASM_INT({
        try
        {
            var params = new URLSearchParams(window.location.search || '');
            return (window.__projectMCaptureMode === true || params.get('capture') === '1' || params.get('capture') === 'true') ? 1 : 0;
        }
        catch (e)
        {
            return window.__projectMCaptureMode === true ? 1 : 0;
        }
    })
                                      ? EM_TRUE
                                      : EM_FALSE;
    attrs.enableExtensionsByDefault = EM_TRUE;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
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

    glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT, GL_NICEST);
    glHint(GL_GENERATE_MIPMAP_HINT, GL_NICEST);
    ProjectMEnableRequiredWebGLExtensions(g_glCtx);
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
