#include <gtest/gtest.h>

#include <MilkdropPreset/PresetFileParser.hpp>
#include <MilkdropPreset/ShaderTranspiler.hpp>
#include <MilkdropStaticShaders.hpp>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <regex>
#include <set>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::MilkdropStaticShaders;
using libprojectM::MilkdropPreset::PresetFileParser;
namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;

static constexpr auto presetTestsDir{PROJECTM_PRESET_TESTS_DIR};
static constexpr auto customMilkFixedDir{PROJECTM_CUSTOM_MILK_FIXED_DIR};
static constexpr auto presetCompatTestDataPath{PROJECTM_TEST_DATA_DIR "/PresetCompat/"};

namespace {

/**
 * @brief Finds sampler names that are used via "tex3D(sampler_X, ...)" in the shader code.
 *
 * These samplers need to be declared as "sampler3D" rather than the default "sampler2D",
 * otherwise the HLSL parser rejects the tex3D() call due to a type mismatch.
 */
auto DetectSampler3DNames(const std::string& program) -> std::set<std::string>
{
    static const std::regex tex3DPattern(R"(tex3D\s*\(\s*sampler_([A-Za-z0-9_]+))");

    std::set<std::string> names;
    for (auto it = std::sregex_iterator(program.begin(), program.end(), tex3DPattern);
         it != std::sregex_iterator(); ++it)
    {
        names.insert((*it)[1].str());
    }
    return names;
}

/**
 * @brief Builds generic "sampler_X"/"texsize_X" uniform declarations for the given names.
 *
 * The real shader pipeline pulls these declarations from the texture manager, which requires
 * an OpenGL context. For compatibility testing, generic declarations are sufficient to verify
 * that the shader code parses and transpiles correctly. Samplers referenced via tex3D() are
 * declared as sampler3D, since the HLSL parser checks the sampler type against the texture
 * function used.
 */
void BuildSyntheticDeclarations(const std::set<std::string>& samplerNames,
                                const std::set<std::string>& sampler3DNames,
                                std::set<std::string>& samplerDeclarations,
                                std::set<std::string>& texSizeDeclarations)
{
    for (const auto& name : samplerNames)
    {
        const char* samplerType = sampler3DNames.count(name) > 0 ? "sampler3D" : "sampler2D";
        samplerDeclarations.insert(std::string("uniform ") + samplerType + " sampler_" + name + ";\n");
        texSizeDeclarations.insert("uniform float4 texsize_" + name + ";\n");

        // Random textures may also be referenced via their short "randXX" name, e.g.
        // "sampler_rand00" when "sampler_rand00_smalltiled" was used in the shader.
        if (name.length() > 7 && name.substr(0, 4) == "rand" &&
            std::isdigit(static_cast<unsigned char>(name.at(4))) &&
            std::isdigit(static_cast<unsigned char>(name.at(5))) &&
            name.at(6) == '_')
        {
            std::string shortName = name.substr(0, 6);
            samplerDeclarations.insert("uniform sampler2D sampler_" + shortName + ";\n");
            texSizeDeclarations.insert("uniform float4 texsize_" + shortName + ";\n");
        }
    }
}

/**
 * @brief Tries to transpile a single preset shader code block (warp_ or comp_) to GLSL.
 * @param type The type of shader the code belongs to.
 * @param code The raw shader code as returned by PresetFileParser::GetCode().
 * @return An empty string on success (or if the preset doesn't define this shader), or an
 *         error message describing the failure.
 */
auto TranspilePresetShader(ShaderTranspiler::ShaderType type, std::string code) -> std::string
{
    // Empty shader code means the preset doesn't override this shader, and the built-in
    // default shader is used instead. This is not an error.
    bool hasContent = std::any_of(code.begin(), code.end(), [](char c) {
        return !std::isspace(static_cast<unsigned char>(c));
    });
    if (!hasContent)
    {
        return {};
    }

    auto samplerNames = ShaderTranspiler::GetReferencedSamplers(code);
    auto sampler3DNames = DetectSampler3DNames(code);

    try
    {
        ShaderTranspiler::PreprocessPresetShader(type, code);
    }
    catch (const std::exception& ex)
    {
        return std::string("Preprocessing failed: ") + ex.what();
    }

    std::set<std::string> samplerDeclarations;
    std::set<std::string> texSizeDeclarations;
    BuildSyntheticDeclarations(samplerNames, sampler3DNames, samplerDeclarations, texSizeDeclarations);

    std::string glslCode;
    std::string errorMessage;
    if (!ShaderTranspiler::TranspileToGlsl(code, samplerDeclarations, texSizeDeclarations,
                                           MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(),
                                           glslCode, errorMessage))
    {
        return errorMessage;
    }

    return {};
}

/**
 * @brief Result of checking a single preset file.
 */
struct PresetCheckResult {
    bool parsed{false};
    std::string warpError;
    std::string compositeError;

    auto Passed() const -> bool
    {
        return parsed && warpError.empty() && compositeError.empty();
    }
};

/**
 * @brief Parses a preset file and transpiles its warp and composite shaders to GLSL.
 * @param filePath Path to the .milk preset file.
 * @return The result of the parse and transpile steps.
 */
auto CheckPreset(const std::string& filePath) -> PresetCheckResult
{
    PresetCheckResult result;

    PresetFileParser parser;
    if (!parser.Read(filePath))
    {
        result.parsed = false;
        return result;
    }
    result.parsed = true;

    result.warpError = TranspilePresetShader(ShaderTranspiler::ShaderType::WarpShader, parser.GetCode("warp_"));
    result.compositeError = TranspilePresetShader(ShaderTranspiler::ShaderType::CompositeShader, parser.GetCode("comp_"));

    return result;
}

/**
 * @brief Collects all *.milk files directly inside the given directory, sorted by name.
 * @param directory The directory to scan. May not exist, in which case an empty list is returned.
 */
auto CollectPresetFiles(const std::string& directory) -> std::vector<std::string>
{
    std::vector<std::string> files;

    std::error_code errorCode;
    if (directory.empty() || !std::filesystem::is_directory(directory, errorCode))
    {
        return files;
    }

    for (const auto& entry : std::filesystem::directory_iterator(directory))
    {
        if (entry.is_regular_file() && entry.path().extension() == ".milk")
        {
            files.push_back(entry.path().string());
        }
    }

    std::sort(files.begin(), files.end());
    return files;
}

/**
 * @brief Turns a preset file path into a valid Google Test parameter name.
 */
auto PresetFileTestName(const ::testing::TestParamInfo<std::string>& info) -> std::string
{
    std::string name = std::filesystem::path(info.param).stem().string();

    for (auto& c : name)
    {
        if (!std::isalnum(static_cast<unsigned char>(c)))
        {
            c = '_';
        }
    }

    if (name.empty())
    {
        name = "preset";
    }

    // Avoid duplicate test names if the sanitized stem collides between presets.
    return name + "_" + std::to_string(info.index);
}

} // namespace

/**
 * @brief Parses each preset file and transpiles its warp/composite shaders from HLSL to GLSL.
 *
 * This does not require an OpenGL context: shader compilation/linking is not performed.
 */
class PresetCompat : public ::testing::TestWithParam<std::string>
{
};

TEST_P(PresetCompat, ParseAndTranspile)
{
    const auto& filePath = GetParam();
    const auto result = CheckPreset(filePath);

    EXPECT_TRUE(result.parsed) << "Could not parse preset file \"" << filePath << "\".";
    EXPECT_TRUE(result.warpError.empty()) << "Warp shader transpile failed for \"" << filePath << "\":\n"
                                          << result.warpError;
    EXPECT_TRUE(result.compositeError.empty()) << "Composite shader transpile failed for \"" << filePath << "\":\n"
                                               << result.compositeError;
}

INSTANTIATE_TEST_SUITE_P(PresetTests, PresetCompat,
                         ::testing::ValuesIn(CollectPresetFiles(presetTestsDir)),
                         PresetFileTestName);

// The custom_milk_fixed/ collection currently contains some presets with known format
// issues (see AGENTS.md). Testing it is opt-in via PROJECTM_TEST_CUSTOM_MILK_FIXED=1 so
// that the default "projectM-unittest" CTest run (used by the main CI build) is not
// broken by these pre-existing, out-of-scope failures. scripts/test_presets.sh and the
// nightly preset-compat workflow set this variable.
INSTANTIATE_TEST_SUITE_P(CustomMilkFixed, PresetCompat,
                         ::testing::ValuesIn(std::getenv("PROJECTM_TEST_CUSTOM_MILK_FIXED")
                                                  ? CollectPresetFiles(customMilkFixedDir)
                                                  : std::vector<std::string>{}),
                         PresetFileTestName);

// Allows ad-hoc runs against an arbitrary preset directory, e.g. weeks_presets/, via
// `PROJECTM_PRESET_COMPAT_DIR=<path> ctest -R PresetCompat`. Empty/missing by default.
INSTANTIATE_TEST_SUITE_P(ExtraPresetDir, PresetCompat,
                         ::testing::ValuesIn(CollectPresetFiles(
                             std::getenv("PROJECTM_PRESET_COMPAT_DIR") ? std::getenv("PROJECTM_PRESET_COMPAT_DIR") : "")),
                         PresetFileTestName);

// Sanity checks using small, dedicated fixtures to verify the harness itself reports the
// expected outcomes for known-good and known-bad shader code.

TEST(PresetCompatFixtures, ValidWarpAndCompositeShadersTranspile)
{
    const auto result = CheckPreset(std::string(presetCompatTestDataPath) + "valid-warp-comp.milk");

    EXPECT_TRUE(result.parsed);
    EXPECT_TRUE(result.warpError.empty()) << result.warpError;
    EXPECT_TRUE(result.compositeError.empty()) << result.compositeError;
}

TEST(PresetCompatFixtures, MissingShaderBodyIsReportedAsFailure)
{
    const auto result = CheckPreset(std::string(presetCompatTestDataPath) + "broken-missing-shader-body.milk");

    ASSERT_TRUE(result.parsed);
    EXPECT_FALSE(result.warpError.empty());
    EXPECT_NE(result.warpError.find("shader_body"), std::string::npos) << result.warpError;
}

TEST(PresetCompatFixtures, InvalidHlslIsReportedAsFailure)
{
    const auto result = CheckPreset(std::string(presetCompatTestDataPath) + "broken-invalid-hlsl.milk");

    ASSERT_TRUE(result.parsed);
    EXPECT_FALSE(result.warpError.empty());
    EXPECT_NE(result.warpError.find("HLSL parsing failed"), std::string::npos) << result.warpError;
}
