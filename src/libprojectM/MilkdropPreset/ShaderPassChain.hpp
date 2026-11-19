/**
 * @file ShaderPassChain.hpp
 * @brief The extra shader passes a preset declares before its warp or composite shader (#229).
 *
 * A preset that sets <tt>warp_nPasses=N</tt> (or <tt>comp_nPasses</tt>) runs N - 1 extra
 * shaders, the <tt>warp_pass1_</tt>... blocks, before its usual warp (composite) shader. Each
 * renders the same mesh with the same inputs into an intermediate render target; the next
 * pass, and finally the stage's own shader, sample that image as <tt>sampler_lastpass</tt>.
 * The first pass sees the main texture there. See docs/MILK_SHADER_PASSES.md.
 */
#pragma once

#include "MilkdropShader.hpp"

#include <Renderer/Framebuffer.hpp>

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace libprojectM {
namespace MilkdropPreset {

class PerFrameContext;
class PresetState;

class ShaderPassChain
{
public:
    using DrawFunction = std::function<void(MilkdropShader&)>; //!< Sets the stage's own uniforms and draws its mesh.

    /**
     * @param type The stage the passes belong to.
     */
    explicit ShaderPassChain(MilkdropShader::ShaderType type);

    /**
     * @brief Analyses the passes' code (PresetState::warpPassShaders or compositePassShaders).
     * @param passCode One entry per extra pass, in order. Empty: no extra passes.
     * @throws Renderer::ShaderException if a pass fails to preprocess.
     */
    void Load(const std::vector<std::string>& passCode);

    /**
     * @brief Removes all passes, e.g. after one failed and the stage fell back to its default shader.
     */
    void Clear();

    /**
     * @brief Number of extra passes; the stage's own shader is pass number Count().
     */
    auto Count() const -> int;

    /**
     * @brief Loads textures and compiles every pass, as MilkdropShader::LoadTexturesAndCompile() does.
     * @throws Renderer::ShaderException if a pass fails to transpile or compile.
     */
    void Compile(PresetState& presetState);

    /**
     * @brief Whether a pass is still linking in the background.
     */
    auto IsCompilePending() const -> bool;

    /**
     * @brief Whether every background link has finished. Does not block.
     */
    auto IsCompileComplete() const -> bool;

    /**
     * @brief Finishes background links.
     * @throws Renderer::ShaderException if a pass fails to compile or link.
     */
    void FinishCompile(PresetState& presetState);

    /**
     * @brief Renders the passes, then restores the render target and viewport.
     *
     * For each pass: binds its target, loads the shader's preset variables (LoadVariables())
     * and calls @a draw, which adds the stage's own uniforms and draws.
     *
     * @return The last pass's output, for the stage's own shader's sampler_lastpass;
     *         nullptr if there are no passes.
     */
    auto Render(const PresetState& presetState, const PerFrameContext& perFrameContext,
                const DrawFunction& draw) -> std::shared_ptr<Renderer::Texture>;

private:
    MilkdropShader::ShaderType m_type;                     //!< Warp or composite.
    std::vector<std::unique_ptr<MilkdropShader>> m_passes; //!< The extra passes, in order.
    std::unique_ptr<Renderer::Framebuffer> m_targets;      //!< Two targets the passes alternate between, created on first use.
};

} // namespace MilkdropPreset
} // namespace libprojectM
