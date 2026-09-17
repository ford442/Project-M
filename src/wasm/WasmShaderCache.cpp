// WasmShaderCache.cpp
//
// Transpiled-GLSL shader cache bridge.
//
// Milkdrop presets carry HLSL that libprojectM transpiles to GLSL on first
// use, which is the expensive part of loading a preset. This TU wires that
// cache to the host page so the result can be persisted (browser IndexedDB,
// in practice) and handed back on a later visit:
//
//   * store  — SetTranspiledGlslCacheCallbacks()'s store hook forwards every
//              freshly transpiled shader to `globalThis.pmOnTranspiledShaderStored`.
//   * load   — the host calls shader_cache_begin_load() with a preset key,
//              shader_cache_import_glsl() once per cached shader, then
//              shader_cache_end_load(); the lookup hook serves those back to
//              the transpiler while the key is armed.
//
// get_glsl_generator_version() lets the host invalidate its stored entries
// when the generator that produced them changes.
//
// InstallShaderTranspileCacheHooks() is called from init()
// (projectM_emscripten.cpp); installing it again is a no-op in effect.
//
// Per host (#246). libprojectM holds a single process-wide "current cache key"
// that the transpiler reads when it compiles a preset shader, and two engines
// in one Module share it. So each WasmHost keeps its own load state (key +
// imported GLSL, ShaderCacheLoadState in WasmHost.hpp), the key handed to
// libprojectM is namespaced with the host handle, and SetActiveHost() re-arms
// libprojectM's key for whichever host becomes active. Preset shaders only
// compile under their own host's GL context — i.e. while that host is active —
// so a compile on host B can never see host A's key, and the lookup hook
// additionally refuses to serve a host's imports for any other key.
//
// The namespace never reaches JS: the store hook strips it, so the IndexedDB
// store keeps sharing compiled GLSL blobs across hosts (and visits) by preset
// key alone. Only the in-flight C++ key was the bug.
#include "WasmHost.hpp"

namespace {

// "host<handle>|<key>". The separator cannot appear in a handle, so the first
// one always ends the prefix even when the host key itself contains '|'.
std::string NamespaceShaderCacheKey(const WasmHost& host, const std::string& key)
{
    if (key.empty())
    {
        return {};
    }
    return "host" + std::to_string(HostHandle(host)) + "|" + key;
}

// The live host whose in-flight load armed `namespacedKey`, or nullptr.
WasmHost* HostForNamespacedKey(const std::string& namespacedKey)
{
    if (namespacedKey.empty())
    {
        return nullptr;
    }
    for (int i = 0; i < HostSlotCount(); ++i)
    {
        WasmHost* host = HostSlot(i);
        if (host != nullptr && host->shaderCache.namespacedKey == namespacedKey)
        {
            return host;
        }
    }
    return nullptr;
}

} // namespace

// clang-format off
EM_JS(void, js_on_transpiled_shader_stored, (const char* key, int kind, const char* glsl), {
    if (typeof globalThis.pmOnTranspiledShaderStored === 'function')
    {
        globalThis.pmOnTranspiledShaderStored(UTF8ToString(key), kind, UTF8ToString(glsl));
    }
});
// clang-format on

void InstallShaderTranspileCacheHooks()
{
    libprojectM::Renderer::SetTranspiledGlslCacheCallbacks(
        [](const std::string& key, int shaderType) -> std::optional<std::string> {
            const WasmHost* host = HostForNamespacedKey(key);
            if (host == nullptr)
            {
                return std::nullopt;
            }
            if (shaderType == 0 && host->shaderCache.warpGlsl)
            {
                return host->shaderCache.warpGlsl;
            }
            if (shaderType == 1 && host->shaderCache.compGlsl)
            {
                return host->shaderCache.compGlsl;
            }
            return std::nullopt;
        },
        [](const std::string& key, int shaderType, const std::string& glsl) {
            // Hand JS the host's own key, not the namespaced one, so persisted
            // entries stay shareable across hosts and visits.
            if (const WasmHost* host = HostForNamespacedKey(key))
            {
                js_on_transpiled_shader_stored(host->shaderCache.key.c_str(), shaderType, glsl.c_str());
                return;
            }
            const auto separator = key.find('|');
            const std::string hostKey = separator == std::string::npos ? key : key.substr(separator + 1);
            js_on_transpiled_shader_stored(hostKey.c_str(), shaderType, glsl.c_str());
        });
}

void ArmShaderCacheKeyForHost(const WasmHost& host)
{
    const std::string& namespacedKey = host.shaderCache.namespacedKey;
    if (libprojectM::Renderer::GetTranspiledGlslCacheKey() == namespacedKey)
    {
        return;
    }
    if (namespacedKey.empty())
    {
        libprojectM::Renderer::ClearTranspiledGlslCacheKey();
    }
    else
    {
        libprojectM::Renderer::SetTranspiledGlslCacheKey(namespacedKey);
    }
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void shader_cache_begin_load(const char* key)
{
    WasmHost& H = Host();
    H.shaderCache.key = key ? key : "";
    H.shaderCache.namespacedKey = NamespaceShaderCacheKey(H, H.shaderCache.key);
    H.shaderCache.warpGlsl.reset();
    H.shaderCache.compGlsl.reset();
    ArmShaderCacheKeyForHost(H);
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_import_glsl(int shaderType, const char* glsl)
{
    if (!glsl)
    {
        return;
    }
    WasmHost& H = Host();
    if (shaderType == 0)
    {
        H.shaderCache.warpGlsl = glsl;
    }
    else if (shaderType == 1)
    {
        H.shaderCache.compGlsl = glsl;
    }
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_end_load()
{
    WasmHost& H = Host();
    H.shaderCache = ShaderCacheLoadState{};
    ArmShaderCacheKeyForHost(H);
}

EMSCRIPTEN_KEEPALIVE
int get_glsl_generator_version()
{
    return static_cast<int>(
        libprojectM::MilkdropPreset::MilkdropStaticShaders::Get()->GetGlslGeneratorVersion());
}
} // extern "C"
