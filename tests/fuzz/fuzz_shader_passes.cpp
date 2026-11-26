// fuzz_shader_passes: warp_nPasses / comp_nPasses parsing (#229) end to end (docs/FUZZING.md).
//
// Input: a whole .milk file. It is read the way PresetState reads one -- shader versions,
// the stage shaders through ExperimentalDepthSampler::ShaderCode(), then
// PresetState::ReadShaderPasses() for both stages -- and every stage and pass shader that
// survives is transpiled like PresetCompat does. ReadShaderPasses() refusing a declaration
// (MilkdropPresetLoadException) is an expected outcome; any other exception is a finding.
// Seeds: presets/tests/ (310/311 are the shader-pass fixtures). Dictionary: dictionaries/milk.dict.

#include "FuzzShaderTranspile.hpp"

#include <MilkdropPreset/ExperimentalDepthSampler.hpp>
#include <MilkdropPreset/MilkdropPresetExceptions.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>
#include <MilkdropPreset/PresetState.hpp>

#include <cstddef>
#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size)
{
    using libprojectM::MilkdropPreset::ExperimentalDepthSampler;
    using libprojectM::MilkdropPreset::MilkdropPresetLoadException;
    using libprojectM::MilkdropPreset::PresetFileParser;
    using libprojectM::MilkdropPreset::PresetState;
    using ProjectMFuzz::ShaderTranspiler::ShaderType;

    if (size > 64 * 1024)
    {
        return 0;
    }

    std::istringstream stream(std::string(reinterpret_cast<const char*>(data), size), std::ios_base::in | std::ios_base::binary);
    PresetFileParser parser;
    if (!parser.Read(stream))
    {
        return 0;
    }

    int presetVersion = PresetState::DefaultPresetVersion;
    int warpShaderVersion = PresetState::DefaultShaderVersion;
    int compositeShaderVersion = PresetState::DefaultShaderVersion;
    PresetState::ReadShaderVersions(parser, presetVersion, warpShaderVersion, compositeShaderVersion);

    const auto warpShader = ExperimentalDepthSampler::ShaderCode(parser, "warp_");
    const auto compositeShader = ExperimentalDepthSampler::ShaderCode(parser, "comp_");

    const auto runStage = [&](const char* stage, ShaderType type, int shaderVersion, const std::string& stageShader) {
        std::vector<std::string> passes;
        try
        {
            passes = PresetState::ReadShaderPasses(parser, stage, shaderVersion > 0 && !stageShader.empty());
        }
        catch (const MilkdropPresetLoadException&)
        {
            return; // The engine refuses the preset here.
        }
        if (!ProjectMFuzz::TranspilePresetShader(type, stageShader))
        {
            return;
        }
        for (const auto& pass : passes)
        {
            if (!ProjectMFuzz::TranspilePresetShader(type, pass))
            {
                return;
            }
        }
    };

    runStage("warp", ShaderType::WarpShader, warpShaderVersion, warpShader);
    runStage("comp", ShaderType::CompositeShader, compositeShaderVersion, compositeShader);
    return 0;
}
