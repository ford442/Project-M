#pragma once

#include <functional>
#include <optional>
#include <string>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Optional host hooks for persisting transpiled preset GLSL across loads.
 *
 * Used by the Emscripten wrapper to skip HLSL parse/transpile on repeat preset
 * visits when the browser has cached GLSL from a prior session. Lookup/store
 * callbacks are registered once at init; a per-load cache key is set from JS
 * immediately before load_preset_file().
 */
using TranspiledGlslLookupFn = std::function<std::optional<std::string>(const std::string& cacheKey, int shaderType)>;
using TranspiledGlslStoreFn = std::function<void(const std::string& cacheKey, int shaderType, const std::string& glsl)>;

void SetTranspiledGlslCacheCallbacks(TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store);
void ClearTranspiledGlslCacheCallbacks();

void SetTranspiledGlslCacheKey(const std::string& key);
void ClearTranspiledGlslCacheKey();
auto GetTranspiledGlslCacheKey() -> const std::string&;

auto LookupTranspiledGlsl(const std::string& cacheKey, int shaderType) -> std::optional<std::string>;
void StoreTranspiledGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl);

} // namespace Renderer
} // namespace libprojectM
