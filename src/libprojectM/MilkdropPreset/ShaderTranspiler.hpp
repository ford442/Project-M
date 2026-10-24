/**
 * @file ShaderTranspiler.hpp
 * @brief GPU-free helpers to turn a Milkdrop preset shader body into GLSL.
 *
 * These functions implement the preprocessing and HLSL-to-GLSL transpiling steps used by
 * MilkdropShader, without requiring an OpenGL context or texture manager. This allows
 * verifying that preset shader code parses and transpiles correctly, e.g. in unit tests.
 */
#pragma once

#include <GLSLGenerator.h>

#include <set>
#include <string>

namespace libprojectM {
namespace MilkdropPreset {
namespace ShaderTranspiler {

/**
 * @brief Type of preset shader being processed.
 */
enum class ShaderType
{
    WarpShader,     //!< Warp shader
    CompositeShader //!< Composite shader
};

/**
 * @brief Tone curve of the HDR composite output (see HdrOutputFunctions()).
 */
enum class ToneMap
{
    None,    //!< Linear light is clamped to [0, 1], nothing else.
    Reinhard //!< Luminance Reinhard, c * 1 / (1 + L).
};

/**
 * @brief Colour space the HDR composite output is encoded for.
 */
enum class OutputGamut
{
    Srgb,     //!< BT.709 primaries, sRGB transfer function.
    DisplayP3 //!< Display P3 primaries, sRGB transfer function.
};

/**
 * @brief The HLSL helper functions an HDR build appends to the composite shader.
 *
 * Defines `float3 _prjm_hdr_out(float3 linearBt709)`, which turns linear BT.709 light
 * into display-encoded output: tone map, then (for Display P3) the gamut matrix, both in
 * linear light, then the sRGB transfer function. Independent of the build's
 * PROJECTM_HDR_* switches, so the conversion can be tested in any build.
 *
 * @param toneMap The tone curve applied first.
 * @param gamut The output colour space.
 * @return HLSL source to place before the shader body that calls _prjm_hdr_out().
 */
auto HdrOutputFunctions(ToneMap toneMap, OutputGamut gamut) -> std::string;

/**
 * @brief Searches for "sampler_*" and "texsize_*" references in a preset shader.
 * @param program The raw (unprocessed) preset shader code.
 * @return The set of referenced texture sampler names. Always contains "main".
 */
auto GetReferencedSamplers(const std::string& program) -> std::set<std::string>;

/**
 * @brief Wraps a preset shader body ("shader_body { ... }") into a full HLSL shader,
 * adding the standard preset shader header and entry point signature.
 * @param type The type of shader being processed.
 * @param program The preset shader code. Modified in place.
 * @throws Renderer::ShaderException if the shader code is empty or missing required markers.
 */
void PreprocessPresetShader(ShaderType type, std::string& program);

/**
 * @brief Transpiles a preprocessed HLSL preset shader into GLSL.
 *
 * Inserts the given sampler/texsize uniform declarations, then runs the preset shader
 * through the HLSL preprocessor, parser and GLSL generator. Does not require an OpenGL
 * context, GL function loader or texture manager.
 *
 * @param preprocessedProgram The shader code as returned by PreprocessPresetShader().
 * @param samplerDeclarations HLSL "uniform sampler2D/3D sampler_..." declarations to insert.
 * @param texSizeDeclarations HLSL "uniform float4 texsize_..." declarations to insert.
 * @param generatorVersion The target GLSL version.
 * @param glslOut Receives the transpiled GLSL fragment shader code on success.
 * @param errorOut Receives a human-readable error message on failure.
 * @return true if transpiling succeeded, false otherwise.
 */
auto TranspileToGlsl(const std::string& preprocessedProgram,
                     const std::set<std::string>& samplerDeclarations,
                     const std::set<std::string>& texSizeDeclarations,
                     M4::GLSLGenerator::Version generatorVersion,
                     std::string& glslOut,
                     std::string& errorOut) -> bool;

} // namespace ShaderTranspiler
} // namespace MilkdropPreset
} // namespace libprojectM
