#include "ShaderTranspiler.hpp"

#include "Utils.hpp"

#include <MilkdropStaticShaders.hpp>

#include <GLSLGenerator.h>
#include <HLSLParser.h>
#include <Renderer/Shader.hpp>

#include <regex>

namespace libprojectM {
namespace MilkdropPreset {
namespace ShaderTranspiler {

auto GetReferencedSamplers(const std::string& program) -> std::set<std::string>
{
    std::set<std::string> samplerNames;

    // "main" should always be present.
    samplerNames.insert("main");

    // Strip comments so that commented-out sampler/texsize declarations are not matched.
    std::string const stripped = Utils::StripComments(program);

    // Search for sampler usage
    auto found = stripped.find("sampler_", 0);
    while (found != std::string::npos)
    {
        found += 8;
        size_t const end = stripped.find_first_of(" ;,\n\r)", found);

        if (end != std::string::npos)
        {
            std::string const sampler = stripped.substr(static_cast<int>(found), static_cast<int>(end - found));
            // Skip "sampler_state", as it's a reserved word and not a sampler.
            if (sampler != "state")
            {
                samplerNames.insert(sampler);
            }
        }

        found = stripped.find("sampler_", found);
    }

    // Also search for texsize usage, some presets don't reference the sampler.
    found = stripped.find("texsize_", 0);
    while (found != std::string::npos)
    {
        found += 8;
        size_t const end = stripped.find_first_of(" ;,.\n\r)", found);

        if (end != std::string::npos)
        {
            std::string const sampler = stripped.substr(static_cast<int>(found), static_cast<int>(end - found));
            samplerNames.insert(sampler);
        }

        found = stripped.find("texsize_", found);
    }

    return samplerNames;
}

void PreprocessPresetShader(ShaderType type, std::string& program)
{
    std::string shaderTypeString = "composite";
    if (type == ShaderType::WarpShader)
    {
        shaderTypeString = "warp";
    }

    if (program.length() <= 0)
    {
        throw Renderer::ShaderException("[MilkdropShader] Preset " + shaderTypeString + " shader is declared, but empty.");
    }

    size_t found;

    // Find "sampler_state" overrides and remove them first, as they're not supported by GLSL.
    // The logic isn't totally fool-proof, but should work in general.
    // Use a comment-stripped copy for searching so commented-out sampler_state blocks are skipped.
    // StripComments preserves string length, so positions map 1:1 to the original.
    std::string stripped = Utils::StripComments(program);
    found = stripped.find("sampler_state");
    while (found != std::string::npos)
    {
        // Now go backwards and find the assignment
        found = stripped.rfind('=', found);
        auto startPos = found;

        // Find closing brace and semicolon
        found = stripped.find('}', found);
        found = stripped.find(';', found);

        if (found != std::string::npos)
        {
            stripped.replace(startPos, found - startPos, "");
        }
        else
        {
            // No closing brace and semicolon.
            break;
        }

        found = stripped.find("sampler_state");
    }

    // replace shader_body with entry point function
    // Use the stripped copy so a commented-out shader_body is not matched.
    found = stripped.find("shader_body");
    if (found != std::string::npos)
    {
        if (type == ShaderType::WarpShader)
        {
            program.replace(int(found), 11, R"(
void PS(float4 _vDiffuse : COLOR,
        float4 _uv : TEXCOORD0,
        float2 _rad_ang : TEXCOORD1,
        out float4 _return_value : COLOR0,
        out float4 _mv_tex_coords : COLOR1)
)");
        }
        else
        {
            program.replace(int(found), 11, R"(
void PS(float4 _vDiffuse : COLOR,
        float2 _uv : TEXCOORD0,
        float2 _rad_ang : TEXCOORD1,
        out float4 _return_value : COLOR)
)");
        }
    }
    else
    {
        throw Renderer::ShaderException("[MilkdropShader] Preset " + shaderTypeString + " shader is missing \"shader_body\" entry point.");
    }

    // replace the "{" immediately following shader_body with some variable declarations
    found = program.find('{', found);
    if (found != std::string::npos)
    {
        std::string progMain = "{\nfloat3 ret = 0;\n";
        if (type == ShaderType::WarpShader)
        {
            progMain.append("_mv_tex_coords.xy = _uv.xy;\n");
        }
        program.replace(int(found), 1, progMain);
    }
    else
    {
        throw Renderer::ShaderException("[MilkdropShader] Preset " + shaderTypeString + " shader has no opening braces.");
    }

    // replace "}" with return statement (this can probably be optimized for the GLSL conversion...)
    found = program.rfind('}');
    if (found != std::string::npos)
    {
#ifdef PROJECTM_HDR_RENDERING
        // Composite shader: apply Reinhard tone-mapping + sRGB gamma encode at the final
        // output stage. This is the correct place — the warp shader output stays linear so
        // the feedback loop operates in linear light, and tone-mapping only runs once here.
        if (type == ShaderType::CompositeShader)
        {
            program.replace(int(found), 1, "_return_value = float4(_prjm_hdr_out(ret.xyz), 1.0);\n"
                                           "}\n");
        }
        else
#endif
        {
            program.replace(int(found), 1, "_return_value = float4(ret.xyz, 1.0);\n"
                                           "}\n");
        }
    }
    else
    {
        throw Renderer::ShaderException("[MilkdropShader] Preset " + shaderTypeString + " shader has no closing brace.");
    }

    // Find matching closing brace and cut off excess text after shader's main function
    int bracesOpen = 1;
    size_t pos = found + 1;
    for (; pos < program.length() && bracesOpen > 0; ++pos)
    {
        switch (program.at(pos))
        {
            case '/':
                // Skip line comments until EoL to prevent false counting
                if (pos < program.length() - 1 && program.at(pos + 1) == '/')
                {
                    for (; pos < program.length(); ++pos)
                    {
                        if (program.at(pos) == '\n')
                        {
                            break;
                        }
                    }
                }
                // Skip block comments to prevent false counting
                else if (pos < program.length() - 1 && program.at(pos + 1) == '*')
                {
                    pos += 2;
                    for (; pos < program.length() - 1; ++pos)
                    {
                        if (program.at(pos) == '*' && program.at(pos + 1) == '/')
                        {
                            ++pos; // skip past '/'
                            break;
                        }
                    }
                }
                continue;

            case '{':
                bracesOpen++;
                continue;

            case '}':
                bracesOpen--;
        }
    }

    if (pos < program.length() - 1)
    {
        program.resize(pos);
    }

    std::string fullSource; //!< Full shader source before translation, includes all uniforms etc.

    // First copy the generic "header" into the shader. Includes uniforms and some defines
    // to unwrap the packed 4-element uniforms into single values.
    fullSource.append(MilkdropStaticShaders::Get()->GetPresetShaderHeader());

    if (type == ShaderType::WarpShader)
    {
        fullSource.append("#define rad _rad_ang.x\n"
                          "#define ang _rad_ang.y\n"
                          "#define uv _uv.xy\n"
                          "#define uv_orig _uv.zw\n");
    }
    else
    {
        fullSource.append("#define rad _rad_ang.x\n"
                          "#define ang _rad_ang.y\n"
                          "#define uv _uv.xy\n"
                          "#define uv_orig _uv.xy\n"
                          "#define hue_shader _vDiffuse.xyz\n");

#ifdef PROJECTM_HDR_RENDERING
        // Inject HDR tone-mapping helpers into the composite shader (HLSL syntax).
        // _prjm_hdr_out is called on ret.xyz just before the output assignment,
        // converting linear light to tone-mapped, sRGB-gamma-encoded display output.
        // The transpiler converts saturate→clamp, lerp→mix, mul→matrix multiply, etc.
        fullSource.append(
            "float3 _prjm_reinhard(float3 c) {\n"
            "    float lum = dot(c, float3(0.2126, 0.7152, 0.0722));\n"
            "    return c * (lum / ((1.0 + lum) * max(lum, 0.0001)));\n"
            "}\n"
            "float3 _prjm_linear_to_srgb(float3 c) {\n"
            "    float3 lo = c * 12.92;\n"
            "    float3 hi = 1.055 * pow(saturate(c), 1.0 / 2.4) - 0.055;\n"
            "    return lerp(lo, hi, step(0.0031308, c));\n"
            "}\n"
            "float3 _prjm_hdr_out(float3 c) {\n"
            "    c = _prjm_linear_to_srgb(_prjm_reinhard(c));\n"
#ifdef PROJECTM_HDR_P3
            // BT.709 → Display-P3 (D65) color matrix, row-major HLSL convention.
            "    float3x3 _bt709_to_p3 = float3x3(\n"
            "        0.8225, 0.1774, 0.0003,\n"
            "        0.0331, 0.9669, 0.0003,\n"
            "        0.0171, 0.0724, 0.9108);\n"
            "    c = saturate(mul(_bt709_to_p3, c));\n"
#endif
            "    return c;\n"
            "}\n");
#endif
    }

    fullSource.append(program);

    program = fullSource;
}

auto TranspileToGlsl(const std::string& preprocessedProgram,
                     const std::set<std::string>& samplerDeclarations,
                     const std::set<std::string>& texSizeDeclarations,
                     M4::GLSLGenerator::Version generatorVersion,
                     std::string& glslOut,
                     std::string& errorOut) -> bool
{
    M4::GLSLGenerator generator;
    M4::Allocator allocator;

    M4::HLSLTree tree(&allocator);
    M4::HLSLParser parser(&allocator, &tree);

    // Preprocess define macros
    std::string sourcePreprocessed;
    if (!parser.ApplyPreprocessor("", preprocessedProgram.c_str(), preprocessedProgram.size(), sourcePreprocessed))
    {
        errorOut = "Preprocessing failed.";
        return false;
    }

    // Remove previous shader declarations
    // ToDo: Quite some presets declare a sampler_state{} struct to change the wrap mode.
    //       The below code causes invalid syntax as it leaves part of the expression.
    //       Leaving it in causes HLSLParser to add "sampler_XYZ = sampler2D( <unknown expression> );"
    //       in the main() function, which is also bad...
    std::smatch matches;
    while (std::regex_search(sourcePreprocessed, matches, std::regex("sampler(2D|3D|)(\\s+|\\().*")))
    {
        sourcePreprocessed.replace(matches.position(), matches.length(), "");
    }

    // Remove previous texsize declarations
    while (std::regex_search(sourcePreprocessed, matches, std::regex("float4\\s+texsize_.*")))
    {
        sourcePreprocessed.replace(matches.position(), matches.length(), "");
    }

    // Now insert the given declarations on top.
    for (const auto& texSizeDeclaration : texSizeDeclarations)
    {
        sourcePreprocessed.insert(0, texSizeDeclaration);
    }
    for (const auto& samplerDeclaration : samplerDeclarations)
    {
        sourcePreprocessed.insert(0, samplerDeclaration);
    }

    // Transpile from HLSL (aka preset shader aka DirectX shader) to GLSL (aka OpenGL shader lang)
    // First, parse HLSL into a tree
    if (!parser.Parse("", sourcePreprocessed.c_str(), sourcePreprocessed.size()))
    {
        errorOut = "HLSL parsing failed.\nPreprocessed source:\n" + sourcePreprocessed;
        return false;
    }

    // Then generate GLSL from the resulting parser tree
    if (!generator.Generate(&tree, M4::GLSLGenerator::Target_FragmentShader,
                            generatorVersion, "PS",
                            M4::GLSLGenerator::Options(M4::GLSLGenerator::Flag_AlternateNanPropagation)))
    {
        errorOut = "GLSL generating failed.\nPreprocessed source:\n" + sourcePreprocessed;
        return false;
    }

    glslOut = generator.GetResult();
    return true;
}

} // namespace ShaderTranspiler
} // namespace MilkdropPreset
} // namespace libprojectM
