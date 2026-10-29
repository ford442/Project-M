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
