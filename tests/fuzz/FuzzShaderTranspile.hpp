#pragma once

// The HLSL -> GLSL path that PresetCompat runs (tests/libprojectM/PresetCompatTest.cpp,
// TranspilePresetShader()), shared by fuzz_hlsl_transpile and fuzz_shader_passes.
//
// Two deliberate differences from PresetCompat:
//  - Only the exception the engine itself handles around preprocessing is caught
//    (Renderer::ShaderException, MilkdropShader.cpp). Anything else that escapes -- an
//    std::out_of_range from a bad string offset, say -- is a finding, so it must reach libFuzzer.
//  - The tex3D() sampler scan is a plain substring walk instead of a std::regex, which is
//    slow enough under ASan to cut the fuzzer's throughput several times over.

#include <MilkdropPreset/ShaderTranspiler.hpp>
#include <MilkdropStaticShaders.hpp> // generated into the MilkdropPreset build dir
#include <Renderer/Shader.hpp>       // Renderer::ShaderException

#include <cctype>
#include <set>
#include <string>

namespace ProjectMFuzz {

namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;

/**
 * @brief Names X used as "tex3D(sampler_X": they are declared sampler3D, as in PresetCompat.
 */
inline auto Sampler3DNames(const std::string& program) -> std::set<std::string>
{
    std::set<std::string> names;
    static const std::string call = "tex3D";
    static const std::string prefix = "sampler_";
    for (auto pos = program.find(call); pos != std::string::npos; pos = program.find(call, pos + 1))
    {
        auto cursor = pos + call.length();
        while (cursor < program.length() && std::isspace(static_cast<unsigned char>(program[cursor])))
        {
            cursor++;
        }
        if (cursor >= program.length() || program[cursor] != '(')
        {
            continue;
        }
        cursor++;
        while (cursor < program.length() && std::isspace(static_cast<unsigned char>(program[cursor])))
        {
            cursor++;
        }
        if (program.compare(cursor, prefix.length(), prefix) != 0)
        {
            continue;
        }
        cursor += prefix.length();
        auto end = cursor;
        while (end < program.length() && (std::isalnum(static_cast<unsigned char>(program[end])) || program[end] == '_'))
        {
            end++;
        }
        if (end > cursor)
        {
            names.insert(program.substr(cursor, end - cursor));
        }
    }
    return names;
}

/**
 * @brief Preprocesses and transpiles one preset shader (warp_ or comp_ code) like PresetCompat.
 * @return true if it transpiled, false if the engine would refuse it (an expected outcome).
 */
inline auto TranspilePresetShader(ShaderTranspiler::ShaderType type, std::string code) -> bool
{
    bool hasContent = false;
    for (char c : code)
    {
        if (!std::isspace(static_cast<unsigned char>(c)))
        {
            hasContent = true;
            break;
        }
    }
    if (!hasContent)
    {
        return true; // No override, the built-in shader is used.
    }

    auto samplerNames = ShaderTranspiler::GetReferencedSamplers(code);
    const auto sampler3DNames = Sampler3DNames(code);

    // GetBlurN() declares blur1..N without a sampler_blurN reference (MilkdropShader's
    // maxBlurLevelRequired), as in PresetCompat.
    for (int level = 3; level >= 1; level--)
    {
        if (code.find("GetBlur" + std::to_string(level)) != std::string::npos)
        {
            for (int declared = 1; declared <= level; declared++)
            {
                samplerNames.insert("blur" + std::to_string(declared));
            }
            break;
        }
    }

    try
    {
        ShaderTranspiler::PreprocessPresetShader(type, code);
    }
    catch (const libprojectM::Renderer::ShaderException&)
    {
        return false;
    }

    std::set<std::string> samplerDeclarations;
    std::set<std::string> texSizeDeclarations;
    for (const auto& name : samplerNames)
    {
        const char* samplerType = sampler3DNames.count(name) > 0 ? "sampler3D" : "sampler2D";
        samplerDeclarations.insert(std::string("uniform ") + samplerType + " sampler_" + name + ";\n");
        texSizeDeclarations.insert("uniform float4 texsize_" + name + ";\n");

        // "sampler_rand00_smalltiled" is also reachable as "sampler_rand00".
        if (name.length() > 7 && name.compare(0, 4, "rand") == 0 &&
            std::isdigit(static_cast<unsigned char>(name.at(4))) &&
            std::isdigit(static_cast<unsigned char>(name.at(5))) &&
            name.at(6) == '_')
        {
            const auto shortName = name.substr(0, 6);
            samplerDeclarations.insert("uniform sampler2D sampler_" + shortName + ";\n");
            texSizeDeclarations.insert("uniform float4 texsize_" + shortName + ";\n");
        }
    }

    std::string glsl;
    std::string error;
    return ShaderTranspiler::TranspileToGlsl(code, samplerDeclarations, texSizeDeclarations,
                                             libprojectM::MilkdropPreset::MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(),
                                             glsl, error);
}

} // namespace ProjectMFuzz
