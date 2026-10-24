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

#include <cstdlib>
#include <memory>
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
static std::unique_ptr<WasmHost> g_hosts[kMaxHosts];
static WasmHost* g_activeHost = nullptr;
bool g_mainLoopRegistered = false;

WasmHost* AllocateHost()
{
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (!g_hosts[i])
        {
            // nothrow: an allocation failure is reported to the caller (null)
            // like the cap is, not thrown through an extern "C" export.
            g_hosts[i].reset(new (std::nothrow) WasmHost());
            return g_hosts[i].get();
        }
    }
    return nullptr; // at capacity
}

WasmHost& Host()
{
    if (g_activeHost == nullptr)
    {
        // Lazily bring up the compat default instance. It is left un-inited
        // here; the legacy init() path (which calls Host()) does the
        // engine/GL setup. With no active host every slot is free (an active
        // host is only cleared when none is left), so only an allocation
        // failure leaves this null, and every export dereferences the result:
        // stop here with a message instead of reading through a null pointer.
        WasmHost* def = AllocateHost();
        if (def == nullptr)
        {
            fprintf(stderr, "projectM: could not allocate the default host (out of memory).\n");
            abort();
        }
        def->implicitDefault = true;
        g_activeHost = def;
    }
    return *g_activeHost;
}

// A host Host() conjured for a legacy export that has never been brought up
// (or has been torn down since): no engine, no WebGL context. create_host()
// adopts such a host instead of allocating past it, so a stray legacy call
// before the first create_host*() — set_canvas_selectors(), set_context_config()
// — does not permanently occupy one of the kMaxHosts slots.
static bool IsUnusedImplicitDefault(const WasmHost* host)
{
    return host != nullptr && host->implicitDefault &&
           host->appData.projectm_engine == nullptr && host->glCtx == 0;
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
            host = g_hosts[i].get();
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

    if (g_activeHost == host)
    {
        g_activeHost = nullptr;
    }

    // destruct() released the dual FBOs and the compositor under this host's
    // own context before destroying it, so their destructors find nothing left
    // to delete and issue no GL calls. The prepare queue's destructor joins the
    // host's prepare thread (WasmPresetPrepare.cpp).
    for (auto& slot : g_hosts)
    {
        if (slot.get() == host)
        {
            slot.reset();
            break;
        }
    }

    // Re-point the active host at any surviving instance so subsequent legacy
    // exports keep working; Host() will lazily recreate a default if none.
    if (g_activeHost == nullptr)
    {
        for (int i = 0; i < kMaxHosts; ++i)
        {
            if (g_hosts[i])
            {
                SetActiveHost(g_hosts[i].get());
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
    return g_hosts[index].get();
}

WasmHost* ActiveHostOrNull()
{
    return g_activeHost;
}

uintptr_t HostHandle(const WasmHost& host)
{
    return reinterpret_cast<uintptr_t>(&host);
}

double EventHostHandle(const WasmHost& host)
{
    return host.implicitDefault ? 0.0 : static_cast<double>(HostHandle(host));
}

double ActiveEventHostHandle()
{
    return g_activeHost != nullptr ? EventHostHandle(*g_activeHost) : kNoEventHost;
}

WasmHost* HostFromHandle(uintptr_t handle)
{
    if (handle == 0)
    {
        return nullptr;
    }
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] && HostHandle(*g_hosts[i]) == handle)
        {
            return g_hosts[i].get();
        }
    }
    return nullptr;
}

projectm_handle EngineFromHandle(uintptr_t engineHandle)
{
    if (engineHandle == 0)
    {
        return nullptr;
    }
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] && reinterpret_cast<uintptr_t>(g_hosts[i]->appData.projectm_engine) == engineHandle)
        {
            return g_hosts[i]->appData.projectm_engine;
        }
    }
    return nullptr;
}

int LiveHostCount()
{
    int n = 0;
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i])
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

} // extern "C"

// Shared body of create_host() and create_host_with_config(). `config` is the
// new host's context config; null means the legacy create_host() inheritance
// (a pending legacy set_context_config(), else the previous host's config).
static uintptr_t CreateHost(const char* primary, const char* secondary, const WasmContextConfig* config)
{
    WasmHost* previous = g_activeHost;

    // Reuse the unused compat default rather than allocating a second slot
    // behind it. Whatever the legacy exports configured on it (context config,
    // selectors) carries over; the selectors are overwritten below anyway.
    const bool adopted = IsUnusedImplicitDefault(previous);
    WasmHost* host = adopted ? previous : AllocateHost();
    if (host == nullptr && LiveHostCount() < kMaxHosts)
    {
        fprintf(stderr, "create_host: refused – out of memory for a new host.\n");
        js_report_init_error_for_host(kNoEventHost, 4, "Out of memory for a new projectM instance");
        return 0;
    }
    if (host == nullptr)
    {
        fprintf(stderr, "create_host: refused – already at kMaxHosts (%d) instances.\n", kMaxHosts);
        // No engine exists to name: the active host is the caller's previous
        // one, and this failure is not its.
        js_report_init_error_for_host(kNoEventHost, 4, "Maximum projectM instances per Module reached");
        return 0;
    }
    host->implicitDefault = false;

    if (config != nullptr)
    {
        // The config is an argument of this call: stored on the new host before
        // init() creates its context, so no other caller can get between them.
        host->contextConfig = *config;
        host->hasLegacyPendingContextConfig = false;
    }
    else if (previous != nullptr && !adopted)
    {
        // Legacy: start from the previous host's config so a Module configured
        // once keeps that config for every engine. A set_context_config() issued
        // just before this call, while `previous` was active and already had a
        // context, was parked on `previous` for exactly this hand-off.
        if (previous->hasLegacyPendingContextConfig)
        {
            host->contextConfig = previous->legacyPendingContextConfig;
            previous->hasLegacyPendingContextConfig = false;
        }
        else
        {
            host->contextConfig = previous->contextConfig;
        }
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
        if (previous != nullptr && !adopted)
        {
            SetActiveHost(previous);
        }
        return 0;
    }

    return HostHandle(*host);
}

extern "C" {

// Creates a new engine instance bound to the given canvas selectors, makes it
// the active host, and initialises it. Returns the opaque host handle (a
// WasmHost* as an integer) on success, or 0 if the Module is already at the
// kMaxHosts cap or initialisation failed (get_last_init_error() says which).
// The previously-active host is restored on failure so a rejected create has no
// side effects on the caller's current instance.
//
// `flags` is a WasmContextConfigFlag bitmask (WasmWebGLContext.hpp);
// powerPreference 0 default / 1 low-power / 2 high-performance; fboPrecision
// 0 RGBA16F / 1 RGBA32F / 2 RGBA8. The config belongs to this host alone.
EMSCRIPTEN_KEEPALIVE
uintptr_t create_host_with_config(const char* primary, const char* secondary, int flags,
                                  int powerPreference, int fboPrecision)
{
    const WasmContextConfig cfg = WasmContextConfigFromArgs(flags, powerPreference, fboPrecision);
    return CreateHost(primary, secondary, &cfg);
}

// Legacy form: the new host inherits the previous host's config, or one a
// set_context_config() parked for it. Prefer create_host_with_config().
EMSCRIPTEN_KEEPALIVE
uintptr_t create_host(const char* primary, const char* secondary)
{
    return CreateHost(primary, secondary, nullptr);
}

// Selects which host subsequent no-handle exports operate on and makes its
// WebGL context current. A handle of 0 selects the default/first live host. A
// handle that is not a live host (already destroyed, or never issued) is
// ignored and the active host is left unchanged: dereferencing it would read
// freed memory.
EMSCRIPTEN_KEEPALIVE
void set_active_host(uintptr_t handle)
{
    if (handle == 0)
    {
        SetActiveHost(nullptr);
        return;
    }
    WasmHost* host = HostFromHandle(handle);
    if (host == nullptr)
    {
        fprintf(stderr, "set_active_host: ignoring unknown or destroyed host handle %lu.\n",
                static_cast<unsigned long>(handle));
        return;
    }
    SetActiveHost(host);
}

// Returns the active host handle (a WasmHost* as an integer), or 0 if none.
EMSCRIPTEN_KEEPALIVE
uintptr_t get_active_host()
{
    return g_activeHost != nullptr ? HostHandle(*g_activeHost) : 0;
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
