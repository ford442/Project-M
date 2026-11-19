#pragma once

#include "Renderer/Shader.hpp"

#include <cstddef>
#include <optional>
#include <random>
#include <string>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Manages all available transition shaders.
 */
class TransitionShaderManager
{
public:
    TransitionShaderManager();

    /**
     * @brief Selects a random transition shader from the list.
     *
     * Returns one of the successfully compiled custom shaders at random. If all
     * custom shaders failed to compile, returns the SimpleBlend fallback instead.
     * The return value may still be null if even SimpleBlend failed to compile
     * (e.g., the GPU/driver is severely broken), in which case PresetTransition
     * will fall back to an instant hard-cut.
     *
     * @return A shared pointer to a transition shader, or nullptr if all shaders
     *         failed to compile.
     */
    auto RandomTransition() -> std::shared_ptr<Shader>;

    /**
     * @brief Returns the number of render passes required by the given shader.
     * @param shader The transition shader to query.
     * @return The pass count (1 for single-pass, 2+ for multi-pass). Defaults to 1 if unknown.
     */
    auto GetPassCount(const std::shared_ptr<Shader>& shader) const -> int;

    /**
     * @brief Returns the number of successfully compiled transition shaders.
     */
    auto CompiledShaderCount() const -> std::size_t;

    /**
     * @brief Returns a compiled transition shader by index.
     * @param index Zero-based index into the compiled shader list.
     * @return The shader at @p index, or nullptr if out of range.
     */
    auto CompiledShaderAt(std::size_t index) const -> std::shared_ptr<Shader>;

    /**
     * @brief Returns the pass count for a compiled shader by index.
     * @param index Zero-based index into the compiled shader list.
     * @return The pass count, or 1 if @p index is out of range.
     */
    auto PassCountAt(std::size_t index) const -> int;

    /**
     * @brief Returns the name of a compiled shader by index, e.g. "StarWipe".
     * @param index Zero-based index into the compiled shader list.
     * @return The name, or an empty string if @p index is out of range.
     */
    auto NameAt(std::size_t index) const -> std::string;

    /**
     * @brief Finds a compiled shader by name.
     * @param name The shader name, as NameAt() returns it.
     * @return The index, or nullopt if no compiled shader has that name.
     */
    auto IndexOf(const std::string& name) const -> std::optional<std::size_t>;

private:
    /**
     * @brief Compiles a single transition shader program.
     * @param shaderBodyCode The mainImage() fragment shader code, without any headers etc.
     */
    static auto CompileTransitionShader(const std::string& shaderBodyCode) -> std::shared_ptr<Shader>;

    struct TransitionEntry
    {
        std::shared_ptr<Shader> shader; //!< The compiled transition shader.
        int passCount{1};               //!< Number of render passes (1 = single-pass, 2+ = multi-pass).
        std::string name;               //!< Name, e.g. "StarWipe".
    };

    std::vector<TransitionEntry> m_transitionShaders; //!< Currently loaded and compiled transition shaders.
    std::shared_ptr<Shader> m_fallbackShader; //!< SimpleBlend fallback used when all custom shaders fail to compile.
    int m_fallbackPassCount{1}; //!< Pass count for the fallback shader.

    std::mt19937 m_mersenneTwister; //!< Random engine to select shader
};

} // namespace Renderer
} // namespace libprojectM
