/**
* @file RenderContext.hpp
* @brief A class holding per-frame render values for use in preset rendering.
*/
#pragma once

#include <projectM-4/parameters.h>
#include <projectM-4/projectM_cxx_export.h>

#include <cstdint>

namespace libprojectM {
namespace Renderer {

class ShaderCache;
class TextureManager;

/**
 * @brief Holds all global data of the current rendering context, which can change from frame to frame.
 */
class PROJECTM_CXX_EXPORT RenderContext
{
public:
    float time{0.0f};          //!< Time since the preset started, in seconds.
    int frame{0};              //!< Frames rendered so far.
    float fps{0.0f};           //!< Frames per second.
    float progress{0.0f};      //!< Preset progress.
    float blendProgress{0.0f}; //!< Preset transition/blending progress.
    int viewportSizeX{0};      //!< Horizontal viewport size in pixels
    int viewportSizeY{0};      //!< Vertical viewport size in pixels
    float aspectX{1.0};        //!< X aspect ratio.
    float aspectY{1.0};        //!< Y aspect ratio.
    float invAspectX{1.0};     //!< Inverse X aspect ratio.
    float invAspectY{1.0};     //!< Inverse Y aspect ratio.

    int perPixelMeshX{64}; //!< Per-pixel/per-vertex mesh X resolution.
    int perPixelMeshY{48}; //!< Per-pixel/per-vertex mesh Y resolution.

    //! Governor cap on blur passes: -1 = uncapped, else max BlurTexture::BlurLevel
    //! value (0 = None, 1 = Blur1, 2 = Blur2, 3 = Blur3) presets may render this frame.
    int maxBlurLevel{-1};

    //! Governor's extra downscale for blur texture allocation, independent of the
    //! overall internal render scale. (0, 1.0]; 1.0 = no extra downscale.
    float blurResolutionScale{1.0f};

    /**
     * If true, preset shader programs are linked without waiting for the result
     * (KHR_parallel_shader_compile); Preset::ShaderCompilePending() then reports it
     * and Preset::FinishShaderCompile() completes it. Only set for Preset::Initialize().
     */
    bool deferShaderLink{false};

    //! projectm_set_render_path() switches (projectm_render_path_flags bits) of this
    //! instance. Blur and per-pixel paths are decided in Preset::Initialize(), texture
    //! copies on every draw.
    uint32_t renderPathFlags{0};

    //! The PROJECTM_RENDER_PATH_BLUR_COPY switch: blur through a scratch target + copy.
    auto BlurCopyPath() const -> bool
    {
        return (renderPathFlags & PROJECTM_RENDER_PATH_BLUR_COPY) != 0;
    }

    //! The PROJECTM_RENDER_PATH_COPY_SHADER switch: texture copies draw a quad, never blit.
    auto CopyShaderPath() const -> bool
    {
        return (renderPathFlags & PROJECTM_RENDER_PATH_COPY_SHADER) != 0;
    }

    //! The PROJECTM_RENDER_PATH_PER_PIXEL_CPU switch: per-pixel code never lowered to GLSL.
    auto PerPixelForceCpu() const -> bool
    {
        return (renderPathFlags & PROJECTM_RENDER_PATH_PER_PIXEL_CPU) != 0;
    }

    float texelOffsetX{0.0f}; //!< Horizontal texel offset in the warp shader.
    float texelOffsetY{0.0f}; //!< Vertical texel offset in the warp shader.

    TextureManager* textureManager{nullptr}; //!< Holds all loaded textures for shader access.
    ShaderCache* shaderCache{nullptr}; //!< The shader chace of this projectM instance.
};

} // namespace Renderer
} // namespace libprojectM
