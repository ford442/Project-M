// WasmHost.cpp
//
// Host registry + lifecycle for the multi-instance projectM WASM wrapper
// (#168 Phase B). Owns the active-host pointer, the fixed-size host slot array,
// and the create_host / set_active_host / destroy_host C exports that let a JS
// host (ProjectMContext / <project-m-visualizer>) run more than one engine in a
// single Module without iframes.
//
// See WasmHost.hpp and docs/EMSCRIPTEN.md ("Multi-instance host state").
#include "WasmHost.hpp"

#include <new>

// Engine lifecycle entry points defined in projectM_emscripten.cpp. They
// operate on the active host, so callers here SetActiveHost() first.
extern "C" int init();
extern "C" void destruct();

// =============================================================================
// Registry state
//
// These are the ONE remaining cluster of host-level globals the acceptance
// criteria permit: the active-host pointer and the slot array that tracks the
// (at most kMaxHosts) live instances. All engine/GL/transition state lives in
// the WasmHost structs they point at, not here.
// =============================================================================
static WasmHost* g_hosts[kMaxHosts] = {nullptr};
static WasmHost* g_activeHost = nullptr;
bool g_mainLoopRegistered = false;

WasmHost* AllocateHost()
{
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] == nullptr)
        {
            g_hosts[i] = new (std::nothrow) WasmHost();
            return g_hosts[i];
        }
    }
    return nullptr; // at capacity
}

WasmHost& Host()
{
    if (g_activeHost == nullptr)
    {
        // Lazily bring up the compat default instance (slot 0). It is left
        // un-inited here; the legacy init() path (which calls Host()) does the
        // engine/GL setup.
        WasmHost* def = AllocateHost();
        g_activeHost = def; // AllocateHost() cannot fail for the first slot.
    }
    return *g_activeHost;
}

void SetActiveHost(WasmHost* host)
{
    if (host == nullptr)
    {
        // Fall back to the default/first live host so exports never operate on
        // a null active pointer. (Not Host(): that returns the *current* active
        // host, so set_active_host(0) used to be a silent no-op.)
        for (int i = 0; i < kMaxHosts && host == nullptr; ++i)
        {
            host = g_hosts[i];
        }
        if (host == nullptr)
        {
            g_activeHost = nullptr;
            host = &Host();
        }
    }
    g_activeHost = host;
    if (host->glCtx != 0)
    {
        emscripten_webgl_make_context_current(host->glCtx);
    }
    // libprojectM's transpiled-GLSL cache key is process-wide; keep it on the
    // active host's in-flight load so a compile never sees a sibling's key.
    ArmShaderCacheKeyForHost(*host);
}

void ReleaseHost(WasmHost* host)
{
    if (host == nullptr)
    {
        return;
    }

    // Tear the engine/GL context down under the host's own context so the
    // destroy calls hit the right canvas. destruct() operates on the active
    // host.
    SetActiveHost(host);
    // Abandon any in-flight shader-cache load so libprojectM's process-wide key
    // is not left naming a dead host (a later compile would otherwise store its
    // GLSL under this host's preset key).
    host->shaderCache = ShaderCacheLoadState{};
    ArmShaderCacheKeyForHost(*host);
    destruct();

    int freedSlot = -1;
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] == host)
        {
            g_hosts[i] = nullptr;
            freedSlot = i;
            break;
        }
    }

    if (g_activeHost == host)
    {
        g_activeHost = nullptr;
    }

    // The dual-FBO / compositor destructors issue GL calls; the context is
    // already gone (destruct() destroyed it), so per the WebGL spec they are
    // no-ops — safe.
    delete host;
    (void) freedSlot;

    // Re-point the active host at any surviving instance so subsequent legacy
    // exports keep working; Host() will lazily recreate a default if none.
    if (g_activeHost == nullptr)
    {
        for (int i = 0; i < kMaxHosts; ++i)
        {
            if (g_hosts[i] != nullptr)
            {
                SetActiveHost(g_hosts[i]);
                break;
            }
        }
    }
}

int HostSlotCount()
{
    return kMaxHosts;
}

WasmHost* HostSlot(int index)
{
    if (index < 0 || index >= kMaxHosts)
    {
        return nullptr;
    }
    return g_hosts[index];
}

WasmHost* ActiveHostOrNull()
{
    return g_activeHost;
}

uintptr_t HostHandle(const WasmHost& host)
{
    return reinterpret_cast<uintptr_t>(&host);
}

WasmHost* HostFromHandle(uintptr_t handle)
{
    if (handle == 0)
    {
        return nullptr;
    }
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] != nullptr && HostHandle(*g_hosts[i]) == handle)
        {
            return g_hosts[i];
        }
    }
    return nullptr;
}

int LiveHostCount()
{
    int n = 0;
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] != nullptr)
        {
            ++n;
        }
    }
    return n;
}

// =============================================================================
// C exports (multi-instance API)
// =============================================================================
extern "C" {

// Creates a new engine instance bound to the given canvas selectors, makes it
// the active host, and initialises it. Returns the opaque host handle (a
// WasmHost* as an integer) on success, or 0 if the Module is already at the
// kMaxHosts cap or initialisation failed. The previously-active host is
// restored on failure so a rejected create_host() has no side effects on the
// caller's current instance.
EMSCRIPTEN_KEEPALIVE
uintptr_t create_host(const char* primary, const char* secondary)
{
    WasmHost* previous = g_activeHost;

    WasmHost* host = AllocateHost();
    if (host == nullptr)
    {
        fprintf(stderr, "create_host: refused – already at kMaxHosts (%d) instances.\n", kMaxHosts);
        js_report_init_error(4, "Maximum projectM instances per Module reached");
        return 0;
    }

    // Start from the previous host's context config so a Module configured once
    // keeps that config for every engine. A set_context_config() issued just
    // before this call (while `previous` was active and already had a context)
    // is pending and overrides this snapshot inside init(), right before the
    // context is created — see WasmWebGLContext.cpp.
    if (previous != nullptr)
    {
        host->contextConfig = previous->contextConfig;
    }

    SetActiveHost(host);
    // Writes selectors into the now-active host, marking them explicit so
    // init() does not overwrite them from Module factory config.
    WasmWebGLSetCanvasSelectors(primary, secondary);

    const int rc = init();
    if (rc != 0)
    {
        fprintf(stderr, "create_host: init() failed (rc=%d); rolling back.\n", rc);
        ReleaseHost(host);
        if (previous != nullptr)
        {
            SetActiveHost(previous);
        }
        return 0;
    }

    return reinterpret_cast<uintptr_t>(host);
}

// Selects which host subsequent no-handle exports operate on and makes its
// WebGL context current. A handle of 0 selects the default/first live host.
EMSCRIPTEN_KEEPALIVE
void set_active_host(uintptr_t handle)
{
    SetActiveHost(reinterpret_cast<WasmHost*>(handle));
}

// Returns the active host handle (a WasmHost* as an integer), or 0 if none.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_active_host()
{
    return reinterpret_cast<uintptr_t>(g_activeHost);
}

// Tears down and frees a host created with create_host(). Safe to call with 0
// or an already-released handle (no-op).
EMSCRIPTEN_KEEPALIVE
void destroy_host(uintptr_t handle)
{
    // Ignore handles that are not in the registry (0 / double-free / stale).
    WasmHost* host = HostFromHandle(handle);
    if (host == nullptr)
    {
        return;
    }
    ReleaseHost(host);
}

// Number of currently-allocated engine instances.
EMSCRIPTEN_KEEPALIVE
int host_count()
{
    return LiveHostCount();
}

// The compile-time instance cap (kMaxHosts), so hosts can budget before a
// create_host() that would fail.
EMSCRIPTEN_KEEPALIVE
int max_host_count()
{
    return kMaxHosts;
}

} // extern "C"
