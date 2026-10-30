#include "ShaderTranspileCache.hpp"

#include <EngineContext.hpp>

#include <mutex>
#include <utility>

namespace libprojectM {
namespace Renderer {

namespace {

/// The hooks to run for @a state: its own, or the process state's when it has none.
auto ResolveHooks(TranspileCacheState& state) -> std::pair<TranspiledGlslLookupFn, TranspiledGlslStoreFn>
{
    {
        std::lock_guard<std::mutex> lock(state.mutex);
        if (state.lookup || state.store)
        {
            return {state.lookup, state.store};
        }
    }
    auto& process = ProcessTranspileCacheState();
    if (&process == &state)
    {
        return {};
    }
    std::lock_guard<std::mutex> lock(process.mutex);
    return {process.lookup, process.store};
}

} // namespace

auto CurrentTranspileCacheState() -> TranspileCacheState&
{
    return EngineContext::Current().TranspileCache();
}

auto ProcessTranspileCacheState() -> TranspileCacheState&
{
    return EngineContext::ProcessDefault().TranspileCache();
}

void SetTranspiledGlslCacheCallbacks(TranspileCacheState& state, TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store)
{
    std::lock_guard<std::mutex> lock(state.mutex);
    state.lookup = std::move(lookup);
    state.store = std::move(store);
}

void SetTranspiledGlslCacheKey(TranspileCacheState& state, std::optional<std::string> key)
{
    std::lock_guard<std::mutex> lock(state.mutex);
    state.cacheKey = std::move(key);
}

void SetTranspiledGlslCacheCallbacks(TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store)
{
    SetTranspiledGlslCacheCallbacks(CurrentTranspileCacheState(), std::move(lookup), std::move(store));
}

void ClearTranspiledGlslCacheCallbacks()
{
    SetTranspiledGlslCacheCallbacks(CurrentTranspileCacheState(), nullptr, nullptr);
}

void SetTranspiledGlslCacheKey(const std::string& key)
{
    SetTranspiledGlslCacheKey(CurrentTranspileCacheState(), key);
}

void ClearTranspiledGlslCacheKey()
{
    auto& state = CurrentTranspileCacheState();
    // The process key is cleared to empty; an engine's falls back to the process key.
    SetTranspiledGlslCacheKey(state, &state == &ProcessTranspileCacheState() ? std::optional<std::string>("") : std::nullopt);
}

auto GetTranspiledGlslCacheKey() -> std::string
{
    auto& state = CurrentTranspileCacheState();
    {
        std::lock_guard<std::mutex> lock(state.mutex);
        if (state.cacheKey)
        {
            return *state.cacheKey;
        }
    }
    auto& process = ProcessTranspileCacheState();
    std::lock_guard<std::mutex> lock(process.mutex);
    return process.cacheKey.value_or(std::string());
}

// The hooks run outside the state mutexes, on a copy taken under them: they reach host code
// (JS in the WASM build), which may call back into any of the functions here, and the
// mutexes are not recursive. A hook replaced while a copy runs finishes on the old one.
auto LookupTranspiledGlsl(const std::string& cacheKey, int shaderType) -> std::optional<std::string>
{
    const auto lookup = ResolveHooks(CurrentTranspileCacheState()).first;
    if (!lookup)
    {
        return std::nullopt;
    }
    return lookup(cacheKey, shaderType);
}

void StoreTranspiledGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl)
{
    const auto store = ResolveHooks(CurrentTranspileCacheState()).second;
    if (store)
    {
        store(cacheKey, shaderType, glsl);
    }
}

} // namespace Renderer
} // namespace libprojectM
