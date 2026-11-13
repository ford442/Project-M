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
// Each engine holds its own switches (libprojectM's EngineContext, set with
// projectm_set_render_path_flags()); nothing goes through the process
// environment any more, so two engines in one Module can take different paths
// and a switch set after the first engine still reaches the next one. The
// mask set_render_path_overrides() takes is the page's: it is called before
// create_host*() (there is no host to give it to yet), and every engine
// created afterwards starts from it. get_render_path_overrides() reads one
// engine's switches back. ?fboPrecision is not here: it selects the dual-FBO
// format, which travels with the context attributes in set_context_config().
#include "ProjectMWasmInternal.hpp"
#include "WasmHost.hpp"

#include <projectM-4/debug.h>

#include <optional>

namespace {

// Bits of the render-path override mask (set_render_path_overrides() /
// get_render_path_overrides()): the PROJECTM_RENDER_PATH_* values.
constexpr int kBlurCopyPath = PROJECTM_RENDER_PATH_BLUR_COPY;         //!< ?blurPath=copy
constexpr int kCopyShaderPath = PROJECTM_RENDER_PATH_COPY_SHADER;     //!< ?copyPath=shader
constexpr int kPerPixelForceCpu = PROJECTM_RENDER_PATH_PER_PIXEL_CPU; //!< ?perPixelEval=cpu

// The mask the page handed over with set_render_path_overrides(), for every
// engine created afterwards. Unset: each engine reads the page's query string.
// Page configuration, not engine state (scripts/wasm_globals_allowlist.txt).
std::optional<int> g_pageRenderPathOverrides;

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

// Called from init() straight after the engine is created, before the first
// preset renders.
void ApplyRenderPathOverrides(WasmHost& host)
{
    auto& pm = host.appData.projectm_engine;
    if (pm == nullptr)
    {
        return;
    }
    const int mask = g_pageRenderPathOverrides ? *g_pageRenderPathOverrides : js_render_path_overrides_from_location();
    projectm_set_render_path_flags(pm, static_cast<uint32_t>(mask));
}

namespace WasmApi {

// Sets the render-path ablation switches from the host page, for every engine
// created after this call (call it before init() / create_host*(): an engine
// decides its paths before its first preset). Each argument is 0/1:
//   blurCopyPath      ?blurPath=copy    — legacy render-to-scratch + glCopyTexSubImage2D blur
//   copyShaderPath    ?copyPath=shader  — pre-#179 fullscreen-quad texture copy
//   perPixelForceCpu  ?perPixelEval=cpu — keep per-pixel equations on the CPU evaluator
// Once called, init() no longer reads the switches from the URL.
void set_render_path_overrides(bool blurCopyPath, bool copyShaderPath, bool perPixelForceCpu)
{
    g_pageRenderPathOverrides = (blurCopyPath ? kBlurCopyPath : 0) |
                                (copyShaderPath ? kCopyShaderPath : 0) |
                                (perPixelForceCpu ? kPerPixelForceCpu : 0);
}

// The switches this host's engine runs with: bit 0 blurPath=copy, bit 1
// copyPath=shader, bit 2 perPixelEval=cpu (0 without an engine). Lets a host
// (or a test) confirm a switch actually reached the engine.
int get_render_path_overrides(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    return pm != nullptr ? static_cast<int>(projectm_get_render_path_flags(pm)) : 0;
}

} // namespace WasmApi
