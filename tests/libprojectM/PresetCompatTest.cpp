#include "HeadlessGlContext.hpp"

#include <gtest/gtest.h>

#include <MilkdropPreset/MilkdropShader.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>
#include <MilkdropPreset/ShaderTranspiler.hpp>
#include <MilkdropStaticShaders.hpp>
#include <Renderer/ShaderTranspileCache.hpp>

#include <projectM-4/projectM.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <atomic>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <vector>

using libprojectM::MilkdropPreset::MilkdropStaticShaders;
using libprojectM::MilkdropPreset::PresetFileParser;
namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;

static constexpr auto presetTestsDir{PROJECTM_PRESET_TESTS_DIR};
static constexpr auto customMilkFixedDir{PROJECTM_CUSTOM_MILK_FIXED_DIR};
static constexpr auto presetCompatTestDataPath{PROJECTM_TEST_DATA_DIR "/PresetCompat/"};
static constexpr auto presetPrepareTestDataDir{PROJECTM_TEST_DATA_DIR "/PresetPrepare"};

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

/**
 * @brief A GL-backed projectM instance that records the GLSL every preset load compiles.
 *
 * The GLSL is captured through the transpiled-GLSL cache's store hook, which the render thread
 * calls with each freshly transpiled shader, whether it came from the transpiler or from a
 * prepared preset's speculative transpile. The lookup hook never hits, so every load transpiles.
 * The cache key tells the two loads of one preset apart.
 */
class PreparedGlslHarness
{
public:
    static auto Get() -> PreparedGlslHarness*
    {
        static std::unique_ptr<PreparedGlslHarness> harness = Create();
        return harness.get();
    }

    ~PreparedGlslHarness()
    {
        libprojectM::Renderer::ClearTranspiledGlslCacheCallbacks();
        libprojectM::Renderer::ClearTranspiledGlslCacheKey();
        if (m_projectM != nullptr)
        {
            projectm_destroy(m_projectM);
        }
        std::error_code ignored;
        std::filesystem::remove_all(m_textureDir, ignored);
    }

    struct LoadResult {
        std::map<int, std::string> glsl; //!< Compiled GLSL by shader type (0 = warp, 1 = composite).
        std::string failure;             //!< Preset switch failed message, if any.
    };

    /**
     * @brief Loads the preset in one go, as projectm_load_preset_file() always has.
     */
    auto LoadInline(const std::string& filePath) -> LoadResult
    {
        return Load("inline", [&]() {
            projectm_load_preset_file(m_projectM, filePath.c_str(), false);
        });
    }

    /**
     * @brief Loads the preset in steps, preparing it on another thread while this one renders.
     */
    auto LoadPrepared(const std::string& filePath) -> LoadResult
    {
        return LoadJob("prepared", [&]() {
            return projectm_preset_prepare_begin_file(m_projectM, filePath.c_str());
        });
    }

    /**
     * @brief Runs @a begin, prepares the job on another thread while rendering frames here, then loads it.
     */
    template<typename BeginFunction>
    auto LoadJob(const std::string& cacheKey, BeginFunction&& begin) -> LoadResult
    {
        return Load(cacheKey, [&]() {
            auto* job = begin();
            std::atomic<bool> done{false};
            std::thread worker([job, &done]() {
                projectm_preset_prepare_run(job);
                done = true;
            });
            // The render thread keeps drawing the current preset: preparation must not touch GL.
            do
            {
                projectm_opengl_render_frame(m_projectM);
            } while (!done);
            worker.join();
            projectm_load_prepared_preset(m_projectM, job, false);
        });
    }

    /**
     * @brief Makes the transpiled-GLSL cache serve @a glsl for @a shaderType under @a cacheKey.
     */
    void SetCachedGlsl(const std::string& cacheKey, int shaderType, const std::string& glsl)
    {
        m_cached[cacheKey][shaderType] = glsl;
    }

    auto Instance() const -> projectm_handle
    {
        return m_projectM;
    }

    /**
     * @brief Runs @a load with @a cacheKey armed and returns what it compiled and reported.
     */
    template<typename LoadFunction>
    auto Load(const std::string& cacheKey, LoadFunction&& load) -> LoadResult
    {
        // Other tests in the run create and make current their own contexts.
        EXPECT_TRUE(m_glContext->MakeCurrent());
        m_stored.erase(cacheKey);
        m_failure.clear();
        libprojectM::Renderer::SetTranspiledGlslCacheKey(cacheKey);
        load();
        libprojectM::Renderer::ClearTranspiledGlslCacheKey();
        return {m_stored[cacheKey], m_failure};
    }

private:
    static auto Create() -> std::unique_ptr<PreparedGlslHarness>
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            return nullptr;
        }
        auto harness = std::unique_ptr<PreparedGlslHarness>(new PreparedGlslHarness());
        harness->m_glContext = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!harness->m_glContext->Valid())
        {
            return nullptr;
        }
        harness->m_projectM = projectm_create();
        if (harness->m_projectM == nullptr)
        {
            return nullptr;
        }
        projectm_set_window_size(harness->m_projectM, 64, 64);

        // Texture files for random and named texture lookups: two that match the "pm" prefix,
        // one that is also referenced by name.
        harness->m_textureDir = std::filesystem::temp_directory_path() /
                                ("projectm-prepare-textures-" + std::to_string(reinterpret_cast<uintptr_t>(harness.get())));
        std::filesystem::create_directories(harness->m_textureDir);
        for (const char* name : {"pm_one.bmp", "pm_two.bmp", "pmtex.bmp"})
        {
            WriteSolidBmp(harness->m_textureDir / name);
        }
        const std::string textureDir = harness->m_textureDir.string();
        const char* texturePaths[] = {textureDir.c_str()};
        projectm_set_texture_search_paths(harness->m_projectM, texturePaths, 1);

        projectm_set_preset_switch_failed_event_callback(
            harness->m_projectM,
            [](const char*, const char* message, void* userData) {
                static_cast<PreparedGlslHarness*>(userData)->m_failure = message;
            },
            harness.get());

        libprojectM::Renderer::SetTranspiledGlslCacheCallbacks(
            [harness = harness.get()](const std::string& key, int shaderType) -> std::optional<std::string> {
                const auto entry = harness->m_cached.find(key);
                if (entry == harness->m_cached.end() || entry->second.count(shaderType) == 0)
                {
                    return std::nullopt;
                }
                return entry->second.at(shaderType);
            },
            [harness = harness.get()](const std::string& key, int shaderType, const std::string& glsl) {
                harness->m_stored[key][shaderType] = glsl;
            });
        return harness;
    }

    /**
     * @brief Writes a 1x1, 24-bit BMP, which stb_image can decode.
     */
    static void WriteSolidBmp(const std::filesystem::path& path)
    {
        const unsigned char bmp[] = {
            'B', 'M', 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0,           // File header
            40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0,         // DIB header: 1x1, 24 bpp
            0, 0, 0, 0, 4, 0, 0, 0, 0x13, 0x0B, 0, 0, 0x13, 0x0B, 0, 0, //
            0, 0, 0, 0, 0, 0, 0, 0,                                   //
            0x40, 0x80, 0xC0, 0};                                     // One pixel + row padding
        std::ofstream file(path, std::ios::binary);
        file.write(reinterpret_cast<const char*>(bmp), sizeof(bmp));
    }

    PreparedGlslHarness() = default;

    std::unique_ptr<libprojectM::Test::HeadlessGlContext> m_glContext;
    projectm_handle m_projectM{nullptr};
    std::filesystem::path m_textureDir;
    std::map<std::string, std::map<int, std::string>> m_stored; //!< GLSL passed to the store hook, by cache key and shader type.
    std::map<std::string, std::map<int, std::string>> m_cached; //!< GLSL the lookup hook serves, by cache key and shader type.
    std::string m_failure;                                      //!< Last preset switch failed message.
};

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

/**
 * @brief Preparing a preset off the render thread compiles byte-identical GLSL to loading it inline.
 *
 * The background preparation transpiles each shader with the sampler/texsize declarations it
 * predicts the render thread will build. The render thread only uses that GLSL if its own
 * declarations are identical; this checks that the prediction holds (no fallback transpile) and
 * that the GLSL, and any failure, match the inline load. Needs a GL context; skipped without one.
 */
class PresetCompatPrepared : public ::testing::TestWithParam<std::string>
{
};

TEST_P(PresetCompatPrepared, GlslMatchesInlineTranspile)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    const auto& filePath = GetParam();
    const auto inlineLoad = harness->LoadInline(filePath);

    const auto usedBefore = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount();
    const auto mismatchedBefore = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslMismatchCount();
    const auto preparedLoad = harness->LoadPrepared(filePath);
    const auto used = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount() - usedBefore;
    const auto mismatched = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslMismatchCount() - mismatchedBefore;

    EXPECT_EQ(mismatched, 0u) << "Predicted declarations differed from the render thread's for \"" << filePath << "\".";
    EXPECT_GE(used, preparedLoad.glsl.size()) << "A shader was transpiled on the render thread for \"" << filePath << "\".";
    EXPECT_EQ(inlineLoad.failure, preparedLoad.failure);
    ASSERT_EQ(inlineLoad.glsl.size(), preparedLoad.glsl.size()) << filePath;
    for (const auto& [shaderType, glsl] : inlineLoad.glsl)
    {
        EXPECT_EQ(glsl, preparedLoad.glsl.at(shaderType)) << (shaderType == 0 ? "Warp" : "Composite")
                                                          << " GLSL differs for \"" << filePath << "\".";
    }
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

// The prepared-GLSL comparison runs over the same preset sets, plus fixtures exercising the
// declaration prediction: random and named textures, volume textures, blur levels, and shaders
// that fail to transpile.
INSTANTIATE_TEST_SUITE_P(PresetTests, PresetCompatPrepared,
                         ::testing::ValuesIn(CollectPresetFiles(presetTestsDir)),
                         PresetFileTestName);

INSTANTIATE_TEST_SUITE_P(CustomMilkFixed, PresetCompatPrepared,
                         ::testing::ValuesIn(std::getenv("PROJECTM_TEST_CUSTOM_MILK_FIXED")
                                                 ? CollectPresetFiles(customMilkFixedDir)
                                                 : std::vector<std::string>{}),
                         PresetFileTestName);

INSTANTIATE_TEST_SUITE_P(ExtraPresetDir, PresetCompatPrepared,
                         ::testing::ValuesIn(CollectPresetFiles(
                             std::getenv("PROJECTM_PRESET_COMPAT_DIR") ? std::getenv("PROJECTM_PRESET_COMPAT_DIR") : "")),
                         PresetFileTestName);

INSTANTIATE_TEST_SUITE_P(PrepareFixtures, PresetCompatPrepared,
                         ::testing::ValuesIn(CollectPresetFiles(presetPrepareTestDataDir)),
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

// The prepared-GLSL comparison above only proves the two paths agree. These pin down what the
// fixtures are there to exercise, so a fixture that silently stops compiling fails loudly.

namespace {

auto PrepareFixture(const std::string& name) -> std::string
{
    return std::string(presetPrepareTestDataDir) + "/" + name;
}

} // namespace

TEST(PresetCompatPreparedFixtures, TextureFixturesCompileBothShadersFromPreparedGlsl)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    for (const char* name : {"prepare-random-textures.milk", "prepare-named-textures.milk"})
    {
        const auto usedBefore = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount();
        const auto load = harness->LoadPrepared(PrepareFixture(name));
        EXPECT_TRUE(load.failure.empty()) << name << ": " << load.failure;
        EXPECT_EQ(load.glsl.size(), 2u) << name;
        EXPECT_EQ(libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount() - usedBefore, 2u) << name;
    }
}

TEST(PresetCompatPreparedFixtures, BrokenShadersFallBackAsInline)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    // The warp shader fails to transpile, so the preset runs without one; the composite shader
    // fails too and is replaced by the default one, which is transpiled on the render thread.
    const auto broken = harness->LoadPrepared(PrepareFixture("prepare-broken-shaders.milk"));
    EXPECT_TRUE(broken.failure.empty()) << broken.failure;
    EXPECT_EQ(broken.glsl.count(0), 0u);
    EXPECT_EQ(broken.glsl.count(1), 1u);

    // An unresolved random texture leaves its sampler undeclared; the prediction must know that
    // too (the parameterized comparison checks it matched), and the warp shader is dropped.
    const auto unresolved = harness->LoadPrepared(PrepareFixture("prepare-random-unresolved.milk"));
    EXPECT_TRUE(unresolved.failure.empty()) << unresolved.failure;
    EXPECT_EQ(unresolved.glsl.count(0), 0u);
    EXPECT_EQ(unresolved.glsl.count(1), 1u);
}

TEST(PresetCompatPreparedJobs, CachedShaderIsNotTranspiledAhead)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    const auto preset = PrepareFixture("prepare-named-textures.milk");
    const auto inlineLoad = harness->LoadInline(preset);
    ASSERT_EQ(inlineLoad.glsl.count(0), 1u);

    // With the warp shader in the transpile cache, the render thread compiles the cached GLSL,
    // so preparation only transpiles the composite shader.
    harness->SetCachedGlsl("cached-warp", 0, inlineLoad.glsl.at(0));
    const auto usedBefore = libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount();
    const auto load = harness->LoadJob("cached-warp", [&]() {
        return projectm_preset_prepare_begin_file(harness->Instance(), preset.c_str());
    });
    EXPECT_EQ(libprojectM::MilkdropPreset::MilkdropShader::PreparedGlslUseCount() - usedBefore, 1u);
    EXPECT_EQ(load.glsl.count(0), 0u) << "The cached warp shader was transpiled again.";
    ASSERT_EQ(load.glsl.count(1), 1u);
    EXPECT_EQ(load.glsl.at(1), inlineLoad.glsl.at(1));
}

TEST(PresetCompatPreparedJobs, FailedPrepareReportsTheInlineError)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    const auto missing = PrepareFixture("does-not-exist.milk");
    const auto inlineLoad = harness->LoadInline(missing);
    ASSERT_FALSE(inlineLoad.failure.empty());

    projectm_preset_prepare_job_handle job = nullptr;
    const auto load = harness->LoadJob("failed", [&]() {
        job = projectm_preset_prepare_begin_file(harness->Instance(), missing.c_str());
        return job;
    });
    EXPECT_EQ(load.failure, inlineLoad.failure);
}

TEST(PresetCompatPreparedJobs, DataJobMatchesInlineData)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    std::ifstream file(PrepareFixture("prepare-named-textures.milk"));
    const std::string data{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};

    const auto inlineLoad = harness->Load("inline-data", [&]() {
        projectm_load_preset_data(harness->Instance(), data.c_str(), false);
    });
    const auto load = harness->LoadJob("prepared-data", [&]() {
        return projectm_preset_prepare_begin_data(harness->Instance(), data.c_str());
    });
    EXPECT_TRUE(load.failure.empty()) << load.failure;
    EXPECT_EQ(load.glsl.size(), 2u);
    EXPECT_EQ(load.glsl, inlineLoad.glsl);
}

TEST(PresetCompatPreparedJobs, JobOutlivesTheInstanceThatBeganIt)
{
    auto* harness = PreparedGlslHarness::Get();
    if (harness == nullptr)
    {
        GTEST_SKIP() << "No OpenGL context available.";
    }

    // A host can be torn down while its preparation is in flight; the job must stay runnable,
    // freeable, and loadable into another instance.
    const auto preset = PrepareFixture("prepare-random-textures.milk");
    auto* other = projectm_create();
    ASSERT_NE(other, nullptr);
    auto* orphan = projectm_preset_prepare_begin_file(other, preset.c_str());
    auto* adopted = projectm_preset_prepare_begin_file(other, preset.c_str());
    projectm_destroy(other);

    std::thread worker([orphan, adopted]() {
        projectm_preset_prepare_run(orphan);
        projectm_preset_prepare_run(adopted);
    });
    worker.join();
    EXPECT_FALSE(projectm_preset_prepare_failed(orphan));
    projectm_preset_prepare_free(orphan);

    const auto load = harness->Load("adopted", [&]() {
        projectm_load_prepared_preset(harness->Instance(), adopted, false);
    });
    EXPECT_TRUE(load.failure.empty()) << load.failure;
    EXPECT_EQ(load.glsl.size(), 2u);
}
