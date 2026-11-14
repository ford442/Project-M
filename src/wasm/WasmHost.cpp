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
#include "WasmApiBarrier.hpp"
#include "WasmLog.hpp"

#include <cstdlib>
#include <memory>
#include <new>
#include <stdexcept>
#include <vector>

namespace {

// Allocation failure is an exception, not an abort. The link allocates with
// mimalloc (MALLOC=mimalloc), which is C: with no new_handler installed its
// operator new calls abort() when the fixed heap is exhausted, taking the
// Module and every host in it down. A handler that throws std::bad_alloc turns
// that into an exception the export barriers record as the host's
// out-of-memory error (WasmApiBarrier.hpp); ABORTING_MALLOC=0 does the same
// for malloc(). tests/wasm-smoke/host_churn.html checks it (pm_debug_throw 2).
[[noreturn]] void ThrowBadAlloc()
{
    throw std::bad_alloc();
}

[[maybe_unused]] const bool kThrowingNewHandler = (std::set_new_handler(ThrowBadAlloc), true);

} // namespace

// =============================================================================
// Registry state
//
// These are the ONE remaining cluster of host-level globals the acceptance
// criteria permit: the active-host pointer and the slot array that tracks the
// (at most kMaxHosts) live instances. All engine/GL/transition state lives in
// the WasmHost structs they point at, not here.
// =============================================================================
static std::unique_ptr<WasmHost> g_hosts[kMaxHosts];
// Advanced whenever a slot is freed, so handles issued for the slot's previous
// occupant stop matching (see HostHandle()).
static uintptr_t g_slotGeneration[kMaxHosts] = {};
static WasmHost* g_activeHost = nullptr;
bool g_mainLoopRegistered = false;

namespace {
constexpr unsigned kHandleSlotBits = 8;
constexpr uintptr_t kHandleSlotMask = (uintptr_t{1} << kHandleSlotBits) - 1;
static_assert(kMaxHosts < static_cast<int>(kHandleSlotMask), "slot index + 1 must fit the handle's low byte");
// Generations wrap here: 24 bits on wasm32, and JS reads handles as `>>> 0`.
constexpr uintptr_t kGenerationMask = (uintptr_t{1} << (32 - kHandleSlotBits)) - 1;
} // namespace

WasmHost* AllocateHost()
{
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (!g_hosts[i])
        {
            // nothrow: an allocation failure is reported to the caller (null)
            // like the cap is, not thrown through an extern "C" export.
            g_hosts[i].reset(new (std::nothrow) WasmHost());
            if (g_hosts[i])
            {
                g_hosts[i]->handle = static_cast<uintptr_t>(i + 1) | (g_slotGeneration[i] << kHandleSlotBits);
            }
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
        // failure leaves this null. That throws: every caller is a compat
        // export behind a barrier (WasmApiBarrier.hpp), which records it
        // rather than letting the Module abort.
        WasmHost* def = AllocateHost();
        if (def == nullptr)
        {
            throw std::bad_alloc();
        }
        def->implicitDefault = true;
        g_activeHost = def;
    }
    return *g_activeHost;
}

uintptr_t ActiveHostHandle() noexcept
{
    try
    {
        return Host().handle;
    }
    catch (...)
    {
        RecordModuleError(WasmApiError::OutOfMemory, "ActiveHostHandle", "could not allocate the default host");
        // No slot index is ever this large, so HostFromHandle() finds nothing.
        return ~uintptr_t{0};
    }
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
    BindHost(*host);
}

void BindHost(WasmHost& host)
{
    if (host.glCtx != 0 && emscripten_webgl_get_current_context() != host.glCtx)
    {
        emscripten_webgl_make_context_current(host.glCtx);
    }
    // libprojectM's transpiled-GLSL cache key is process-wide; keep it on the
    // driven host's in-flight load so a compile never sees a sibling's key.
    ArmShaderCacheKeyForHost(host);
}

WasmHost* ImplicitDefaultHost()
{
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i] && g_hosts[i]->implicitDefault)
        {
            return g_hosts[i].get();
        }
    }
    return nullptr;
}

WasmHost* ResolveHost(uintptr_t handle)
{
    return handle == 0 ? ImplicitDefaultHost() : HostFromHandle(handle);
}

void RecordHostError(uintptr_t handle, WasmApiError code, const char* exportName, const char* message)
{
    WASM_LOG_ERROR("%s: %s (host %lu)", exportName, message, static_cast<unsigned long>(handle));
    // The export that failed may have destroyed its own host.
    if (WasmHost* host = HostFromHandle(handle))
    {
        host->lastErrorCode = static_cast<int>(code);
        // Assigning can itself fail when the heap is exhausted; the code is
        // what callers branch on, so keep it even without the message.
        try
        {
            host->lastErrorMessage = std::string(exportName) + ": " + message;
        }
        catch (...)
        {
            host->lastErrorMessage.clear();
        }
    }
}

void RecordModuleError(WasmApiError code, const char* exportName, const char* message)
{
    WASM_LOG_ERROR("%s: %s (error %d)", exportName, message, static_cast<int>(code));
}

void ReportUnknownHost(const char* exportName, uintptr_t handle)
{
    // Once per handle value: a page polling a destroyed host every frame
    // should not flood the console.
    static uintptr_t lastReported = ~uintptr_t{0};
    if (handle == lastReported)
    {
        return;
    }
    lastReported = handle;
    WASM_LOG_WARN("%s: no live host for handle %lu.", exportName, static_cast<unsigned long>(handle));
}

void ReleaseHost(WasmHost* host)
{
    if (host == nullptr)
    {
        return;
    }

    // Tear the engine/GL context down under the host's own context so the
    // destroy calls hit the right canvas.
    BindHost(*host);
    // Abandon any in-flight shader-cache load so libprojectM's process-wide key
    // is not left naming a dead host (a later compile would otherwise store its
    // GLSL under this host's preset key).
    host->shaderCache = ShaderCacheLoadState{};
    ArmShaderCacheKeyForHost(*host);
    WasmApi::destruct(*host);

    if (g_activeHost == host)
    {
        g_activeHost = nullptr;
    }

    // destruct() released the dual FBOs and the compositor under this host's
    // own context before destroying it, so their destructors find nothing left
    // to delete and issue no GL calls. The prepare queue's destructor joins the
    // host's prepare thread (WasmPresetPrepare.cpp).
    for (int i = 0; i < kMaxHosts; ++i)
    {
        if (g_hosts[i].get() == host)
        {
            g_hosts[i].reset();
            g_slotGeneration[i] = (g_slotGeneration[i] + 1) & kGenerationMask;
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
    return host.handle;
}

double EventHostHandle(const WasmHost& host)
{
    return host.implicitDefault ? 0.0 : static_cast<double>(HostHandle(host));
}

WasmHost* HostFromHandle(uintptr_t handle)
{
    const auto slot = static_cast<int>(handle & kHandleSlotMask) - 1;
    if (slot < 0 || slot >= kMaxHosts || !g_hosts[slot] || g_hosts[slot]->handle != handle)
    {
        return nullptr;
    }
    return g_hosts[slot].get();
}

projectm_handle EngineFromHandle(uintptr_t engineHandle)
{
    const WasmHost* host = HostFromHandle(engineHandle);
    return host != nullptr ? host->appData.projectm_engine : nullptr;
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
        WASM_LOG_ERROR("create_host: refused – out of memory for a new host.");
        ReportInitErrorForEventHost(kNoEventHost, 4, "Out of memory for a new projectM instance");
        return 0;
    }
    if (host == nullptr)
    {
        WASM_LOG_WARN("create_host: refused – already at kMaxHosts (%d) instances.", kMaxHosts);
        // No engine exists to name: the active host is the caller's previous
        // one, and this failure is not its.
        ReportInitErrorForEventHost(kNoEventHost, 4, "Maximum projectM instances per Module reached");
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

    // The new host becomes the active one, as create_host() always made it:
    // compat-shim callers drive it next. Its selectors are marked explicit so
    // init() does not overwrite them from Module factory config.
    SetActiveHost(host);
    WasmWebGLSetCanvasSelectors(*host, primary, secondary);

    const int rc = InitHost(*host);
    if (rc != 0)
    {
        WASM_LOG_ERROR("create_host: init() failed (rc=%d); rolling back.", rc);
        ReleaseHost(host);
        if (previous != nullptr && !adopted)
        {
            SetActiveHost(previous);
        }
        return 0;
    }

    return HostHandle(*host);
}

namespace WasmApi {

// Creates a new engine instance bound to the given canvas selectors, makes it
// the active host, and initialises it. Returns the opaque host handle (see
// HostHandle()) on success, or 0 if the Module is already at the
// kMaxHosts cap or initialisation failed (get_last_init_error() says which).
// The previously-active host is restored on failure so a rejected create has no
// side effects on the caller's current instance.
//
// `flags` is a WasmContextConfigFlag bitmask (WasmWebGLContext.hpp);
// powerPreference 0 default / 1 low-power / 2 high-performance; fboPrecision
// 0 RGBA16F / 1 RGBA32F / 2 RGBA8. The config belongs to this host alone.
uintptr_t create_host_with_config(const char* primary, const char* secondary, int flags, int powerPreference, int fboPrecision)
{
    const WasmContextConfig cfg = WasmContextConfigFromArgs(flags, powerPreference, fboPrecision);
    return CreateHost(primary, secondary, &cfg);
}

// Legacy form: the new host inherits the previous host's config, or one a
// set_context_config() parked for it. Prefer create_host_with_config().
uintptr_t create_host(const char* primary, const char* secondary)
{
    return CreateHost(primary, secondary, nullptr);
}

// Selects which host subsequent no-handle exports operate on and makes its
// WebGL context current. A handle of 0 selects the default/first live host. A
// handle that is not a live host (already destroyed, or never issued) is
// ignored and the active host is left unchanged: dereferencing it would read
// freed memory.
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
        WASM_LOG_WARN("set_active_host: ignoring unknown or destroyed host handle %lu.",
                      static_cast<unsigned long>(handle));
        return;
    }
    SetActiveHost(host);
}

// Returns the active host handle (see HostHandle()), or 0 if none.
uintptr_t get_active_host()
{
    return g_activeHost != nullptr ? HostHandle(*g_activeHost) : 0;
}

// Tears down and frees a host created with create_host(). Safe to call with 0
// or an already-released handle (no-op).
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
int host_count()
{
    return LiveHostCount();
}

// The compile-time instance cap (kMaxHosts), so hosts can budget before a
// create_host() that would fail.
int max_host_count()
{
    return kMaxHosts;
}

bool pm_host_is_live(uintptr_t handle)
{
    return ResolveHost(handle) != nullptr;
}

int get_last_error(WasmHost& H)
{
    return H.lastErrorCode;
}

const char* get_last_error_message(WasmHost& H)
{
    return H.lastErrorMessage.c_str();
}

void clear_last_error(WasmHost& H)
{
    H.lastErrorCode = 0;
    H.lastErrorMessage.clear();
}

// Exception-barrier test hook (tests/wasm-smoke/host_churn.mjs): proves a throw
// inside an export is caught and recorded on its host instead of aborting.
int debug_throw(WasmHost& /*H*/, int kind)
{
    if (kind == 1)
    {
        throw std::runtime_error("debug_throw: requested exception");
    }
    if (kind == 2)
    {
        // Twice the fixed heap: no allocator can satisfy it.
        std::vector<uint8_t> tooBig(size_t{512} * 1024 * 1024);
        return tooBig.empty() ? 0 : 1;
    }
    return 1;
}

} // namespace WasmApi
