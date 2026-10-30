#pragma once

#include <functional>
#include <mutex>
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
 *
 * Each engine (EngineContext) has its own hooks and key; an engine that set neither uses
 * the process default context's, which is what the handle-less setters below change
 * when called outside an engine. The key may be changed by the host at any time, so it is
 * read once, by value: a preset load captures it (with the GLSL the lookup hook
 * returns for it) when the load begins, in ProjectM::CapturePresetPrepareContext(),
 * and uses that capture when it activates. Only a load that is prepared and
 * initialized in one call reads it at compile time.
 */
using TranspiledGlslLookupFn = std::function<std::optional<std::string>(const std::string& cacheKey, int shaderType)>;
using TranspiledGlslStoreFn = std::function<void(const std::string& cacheKey, int shaderType, const std::string& glsl)>;

/**
 * @brief One engine's transpile cache hooks and key. Each EngineContext owns one.
 */
struct TranspileCacheState {
    mutable std::mutex mutex;
    TranspiledGlslLookupFn lookup; //!< Empty (with store): use the process state's hooks.
    TranspiledGlslStoreFn store;
    std::optional<std::string> cacheKey; //!< Unset: use the process state's key.
};

/// The cache state of the engine running on this thread (EngineContext::Current()).
auto CurrentTranspileCacheState() -> TranspileCacheState&;

/// The process default context's cache state.
auto ProcessTranspileCacheState() -> TranspileCacheState&;

/// Sets (or, with two empty hooks, clears) @a state's hooks.
void SetTranspiledGlslCacheCallbacks(TranspileCacheState& state, TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store);

/// Sets @a state's key, or with nullopt makes it follow the process key.
void SetTranspiledGlslCacheKey(TranspileCacheState& state, std::optional<std::string> key);

// The functions below act on CurrentTranspileCacheState() (set/clear) or resolve
// through it to the process state (get, lookup, store).

void SetTranspiledGlslCacheCallbacks(TranspiledGlslLookupFn lookup, TranspiledGlslStoreFn store);
void ClearTranspiledGlslCacheCallbacks();

void SetTranspiledGlslCacheKey(const std::string& key);
void ClearTranspiledGlslCacheKey();
auto GetTranspiledGlslCacheKey() -> std::string;

auto LookupTranspiledGlsl(const std::string& cacheKey, int shaderType) -> std::optional<std::string>;
void StoreTranspiledGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl);

} // namespace Renderer
} // namespace libprojectM
