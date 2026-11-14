// WasmApiBarrier.hpp
//
// The barriers every WASM export goes through (ABI v2, #352). The exports
// themselves are generated (generated/WasmApiExports.cpp, from
// cmake/WasmApiManifest.cmake); each one is a single call to one of these
// around its WasmApi:: implementation:
//
//   WithHost(handle, ...)        pm_<name>(host, ...). Resolves the handle (0 is
//                                the implicit default host, never created here),
//                                binds the host (its WebGL context current, its
//                                shader-cache key armed) and runs the
//                                implementation on it. An unknown or destroyed
//                                handle returns the failure value.
//   Guarded(...)                 module-level and compat-only exports.
//
// A compat name of an engine call (set_mesh(), projectm_sprite_*_wrapper(), ...)
// has no barrier of its own: it forwards to its pm_ export, with
// ActiveHostHandle() (WasmHost.hpp) or with the handle it was given.
//
// Every barrier catches what the implementation throws, so a C++ exception
// (std::bad_alloc on the fixed heap included: the link sets ABORTING_MALLOC=0)
// never unwinds into JavaScript and never aborts the Module and every other
// host in it. A host-scoped barrier records it as that host's last error
// (pm_get_last_error / pm_get_last_error_message) and returns the failure
// value. See docs/WASM_JS_API.md ("ABI v2").
#pragma once

#include "WasmHost.hpp"

#include <cstdint>
#include <exception>
#include <new>
#include <type_traits>
#include <utility>

// pm_get_last_error() codes.
enum class WasmApiError : int
{
    None = 0,
    Exception = 1,       //!< An export threw (message: what()).
    OutOfMemory = 2,     //!< An allocation failed (std::bad_alloc).
    StaleGeneration = 3, //!< A buffer commit named a generation that was replaced.
};

// Records `code` as the last error of the host `handle` names, if it is still
// live (the export that failed may have destroyed it), and logs it.
void RecordHostError(uintptr_t handle, WasmApiError code, const char* exportName, const char* message);

// Logs an error raised by an export that has no host.
void RecordModuleError(WasmApiError code, const char* exportName, const char* message);

// Logs (once per handle value) that `exportName` was called with a handle that
// names no live host.
void ReportUnknownHost(const char* exportName, uintptr_t handle);

namespace WasmApiDetail {

// Runs `body`, turning anything it throws into a recorded error. Returns
// whether it completed. `handle` 0 records a module error.
template<typename Body>
bool RunGuarded(uintptr_t handle, const char* exportName, Body&& body) noexcept
{
    const auto record = [&](WasmApiError code, const char* message) {
        if (handle != 0)
        {
            RecordHostError(handle, code, exportName, message);
        }
        else
        {
            RecordModuleError(code, exportName, message);
        }
    };
    try
    {
        std::forward<Body>(body)();
        return true;
    }
    catch (const std::bad_alloc&)
    {
        record(WasmApiError::OutOfMemory, "out of memory");
    }
    catch (const std::exception& e)
    {
        record(WasmApiError::Exception, e.what());
    }
    catch (...)
    {
        record(WasmApiError::Exception, "unknown exception");
    }
    return false;
}

template<typename R, typename Fn>
R RunOnHost(WasmHost* host, R failure, const char* exportName, uintptr_t handle, Fn&& fn)
{
    if (host == nullptr)
    {
        ReportUnknownHost(exportName, handle);
        return failure;
    }
    R result = failure;
    RunGuarded(host->handle, exportName, [&] {
        BindHost(*host);
        result = fn(*host);
    });
    return result;
}

template<typename Fn>
void RunOnHost(WasmHost* host, const char* exportName, uintptr_t handle, Fn&& fn)
{
    if (host == nullptr)
    {
        ReportUnknownHost(exportName, handle);
        return;
    }
    RunGuarded(host->handle, exportName, [&] {
        BindHost(*host);
        fn(*host);
    });
}

} // namespace WasmApiDetail

template<typename R, typename Fn>
R WithHost(uintptr_t handle, R failure, const char* exportName, Fn&& fn)
{
    return WasmApiDetail::RunOnHost<R>(ResolveHost(handle), failure, exportName, handle, std::forward<Fn>(fn));
}

template<typename Fn>
void WithHost(uintptr_t handle, const char* exportName, Fn&& fn)
{
    WasmApiDetail::RunOnHost(ResolveHost(handle), exportName, handle, std::forward<Fn>(fn));
}

template<typename R, typename Fn>
R Guarded(R failure, const char* exportName, Fn&& fn)
{
    R result = failure;
    WasmApiDetail::RunGuarded(0, exportName, [&] { result = fn(); });
    return result;
}

template<typename Fn>
void Guarded(const char* exportName, Fn&& fn)
{
    WasmApiDetail::RunGuarded(0, exportName, std::forward<Fn>(fn));
}
