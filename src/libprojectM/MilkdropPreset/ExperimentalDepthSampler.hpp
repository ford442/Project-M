#pragma once

#include <string>

namespace libprojectM {
namespace MilkdropPreset {

class PresetFileParser;

/**
 * @brief The experimental <tt>pm_depth</tt> shader sampler (docs/EXPERIMENTAL_PRESET_HOOKS.md).
 *
 * A preset whose <tt>// pm:experimental</tt> header asks for a depth texture
 * (<tt>depth-texture=NAME</tt>, or <tt>depth=auto</tt> / <tt>depth=true</tt> for the default
 * <tt>pm_depth_map</tt>) can write <tt>tex2D(pm_depth, uv)</tt> in its warp or composite shader.
 * The name is rewritten to the ordinary Milkdrop user texture sampler <tt>sampler_fc_NAME</tt>
 * (bilinear, clamped) before the shader is analyzed, so the texture is declared, loaded from
 * the texture search paths and bound exactly like any <tt>sampler_*</tt> a preset declares
 * itself. <tt>texsize_pm_depth</tt> becomes <tt>texsize_NAME</tt>.
 *
 * A preset without the header is left untouched: <tt>pm_depth</tt> means nothing to it and no
 * sampler is declared for it.
 */
class ExperimentalDepthSampler
{
public:
    static constexpr const char* SamplerName = "pm_depth";        //!< The name a preset shader samples.
    static constexpr const char* DefaultTexture = "pm_depth_map"; //!< What projectm-experimental-bridge.js writes.

    /**
     * @brief The texture a preset's experimental directives bind <tt>pm_depth</tt> to.
     * @param directives The text after <tt>// pm:experimental</tt>, see PresetFileParser::ExperimentalDirectives().
     * @return The texture name, or an empty string if the directives ask for no depth texture.
     */
    static auto TextureFor(const std::string& directives) -> std::string;

    /**
     * @brief Rewrites <tt>pm_depth</tt> to <tt>sampler_fc_TEXTURE</tt> and <tt>texsize_pm_depth</tt> to
     *        <tt>texsize_TEXTURE</tt>, whole identifiers only.
     * @param shaderCode HLSL preset shader code.
     * @param texture The texture name from TextureFor(). An empty name returns the code unchanged.
     * @return The rewritten code.
     */
    static auto Apply(const std::string& shaderCode, const std::string& texture) -> std::string;

    /**
     * @brief PresetFileParser::GetCode() for a shader block, with the alias applied if the preset asks for it.
     * @param parser The parsed preset.
     * @param keyPrefix "warp_" or "comp_".
     * @return The shader code.
     */
    static auto ShaderCode(const PresetFileParser& parser, const std::string& keyPrefix) -> std::string;
};

} // namespace MilkdropPreset
} // namespace libprojectM
