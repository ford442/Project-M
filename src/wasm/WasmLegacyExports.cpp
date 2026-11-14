// WasmLegacyExports.cpp
//
// The compat-only exports (scope "legacy" in cmake/WasmApiManifest.cmake):
// the single-engine API from before ABI v2 (#352), which acts on the host
// set_active_host() selected, lazily creating the implicit default host the
// way init() always has. Every other export names its host; these are the only
// implementations that look the active host up, and they go away with the
// compat shims. scripts/check_wasm_host_globals.sh fails a Host() call
// anywhere else.
#include "WasmHost.hpp"
#include "WasmLog.hpp"

int InitDefaultHost()
{
    return InitHost(Host());
}

namespace WasmApi {

// init() / pm_init(host): (re)brings up the host's WebGL context, engine and
// playlist. With no host (init() on a page that never created one) it is the
// implicit default host Host() makes, which is why it lives with the compat
// exports. Prefer create_host_with_config(), which returns a handle; pm_init()
// is how a host re-inits after a context loss.
int init(WasmHost& H)
{
    return InitHost(H);
}

void set_canvas_selectors(const char* primary, const char* secondary)
{
    WasmWebGLSetCanvasSelectors(Host(), primary, secondary);
}

int init_with_canvases(const char* primary, const char* secondary)
{
    WasmHost& H = Host();
    WasmWebGLSetCanvasSelectors(H, primary, secondary);
    return InitHost(H);
}

// Kept for host JS written against bundles that predate
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
void set_context_config(int antialias, int preserveDrawingBuffer, int depth, int stencil, int alpha, int powerPreference, int fboPrecision)
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

// The pre-v2 context-loss entry point. The loss belongs to the host that owns
// the canvas, which need not be the active one: every host whose context
// reports lost is torn down, and the last of them is left active so the
// restore path's init() / start_render() rebuild that host rather than a
// healthy sibling. Called when no context actually reports lost (a page
// simulating the event), it tears down the active host, as it always has.
// A host-bound caller uses pm_context_lost(host) instead.
void pm_handle_context_loss()
{
    WasmHost* lostHost = nullptr;
    const int slots = HostSlotCount();
    for (int i = 0; i < slots; ++i)
    {
        WasmHost* host = HostSlot(i);
        if (host == nullptr || host->glCtx == 0 || !emscripten_is_webgl_context_lost(host->glCtx))
        {
            continue;
        }
        SetActiveHost(host);
        TearDownHostForContextLoss(*host);
        lostHost = host;
    }
    if (lostHost == nullptr)
    {
        WasmHost& H = Host();
        BindHost(H);
        TearDownHostForContextLoss(H);
    }
}

// The oldest PCM feed: mono uint8 into the active host's engine.
void add_audio_data(uint8_t* data, int len)
{
    WasmHost& H = Host();
    if (H.appData.projectm_engine == nullptr || data == nullptr)
    {
        return;
    }
    projectm_pcm_add_uint8(H.appData.projectm_engine, data, len, PROJECTM_MONO);
}

} // namespace WasmApi
