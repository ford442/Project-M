// WasmRenderPathOverrides.cpp
//
// Ablation switches for the WASM graphics pipeline: ?blurPath=copy,
// ?copyPath=shader and ?perPixelEval=cpu.
//
// Each switch is a projectm_render_path_flags bit (projectm_set_render_path(),
// projectM-4/parameters.h), set per engine. They exist so a single build can be
// A/B'd against its own alternative render paths in the browser without a
// rebuild — see docs/GRAPHICS_PERF_RECOVERY_PLAN.md. (They used to be process
// environment variables, so two engines in one Module could not differ and a
// late call could leave the library's cached and uncached reads disagreeing.)
//
// The host page is the one that knows its URL, so it hands the switches over
// with the create call (create_host_with_config()'s kContextFlagRenderPathSet
// bits), or with set_render_path_overrides() before init(). That is the only way
// they reach the render worker: there globalThis.location is the worker script's
// URL, which carries no query. A host that does neither (the classic in-page
// pages) still gets the old behaviour: init() reads the page's own query string.
//
// The texture-copy switch applies from the next frame; the blur and per-pixel
// switches are decided as each preset is initialized, so they must be in place
// before the first preset loads. ?fboPrecision is not here: it selects the
// dual-FBO format, which travels with the context attributes.
#include "WasmHost.hpp"

namespace {

// The switches as projectm_render_path_flags bits. set_render_path_overrides()
// and get_render_path_overrides() use the same numbering (1 blur copy, 2 copy
// shader, 4 per-pixel CPU).
constexpr uint32_t kKnownRenderPathFlags =
    PROJECTM_RENDER_PATH_BLUR_COPY | PROJECTM_RENDER_PATH_COPY_SHADER | PROJECTM_RENDER_PATH_PER_PIXEL_CPU;

// Hands the host's switches to its engine, if it has one yet.
void PushRenderPathToEngine(const WasmHost& host)
{
    if (projectm_handle engine = host.appData.Engine())
    {
        projectm_set_render_path(engine, host.renderPathFlags);
    }
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

std::optional<uint32_t> RenderPathFromContextFlags(int flags)
{
    if ((flags & kContextFlagRenderPathSet) == 0)
    {
        return std::nullopt;
    }
    return ((flags & kContextFlagBlurCopyPath) != 0 ? PROJECTM_RENDER_PATH_BLUR_COPY : 0u) |
           ((flags & kContextFlagCopyShaderPath) != 0 ? PROJECTM_RENDER_PATH_COPY_SHADER : 0u) |
           ((flags & kContextFlagPerPixelForceCpu) != 0 ? PROJECTM_RENDER_PATH_PER_PIXEL_CPU : 0u);
}

void ApplyRenderPathOverrides(WasmHost& host)
{
    if (!host.renderPathExplicit)
    {
        host.renderPathFlags = static_cast<uint32_t>(js_render_path_overrides_from_location()) & kKnownRenderPathFlags;
    }
    PushRenderPathToEngine(host);
}

extern "C" {

// Sets the active host's render-path ablation switches (each argument 0/1):
//   blurCopyPath      ?blurPath=copy    — legacy render-to-scratch + glCopyTexSubImage2D blur
//   copyShaderPath    ?copyPath=shader  — pre-#179 fullscreen-quad texture copy
//   perPixelForceCpu  ?perPixelEval=cpu — keep per-pixel equations on the CPU evaluator
// Once called, init() no longer reads them from the URL. A host made with
// create_host_with_config() gets them with the create call instead.
EMSCRIPTEN_KEEPALIVE
void set_render_path_overrides(int blurCopyPath, int copyShaderPath, int perPixelForceCpu)
{
    WasmHost& H = Host();
    H.renderPathExplicit = true;
    H.renderPathFlags = (blurCopyPath != 0 ? PROJECTM_RENDER_PATH_BLUR_COPY : 0u) |
                        (copyShaderPath != 0 ? PROJECTM_RENDER_PATH_COPY_SHADER : 0u) |
                        (perPixelForceCpu != 0 ? PROJECTM_RENDER_PATH_PER_PIXEL_CPU : 0u);
    PushRenderPathToEngine(H);
}

// The active host's switches in effect: what its engine reports, or, before the
// engine exists, what init() will give it. Bit 0 blurPath=copy, bit 1
// copyPath=shader, bit 2 perPixelEval=cpu. Lets a host (or a test) confirm a
// switch actually reached this engine.
EMSCRIPTEN_KEEPALIVE
int get_render_path_overrides()
{
    const WasmHost& H = Host();
    if (projectm_handle engine = H.appData.Engine())
    {
        return static_cast<int>(projectm_get_render_path(engine));
    }
    return static_cast<int>(H.renderPathFlags);
}

} // extern "C"
