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
// InstallShaderTranspileCacheHooks() is called once from init()
// (projectM_emscripten.cpp).
#include "ProjectMWasmInternal.hpp"

static std::string g_shaderCacheKey;
static std::optional<std::string> g_importedWarpGlsl;
static std::optional<std::string> g_importedCompGlsl;

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
            if (key != g_shaderCacheKey)
            {
                return std::nullopt;
            }
            if (shaderType == 0 && g_importedWarpGlsl)
            {
                return g_importedWarpGlsl;
            }
            if (shaderType == 1 && g_importedCompGlsl)
            {
                return g_importedCompGlsl;
            }
            return std::nullopt;
        },
        [](const std::string& key, int shaderType, const std::string& glsl) {
            js_on_transpiled_shader_stored(key.c_str(), shaderType, glsl.c_str());
        });
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void shader_cache_begin_load(const char* key)
{
    g_shaderCacheKey = key ? key : "";
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
    libprojectM::Renderer::SetTranspiledGlslCacheKey(g_shaderCacheKey);
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_import_glsl(int shaderType, const char* glsl)
{
    if (!glsl)
    {
        return;
    }
    if (shaderType == 0)
    {
        g_importedWarpGlsl = glsl;
    }
    else if (shaderType == 1)
    {
        g_importedCompGlsl = glsl;
    }
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_end_load()
{
    libprojectM::Renderer::ClearTranspiledGlslCacheKey();
    g_shaderCacheKey.clear();
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
}

EMSCRIPTEN_KEEPALIVE
int get_glsl_generator_version()
{
    return static_cast<int>(
        libprojectM::MilkdropPreset::MilkdropStaticShaders::Get()->GetGlslGeneratorVersion());
}
} // extern "C"
