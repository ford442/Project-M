// WasmRenderPathOverrides.cpp
//
// Ablation switches for the WASM graphics pipeline: ?blurPath=copy,
// ?copyPath=shader and ?perPixelEval=cpu.
//
// Each switch maps to the PROJECTM_* environment variable the engine takes its
// answer from. They exist so a single build can be A/B'd against its own
// alternative render paths in the browser without a rebuild — see
// docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
//
// The host page is the one that knows its URL, so it hands the switches over
// with set_render_path_overrides() before init(). That is the only way they
// reach the render worker: there globalThis.location is the worker script's
// URL, which carries no query, so reading it from here made every switch a
// silent no-op in the default topology. A host that never calls the export
// (the classic in-page pages) still gets the old behaviour: init() reads the
// page's own query string.
//
// Every path below is decided once, before the first preset renders, and never
// re-read. ?fboPrecision is not here: it selects the dual-FBO format, which
// travels with the context attributes in set_context_config().
#include "ProjectMWasmInternal.hpp"

#include <cstdlib>

namespace {

// Bits of the render-path override mask (set_render_path_overrides() /
// get_render_path_overrides()).
constexpr int kBlurCopyPath = 1;     //!< ?blurPath=copy
constexpr int kCopyShaderPath = 2;   //!< ?copyPath=shader
constexpr int kPerPixelForceCpu = 4; //!< ?perPixelEval=cpu

// The host set the switches explicitly; init() must not read the URL over them.
bool g_renderPathOverridesExplicit = false;

void SetOrClearEnv(const char* name, bool enabled, const char* value)
{
    if (enabled)
    {
        setenv(name, value, 1);
    }
    else
    {
        unsetenv(name);
    }
}

void ApplyRenderPathOverrideMask(int mask, bool clearUnset)
{
    const auto apply = [clearUnset](const char* name, bool enabled, const char* value) {
        if (enabled || clearUnset)
        {
            SetOrClearEnv(name, enabled, value);
        }
    };
    apply("PROJECTM_BLUR_COPY_PATH", (mask & kBlurCopyPath) != 0, "1");
    apply("PROJECTM_COPY_SHADER_PATH", (mask & kCopyShaderPath) != 0, "1");
    apply("PROJECTM_PER_PIXEL_EVAL", (mask & kPerPixelForceCpu) != 0, "cpu");
}

} // namespace

// The switches in this page's own query string, as a mask. Only meaningful on
// the main thread: in a worker, location is the worker script's URL.
// clang-format off
EM_JS(int, js_render_path_overrides_from_location, (), {
    if (!globalThis.location || !globalThis.location.search)
    {
        return 0;
    }
    try
    {
        const params = new URLSearchParams(globalThis.location.search);
        const is = (key, value) => (params.get(key) || '').toLowerCase() === value;
        return (is('blurPath', 'copy') ? 1 : 0) |
               (is('copyPath', 'shader') ? 2 : 0) |
               (is('perPixelEval', 'cpu') ? 4 : 0);
    }
    catch (e)
    {
        return 0;
    }
});
// clang-format on

// Called once from init(), before the first preset renders.
void ApplyRenderPathOverrides()
{
    if (g_renderPathOverridesExplicit)
    {
        return;
    }
    ApplyRenderPathOverrideMask(js_render_path_overrides_from_location(), false);
}

extern "C" {

// Sets the render-path ablation switches from the host page (call before
// init() / create_host(); the paths are decided once). Each argument is 0/1:
//   blurCopyPath      ?blurPath=copy    — legacy render-to-scratch + glCopyTexSubImage2D blur
//   copyShaderPath    ?copyPath=shader  — pre-#179 fullscreen-quad texture copy
//   perPixelForceCpu  ?perPixelEval=cpu — keep per-pixel equations on the CPU evaluator
// Once called, init() no longer reads the switches from the URL.
EMSCRIPTEN_KEEPALIVE
void set_render_path_overrides(int blurCopyPath, int copyShaderPath, int perPixelForceCpu)
{
    g_renderPathOverridesExplicit = true;
    ApplyRenderPathOverrideMask((blurCopyPath != 0 ? kBlurCopyPath : 0) |
                                    (copyShaderPath != 0 ? kCopyShaderPath : 0) |
                                    (perPixelForceCpu != 0 ? kPerPixelForceCpu : 0),
                                true);
}

// The switches in effect, read back from the environment the engine consults:
// bit 0 blurPath=copy, bit 1 copyPath=shader, bit 2 perPixelEval=cpu. Lets a
// host (or a test) confirm a switch actually reached this module.
EMSCRIPTEN_KEEPALIVE
int get_render_path_overrides()
{
    const auto isSet = [](const char* name, const char* value) {
        const char* const current = std::getenv(name);
        return current != nullptr && std::string(current) == value;
    };
    return (isSet("PROJECTM_BLUR_COPY_PATH", "1") ? kBlurCopyPath : 0) |
           (isSet("PROJECTM_COPY_SHADER_PATH", "1") ? kCopyShaderPath : 0) |
           (isSet("PROJECTM_PER_PIXEL_EVAL", "cpu") ? kPerPixelForceCpu : 0);
}

} // extern "C"
