#pragma once

#include "PresetState.hpp"

#include <Renderer/Mesh.hpp>
#include <Renderer/UniformBlocks.hpp>

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Darkens the screen center a bit on each frame.
 */
class DarkenCenter
{
public:
    DarkenCenter() = delete;

    explicit DarkenCenter(PresetState& presetState);

    /**
     * Applies the darkening area.
     */
    void Draw();

private:
    Renderer::UniformBlockWriter m_uniforms; //!< Writes this object's uniform blocks (UniformBlocks.hpp).
    PresetState& m_presetState; //!< The global preset state.
    Renderer::Mesh m_mesh; //!< The "diamond" mesh.
    float m_aspectY{}; //!< Previous Y aspect ratio.
};

} // namespace MilkdropPreset
} // namespace libprojectM
