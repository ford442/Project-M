/**
 * @file PreparedPreset.hpp
 * @brief The CPU-only half of loading a preset, which can run off the render thread.
 *
 * Loading a preset splits at the OpenGL boundary. Reading and parsing the file, analysing the preset
 * shaders and transpiling them from HLSL to GLSL touch no GL state; creating framebuffers, textures
 * and shader programs does. A PreparedPreset is the result of the first half. It is produced by
 * PresetFactory::PreparePresetFromFile() / PreparePresetFromStream() on any thread and turned into a
 * Preset on the render thread by Instantiate(), after which Preset::Initialize() only has GL work left.
 */
#pragma once

#include <array>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace libprojectM {

class Preset;

/**
 * @brief Render-thread state a background preset preparation needs, captured before it starts.
 *
 * Preparation must not read the ProjectM instance: it may be running on another thread, and the
 * instance may even be destroyed before it finishes. Whatever it needs is copied in here first.
 */
struct PresetPrepareContext {
    /**
     * If false, preparation only parses the preset and analyses its shaders; the HLSL-to-GLSL
     * transpile stays on the render thread. Used when preparing and initializing on the same
     * thread, where transpiling ahead of time gains nothing.
     */
    bool transpileShaders{false};

    std::vector<std::string> textureFiles;    //!< Renderer::TextureManager::ScannedTextureFileNames(), for random textures.
    std::set<std::string> volumeTextureNames; //!< Renderer::TextureManager::VolumeTextureNames().

    /**
     * The transpiled-GLSL cache key armed when the load began (Renderer::GetTranspiledGlslCacheKey()),
     * possibly empty. nullopt for a load prepared and initialized in one call, which reads the key
     * when it compiles. The host may clear or replace the key before a prepared load is activated
     * (shader_cache_end_load() right after load_preset_file()), so the activation uses this copy.
     */
    std::optional<std::string> transpileCacheKey;

    /**
     * Per shader type (warp, composite): the GLSL the transpiled-GLSL cache held for this load's
     * shader when it began. The render thread compiles it instead of transpiling, so preparation
     * skips the transpile for that type.
     */
    std::array<std::optional<std::string>, 2> cachedGlsl{};

    /**
     * The preset file's bytes, read by the caller. A file preparation parses these instead of
     * opening the file; everything else (filename, errors) is as for the file. For hosts where file
     * access off the render thread is expensive: under Emscripten pthreads every FS call from the
     * preparing thread waits for the main thread to finish its current frame.
     */
    std::optional<std::string> fileContents;
};

/**
 * @brief A preset whose CPU-side loading work is done, waiting to be instantiated on the render thread.
 */
class PreparedPreset
{
public:
    virtual ~PreparedPreset() = default;

    /**
     * @brief Creates the preset from the prepared data. Render thread only: this creates GL objects.
     *
     * Consumes the prepared data; call at most once. The caller then calls Preset::Initialize().
     * @return The preset.
     */
    virtual auto Instantiate() -> std::unique_ptr<Preset> = 0;
};

} // namespace libprojectM
