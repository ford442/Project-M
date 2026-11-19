#pragma once

#include "PerFrameContext.hpp"
#include "PresetState.hpp"

#include <Renderer/Mesh.hpp>

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Renders a video "echo" (ghost image) effect and gamma adjustments.
 */
class VideoEcho
{
public:
	VideoEcho() = delete;
    explicit VideoEcho(const PresetState& presetState);

	void Draw();

private:
    /**
     * @brief Sets the echo mesh pipeline with @a blend (the textured shader is current).
     */
    void SetBlend(const Renderer::Device::BlendState& blend);

    void DrawVideoEcho();

    void DrawGammaAdjustment();

    const PresetState& m_presetState; //!< The global preset state.

    std::array<std::array<float, 3>, 4> m_shade; // !< Random, changing color values for the four corners
    Renderer::Mesh m_echoMesh; //!< The video echo/gamma adj mesh
    const Renderer::Shader* m_shader{nullptr}; //!< The textured shader, during Draw().
    Renderer::Sampler m_sampler{Renderer::Device::WrapMode::ClampToEdge, Renderer::Device::FilterMode::Linear};
};

} // namespace MilkdropPreset
} // namespace libprojectM
