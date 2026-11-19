/**
 * @file ShaderPassTest.cpp
 * @brief Extra shader passes in .milk files: warp_nPasses / comp_nPasses (#229, docs/MILK_SHADER_PASSES.md).
 *
 * Without GL: PresetState::ReadShaderPasses() accepts 1..3 passes and refuses the rest.
 *
 * On a GL context (SDL2 + a display, or xvfb-run), through the C API:
 *  - presets/tests/310-shaderpass-two-pass-warp.milk shows its pass's gradient, upright,
 *    with iPass 0 in the pass and 1 in the warp shader;
 *  - presets/tests/311-shaderpass-three-pass-comp.milk is the flat colour only all three
 *    composite stages in order produce;
 *  - more than three passes, a declared pass without code, or passes without a stage
 *    shader fail the load (the switch-failed callback) and leave the previous preset and
 *    no framebuffer behind, on the direct and the prepared load path;
 *  - pass blocks without nPasses change nothing: the frames are byte for byte those of the
 *    same preset without them.
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/MilkdropPresetExceptions.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>
#include <MilkdropPreset/PresetState.hpp>
#include <Renderer/Framebuffer.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using libprojectM::MilkdropPreset::MilkdropPresetLoadException;
using libprojectM::MilkdropPreset::PresetFileParser;
using libprojectM::MilkdropPreset::PresetState;

namespace {

constexpr int kWidth = 64;
constexpr int kHeight = 48;

auto Parse(const std::string& text) -> std::unique_ptr<PresetFileParser>
{
    auto parser = std::make_unique<PresetFileParser>();
    std::istringstream stream(text);
    EXPECT_TRUE(parser->Read(stream));
    return parser;
}

const std::string kPass1 = "warp_pass1_1=`shader_body\nwarp_pass1_2=`{ ret = 1; }\n";
const std::string kPass2 = "warp_pass2_1=`shader_body\nwarp_pass2_2=`{ ret = 2; }\n";

auto ReadFile(const std::string& path) -> std::string
{
    std::ifstream file(path, std::ios::binary);
    std::stringstream contents;
    contents << file.rdbuf();
    return contents.str();
}

} // namespace

TEST(ShaderPassParse, WithoutNPassesPassBlocksAreIgnored)
{
    auto parser = Parse("[preset00]\n" + kPass1);
    EXPECT_TRUE(PresetState::ReadShaderPasses(*parser, "warp", true).empty());
}

TEST(ShaderPassParse, OnePassIsTheStageShaderAlone)
{
    auto parser = Parse("[preset00]\nwarp_nPasses=1\n" + kPass1);
    EXPECT_TRUE(PresetState::ReadShaderPasses(*parser, "warp", true).empty());
    // A stage without a shader may say so too.
    EXPECT_TRUE(PresetState::ReadShaderPasses(*parser, "warp", false).empty());
}

TEST(ShaderPassParse, PassesAreReturnedInOrder)
{
    auto parser = Parse("[preset00]\nWARP_NPASSES=3\n" + kPass2 + kPass1);
    const auto passes = PresetState::ReadShaderPasses(*parser, "warp", true);
    ASSERT_EQ(passes.size(), 2u);
    EXPECT_NE(passes.at(0).find("ret = 1"), std::string::npos);
    EXPECT_NE(passes.at(1).find("ret = 2"), std::string::npos);
    // The other stage is separate.
    EXPECT_TRUE(PresetState::ReadShaderPasses(*parser, "comp", true).empty());
}

TEST(ShaderPassParse, MoreThanTheCapIsRefused)
{
    auto parser = Parse("[preset00]\nwarp_nPasses=4\n" + kPass1 + kPass2 + "warp_pass3_1=`shader_body\n");
    EXPECT_THROW(PresetState::ReadShaderPasses(*parser, "warp", true), MilkdropPresetLoadException);
    try
    {
        PresetState::ReadShaderPasses(*parser, "warp", true);
    }
    catch (const MilkdropPresetLoadException& ex)
    {
        EXPECT_NE(ex.message().find("1 to 3"), std::string::npos) << ex.message();
    }

    auto zero = Parse("[preset00]\ncomp_nPasses=0\n");
    EXPECT_THROW(PresetState::ReadShaderPasses(*zero, "comp", true), MilkdropPresetLoadException);
}

TEST(ShaderPassParse, MissingPassCodeIsRefused)
{
    auto parser = Parse("[preset00]\nwarp_nPasses=3\n" + kPass1);
    EXPECT_THROW(PresetState::ReadShaderPasses(*parser, "warp", true), MilkdropPresetLoadException);
}

TEST(ShaderPassParse, PassesWithoutAStageShaderAreRefused)
{
    auto parser = Parse("[preset00]\nwarp_nPasses=2\n" + kPass1);
    EXPECT_THROW(PresetState::ReadShaderPasses(*parser, "warp", false), MilkdropPresetLoadException);
}

namespace {

/** @brief An RGBA8 texture + framebuffer to render into. */
class TargetFramebuffer
{
public:
    TargetFramebuffer()
    {
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kWidth, kHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glBindTexture(GL_TEXTURE_2D, 0);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    ~TargetFramebuffer()
    {
        glDeleteFramebuffers(1, &m_framebuffer);
        glDeleteTextures(1, &m_texture);
    }

    TargetFramebuffer(const TargetFramebuffer&) = delete;
    auto operator=(const TargetFramebuffer&) -> TargetFramebuffer& = delete;

    auto Id() const -> GLuint
    {
        return m_framebuffer;
    }

    /** @return RGBA, bottom row first. */
    auto Read() const -> std::vector<uint8_t>
    {
        std::vector<uint8_t> pixels(static_cast<size_t>(kWidth) * kHeight * 4);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, m_framebuffer);
        glReadBuffer(GL_COLOR_ATTACHMENT0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, kWidth, kHeight, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        return pixels;
    }

private:
    GLuint m_texture{};
    GLuint m_framebuffer{};
};

/** @brief One engine rendering into a TargetFramebuffer, recording switch failures. */
class Engine
{
public:
    Engine()
        : m_instance(projectm_create())
    {
        if (m_instance == nullptr)
        {
            return;
        }
        projectm_set_window_size(m_instance, kWidth, kHeight);
        projectm_set_preset_duration(m_instance, 3600.0);
        projectm_set_soft_cut_duration(m_instance, 0.0);
        projectm_set_preset_switch_failed_event_callback(
            m_instance, [](const char*, const char* message, void* user) {
                static_cast<Engine*>(user)->m_failures.emplace_back(message);
            },
            this);
    }

    ~Engine()
    {
        if (m_instance != nullptr)
        {
            projectm_destroy(m_instance);
        }
    }

    Engine(const Engine&) = delete;
    auto operator=(const Engine&) -> Engine& = delete;

    auto Valid() const -> bool
    {
        return m_instance != nullptr;
    }

    void LoadData(const std::string& data)
    {
        projectm_load_preset_data(m_instance, data.c_str(), false);
    }

    /** @brief Loads through the background-preparation path (preset_prepare.h). */
    void LoadPrepared(const std::string& data)
    {
        auto* job = projectm_preset_prepare_begin_data(m_instance, data.c_str());
        ASSERT_NE(job, nullptr);
        projectm_preset_prepare_run(job);
        projectm_load_prepared_preset(m_instance, job, false);
        while (projectm_poll_pending_preset(m_instance))
        {
        }
    }

    /** @brief Renders @p frames frames at 60 fps and returns the last one. */
    auto Render(int frames) -> std::vector<uint8_t>
    {
        for (int frame = 0; frame < frames; frame++)
        {
            projectm_set_frame_time(m_instance, static_cast<double>(m_frame++) / 60.0);
            projectm_opengl_render_frame_fbo(m_instance, m_target.Id());
        }
        return m_target.Read();
    }

    auto Failures() const -> const std::vector<std::string>&
    {
        return m_failures;
    }

private:
    projectm_handle m_instance{nullptr};
    TargetFramebuffer m_target;
    std::vector<std::string> m_failures;
    int m_frame{0};
};

auto Pixel(const std::vector<uint8_t>& pixels, int column, int rowFromBottom) -> const uint8_t*
{
    return &pixels[(static_cast<size_t>(rowFromBottom) * kWidth + column) * 4];
}

class ShaderPassTest : public testing::Test
{
protected:
    // One context for the suite: projectM's GL resolver pins its backend at the first
    // projectm_create() in the process (see PerPixelGpuRenderTest).
    static void SetUpTestSuite()
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            return;
        }
        s_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!s_context->Valid() || !s_context->InitializeGlad())
        {
            s_context.reset();
        }
    }

    static void TearDownTestSuite()
    {
        s_context.reset();
    }

    void SetUp() override
    {
        if (s_context == nullptr || !s_context->MakeCurrent())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
    }

    static auto Fixture(const std::string& name) -> std::string
    {
        return ReadFile(std::string(PROJECTM_PRESET_TESTS_DIR) + "/" + name);
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> ShaderPassTest::s_context;

/** @brief A plain single-pass preset: a flat colour from the composite shader. */
const std::string kFlatPreset = R"(MILKDROP_PRESET_VERSION=201
PSVERSION=2
PSVERSION_WARP=2
PSVERSION_COMP=2
[preset00]
fDecay=1
wave_a=0
ob_size=0
ib_size=0
comp_1=`shader_body
comp_2=`{
comp_3=`ret = float3(0.2, 0.6, 0.4);
comp_4=`}
)";

} // namespace

TEST_F(ShaderPassTest, TwoPassWarpShowsItsPassUpright)
{
    Engine engine;
    if (!engine.Valid())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    engine.LoadData(Fixture("310-shaderpass-two-pass-warp.milk"));
    const auto frame = engine.Render(4);
    ASSERT_TRUE(engine.Failures().empty()) << engine.Failures().front();

    // uv_orig: x left to right, y top to bottom. Rows here run bottom to top.
    for (const auto& [column, row] : {std::pair{4, 4}, std::pair{kWidth - 5, 4}, std::pair{4, kHeight - 5},
                                      std::pair{kWidth - 5, kHeight - 5}, std::pair{kWidth / 2, kHeight / 2}})
    {
        SCOPED_TRACE("column " + std::to_string(column) + ", row from bottom " + std::to_string(row));
        const auto* pixel = Pixel(frame, column, row);
        const double u = (column + 0.5) / kWidth;
        const double v = 1.0 - (row + 0.5) / kHeight;
        EXPECT_NEAR(pixel[0], u * 255.0, 6.0) << "red is the pass's uv_orig.x";
        EXPECT_NEAR(pixel[1], v * 255.0, 6.0) << "green is the pass's uv_orig.y: the pass output is upside down";
        EXPECT_NEAR(pixel[2], 128, 2) << "blue is 0.5 * iPass of the warp shader, the pass's own blue is dropped";
    }
}

TEST_F(ShaderPassTest, ThreePassCompositeRunsEveryPassInOrder)
{
    Engine engine;
    if (!engine.Valid())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    engine.LoadData(Fixture("311-shaderpass-three-pass-comp.milk"));
    const auto frame = engine.Render(3);
    ASSERT_TRUE(engine.Failures().empty()) << engine.Failures().front();

    for (int row = 0; row < kHeight; row += 7)
    {
        for (int column = 0; column < kWidth; column += 9)
        {
            const auto* pixel = Pixel(frame, column, row);
            ASSERT_NEAR(pixel[0], 102, 2) << column << "," << row;
            ASSERT_NEAR(pixel[1], 64, 2) << column << "," << row;
            ASSERT_NEAR(pixel[2], 128, 2) << column << "," << row;
        }
    }
}

TEST_F(ShaderPassTest, InvalidPassDeclarationsFailTheLoadWithoutLeaking)
{
    Engine engine;
    if (!engine.Valid())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    engine.LoadData(kFlatPreset);
    const auto before = engine.Render(2);
    ASSERT_TRUE(engine.Failures().empty());
    const int framebuffers = libprojectM::Renderer::Framebuffer::LiveInstanceCount();

    const std::string header = "MILKDROP_PRESET_VERSION=201\nPSVERSION=2\nPSVERSION_WARP=2\nPSVERSION_COMP=2\n[preset00]\n";
    const std::string warp = "warp_1=`shader_body\nwarp_2=`{ ret = tex2D(sampler_lastpass, uv).xyz; }\n";
    const std::vector<std::string> invalid{
        header + "warp_nPasses=4\n" + kPass1 + kPass2 + "warp_pass3_1=`shader_body\nwarp_pass3_2=`{ ret = 3; }\n" + warp,
        header + "warp_nPasses=3\n" + kPass1 + warp,
        header + "warp_nPasses=2\n" + kPass1,
    };

    size_t expectedFailures = 0;
    for (const auto& preset : invalid)
    {
        engine.LoadData(preset);
        ASSERT_EQ(engine.Failures().size(), ++expectedFailures) << preset;
        engine.LoadPrepared(preset);
        ASSERT_EQ(engine.Failures().size(), ++expectedFailures) << "prepared: " << preset;
    }
    EXPECT_NE(engine.Failures().front().find("1 to 3"), std::string::npos) << engine.Failures().front();

    // Still the flat preset, and no framebuffer was left behind.
    EXPECT_EQ(engine.Render(2), before);
    EXPECT_EQ(libprojectM::Renderer::Framebuffer::LiveInstanceCount(), framebuffers);
}

TEST_F(ShaderPassTest, PassBlocksWithoutNPassesChangeNothing)
{
    // Both engines draw the same random numbers.
    projectm_set_deterministic_seed(229);
    Engine plain;
    Engine withBlocks;
    projectm_clear_deterministic_seed();
    if (!plain.Valid() || !withBlocks.Valid())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }

    // A feedback preset, so any extra draw or sampler change would show.
    const std::string preset = R"(MILKDROP_PRESET_VERSION=201
PSVERSION=2
PSVERSION_WARP=2
PSVERSION_COMP=2
[preset00]
fDecay=0.97
zoom=1.02
rot=0.03
wave_a=0
warp_1=`shader_body
warp_2=`{
warp_3=`ret = tex2D(sampler_main, uv).xyz * 0.98 + float3(0.02, 0.01, 0.03) * sin(uv.x * 20 + time);
warp_4=`}
comp_1=`shader_body
comp_2=`{
comp_3=`ret = tex2D(sampler_main, uv).yzx;
comp_4=`}
)";
    plain.LoadData(preset);
    withBlocks.LoadData(preset + "warp_pass1_1=`shader_body\nwarp_pass1_2=`{ ret = 1; }\ncomp_pass1_1=`shader_body\n");
    for (int frame = 0; frame < 6; frame++)
    {
        ASSERT_EQ(plain.Render(1), withBlocks.Render(1)) << "frame " << frame;
    }
    EXPECT_TRUE(plain.Failures().empty());
    EXPECT_TRUE(withBlocks.Failures().empty());
}

TEST_F(ShaderPassTest, PreparedLoadRendersThePassesToo)
{
    Engine engine;
    if (!engine.Valid())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    engine.LoadPrepared(Fixture("311-shaderpass-three-pass-comp.milk"));
    const auto frame = engine.Render(3);
    ASSERT_TRUE(engine.Failures().empty()) << engine.Failures().front();
    const auto* pixel = Pixel(frame, kWidth / 2, kHeight / 2);
    EXPECT_NEAR(pixel[0], 102, 2);
    EXPECT_NEAR(pixel[1], 64, 2);
    EXPECT_NEAR(pixel[2], 128, 2);
}
