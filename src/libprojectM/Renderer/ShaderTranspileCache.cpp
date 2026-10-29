#include "ShaderTranspileCache.hpp"

#include <mutex>

namespace libprojectM {
namespace Renderer {

namespace {

std::mutex g_mutex;
TranspiledGlslLookupFn g_lookup;
TranspiledGlslStoreFn g_store;
std::string g_cacheKey;

} // namespace

void SetTranspiledGlslCacheCallbacks(TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_lookup = std::move(lookup);
    g_store = std::move(store);
}

void ClearTranspiledGlslCacheCallbacks()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_lookup = nullptr;
    g_store = nullptr;
}

void SetTranspiledGlslCacheKey(const std::string& key)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_cacheKey = key;
}

void ClearTranspiledGlslCacheKey()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_cacheKey.clear();
}

auto GetTranspiledGlslCacheKey() -> std::string
{
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_cacheKey;
}

// The hooks run outside g_mutex, on a copy taken under it: they reach host code (JS in the
// WASM build), which may call back into any of the functions here, and the mutex is not
// recursive. A hook replaced while a copy runs finishes on the old one.
auto LookupTranspiledGlsl(const std::string& cacheKey, int shaderType) -> std::optional<std::string>
{
    TranspiledGlslLookupFn lookup;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        lookup = g_lookup;
    }
    if (!lookup)
    {
        return std::nullopt;
    }
    return lookup(cacheKey, shaderType);
}

void StoreTranspiledGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl)
{
    TranspiledGlslStoreFn store;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        store = g_store;
    }
    if (store)
    {
        store(cacheKey, shaderType, glsl);
    }
}

} // namespace Renderer
} // namespace libprojectM
