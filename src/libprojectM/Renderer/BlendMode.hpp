#pragma once

#include <Renderer/Device/RenderDevice.hpp>

namespace libprojectM {
namespace Renderer {

/**
 * A simple wrapper class around the render device's blend state.
 */
class BlendMode
{
public:
    /**
     * Available blend functions.
     * @see https://registry.khronos.org/OpenGL-Refpages/gl4/html/glBlendFunc.xhtml
     */
    using Function = Device::BlendFactor;

    BlendMode() = delete;

    /**
     * @brief Enables or disables blending and sets the blend functions.
     * A convenience wrapper around BlendMode::SetBlendActive() and BlendMode::SetBlendFunction().
     * @param enable If true, blending is enabled, otherwise disabled.
     * @param srcFunc The blend function to determine the source color.
     * @param dstFunc the blend function to determine the destination color.
     */
    static void Set(bool enable, Function srcFunc, Function dstFunc);

    /**
     * Enables or disables blending.
     * @param enable If true, blending is enabled, otherwise disabled.
     */
    static void SetBlendActive(bool enable);

    /**
     * Sets the blend functions.
     * @param srcFunc The blend function to determine the source color.
     * @param dstFunc the blend function to determine the destination color.
     */
    static void SetBlendFunction(Function srcFunc, Function dstFunc);

};

} // namespace Renderer
} // namespace libprojectM
