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

auto GetTranspiledGlslCacheKey() -> const std::string&
{
    return g_cacheKey;
}

auto LookupTranspiledGlsl(const std::string& cacheKey, int shaderType) -> std::optional<std::string>
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_lookup)
    {
        return std::nullopt;
    }
    return g_lookup(cacheKey, shaderType);
}

void StoreTranspiledGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_store)
    {
        g_store(cacheKey, shaderType, glsl);
    }
}

} // namespace Renderer
} // namespace libprojectM
