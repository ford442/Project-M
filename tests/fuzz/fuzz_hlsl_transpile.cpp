// fuzz_hlsl_transpile: the HLSL -> GLSL path PresetCompat uses (docs/FUZZING.md).
//
// Input: one preset shader as PresetFileParser::GetCode("warp_") returns it -- the text of
// the warp_N / comp_N lines with the backticks removed, "shader_body { ... }" and all. It is
// run through ShaderTranspiler::PreprocessPresetShader() and TranspileToGlsl() (hlslparser)
// as both a warp and a composite shader, since the two preprocess differently.
// Seeds: the warp/comp shaders of presets/tests/ (tests/fuzz/extract_seeds.py).
// Dictionary: dictionaries/hlsl.dict.

#include "FuzzShaderTranspile.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size)
{
    // The engine never gets more than a preset file's worth (PresetFileParser::maxFileSize),
    // and the transpiler is superlinear in places; bigger inputs only slow the fuzzer down.
    if (size > 64 * 1024)
    {
        return 0;
    }

    const std::string code(reinterpret_cast<const char*>(data), size);
    (void) ProjectMFuzz::TranspilePresetShader(ProjectMFuzz::ShaderTranspiler::ShaderType::WarpShader, code);
    (void) ProjectMFuzz::TranspilePresetShader(ProjectMFuzz::ShaderTranspiler::ShaderType::CompositeShader, code);
    return 0;
}
