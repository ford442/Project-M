/**
 * @file PerfGpuStageTest.cpp
 * @brief The GPU stage markers a host times with per-stage timer queries.
 *
 * The WASM host ends one TIME_ELAPSED query and begins the next on every stage change
 * libprojectM reports (src/wasm/WasmPerfGovernor.cpp). Timer queries cannot nest, so the
 * stages must tile the frame: every change is a real change, scopes restore what they
 * replaced, and a frame ends where it started. The first group checks that bookkeeping
 * without GL; the second renders real presets and checks the Y-flip copies are reported
 * where MilkdropPreset::RenderFrame() actually issues them, since ranking those copies is
 * what the per-stage numbers are for (docs/GRAPHICS_PERF_RECOVERY_PLAN.md).
 */

#include "HeadlessGlContext.hpp"

#include <PerfTimers.hpp>

#include <glad/gl.h>

#include <gtest/gtest.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include <projectM-4/projectM.h>
#include <projectM-4/projectm_perf.h>

using libprojectM::Perf::GpuStage;

namespace {

std::vector<int> g_stageLog;

void RecordStage(projectm_perf_gpu_stage stage, void* /*userData*/)
{
    g_stageLog.push_back(static_cast<int>(stage));
}

/** @brief Installs the recorder for one test and leaves perf timers as it found them. */
class StageRecorder
{
public:
    StageRecorder()
        : m_wasEnabled(projectm_perf_is_enabled())
    {
        g_stageLog.clear();
        projectm_perf_set_enabled(true);
        projectm_perf_set_gpu_stage_callback(&RecordStage, nullptr);
    }

    ~StageRecorder()
    {
        projectm_perf_set_gpu_stage_callback(nullptr, nullptr);
        projectm_perf_set_enabled(m_wasEnabled);
        g_stageLog.clear();
    }

    StageRecorder(const StageRecorder&) = delete;
    auto operator=(const StageRecorder&) -> StageRecorder& = delete;

private:
    bool m_wasEnabled;
};

auto Count(const std::vector<int>& log, projectm_perf_gpu_stage stage) -> long
{
    return std::count(log.begin(), log.end(), static_cast<int>(stage));
}

} // namespace

TEST(PerfGpuStageTest, ScopesReportChangesAndRestoreThePreviousStage)
{
    StageRecorder recorder;
    {
        PROJECTM_PERF_GPU_STAGE(Warp);
        {
            // Same stage again: no query boundary, so nothing is reported.
            PROJECTM_PERF_GPU_STAGE(Warp);
        }
        {
            PROJECTM_PERF_GPU_STAGE(Copy);
        }
    }

    const std::vector<int> expected{
        PROJECTM_PERF_GPU_STAGE_WARP,
        PROJECTM_PERF_GPU_STAGE_COPY,
        PROJECTM_PERF_GPU_STAGE_WARP,
        PROJECTM_PERF_GPU_STAGE_OTHER,
    };
    EXPECT_EQ(g_stageLog, expected);
    EXPECT_EQ(libprojectM::Perf::CurrentGpuStage(), GpuStage::Other);
}

TEST(PerfGpuStageTest, NothingIsReportedWhilePerfTimersAreDisabled)
{
    StageRecorder recorder;
    projectm_perf_set_enabled(false);
    {
        PROJECTM_PERF_GPU_STAGE(Blur);
    }
    EXPECT_TRUE(g_stageLog.empty());
    EXPECT_EQ(libprojectM::Perf::CurrentGpuStage(), GpuStage::Other);
}

TEST(PerfGpuStageTest, HostEnteredStagesReturnThePreviousOne)
{
    StageRecorder recorder;
    const auto previous = projectm_perf_enter_gpu_stage(PROJECTM_PERF_GPU_STAGE_PRESENT);
    EXPECT_EQ(previous, PROJECTM_PERF_GPU_STAGE_OTHER);
    EXPECT_EQ(projectm_perf_enter_gpu_stage(previous), PROJECTM_PERF_GPU_STAGE_PRESENT);

    // Out of range is refused rather than cast into the C++ enum.
    EXPECT_EQ(projectm_perf_enter_gpu_stage(static_cast<projectm_perf_gpu_stage>(42)), PROJECTM_PERF_GPU_STAGE_OTHER);

    const std::vector<int> expected{PROJECTM_PERF_GPU_STAGE_PRESENT, PROJECTM_PERF_GPU_STAGE_OTHER};
    EXPECT_EQ(g_stageLog, expected);
}

namespace {

constexpr int kWidth = 128;
constexpr int kHeight = 96;

/**
 * @brief Renders @p frames frames of @p path and returns the stage log of the last one.
 *
 * The first frame after a load skips the motion vectors and may still be switching
 * presets, so only a steady-state frame is reported.
 */
auto LastFrameStages(const std::string& path, int frames, std::string& error) -> std::vector<int>
{
    GLuint texture = 0;
    GLuint framebuffer = 0;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kWidth, kHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);

    std::vector<int> stages;
    auto* instance = projectm_create();
    if (instance == nullptr)
    {
        error = "projectm_create() failed";
    }
    else
    {
        projectm_set_window_size(instance, kWidth, kHeight);
        projectm_set_preset_duration(instance, 3600.0);
        projectm_set_soft_cut_duration(instance, 0.0);
        projectm_load_preset_file(instance, path.c_str(), false);

        StageRecorder recorder;
        for (int frame = 0; frame < frames; frame++)
        {
            g_stageLog.clear();
            projectm_set_frame_time(instance, static_cast<double>(frame) / 60.0);
            projectm_opengl_render_frame_fbo(instance, framebuffer);
        }
        stages = g_stageLog;
        if (libprojectM::Perf::CurrentGpuStage() != GpuStage::Other)
        {
            error = "the frame did not end in the Other stage";
        }
        projectm_destroy(instance);
    }

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(1, &texture);
    return stages;
}

class PerfGpuStageRenderTest : public testing::Test
{
protected:
    // One context for the suite, for the reason PerPixelGpuRenderTest gives: projectM's
    // GL resolver pins its backend at the first projectm_create() in the process.
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

    /** @brief Renders and skips (not fails) when this process cannot create an instance. */
    auto Render(const std::string& path) -> std::vector<int>
    {
        std::string error;
        auto stages = LastFrameStages(path, 4, error);
        if (error == "projectm_create() failed")
        {
            return {};
        }
        EXPECT_TRUE(error.empty()) << path << ": " << error;
        return stages;
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> PerfGpuStageRenderTest::s_context;

} // namespace

/**
 * @brief An old-school preset (default warp, no composite shader) pays two flips:
 * one before the composite and the third one after it. The default warp folds its
 * flip into the sampling coordinates (#176), so there is none before the warp.
 */
TEST_F(PerfGpuStageRenderTest, NoCompositeShaderPresetReportsTwoCopies)
{
    const auto stages = Render(std::string(PROJECTM_PRESET_TESTS_DIR) + "/110-per_pixel.milk");
    if (stages.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }

    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_COPY), 2);
    EXPECT_GE(Count(stages, PROJECTM_PERF_GPU_STAGE_WARP), 1);
    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_BLUR), 1);
    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_SHAPES), 1);
    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_COMPOSITE), 1);
    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_PRESENT), 1);
    ASSERT_FALSE(stages.empty());
    EXPECT_EQ(stages.back(), PROJECTM_PERF_GPU_STAGE_OTHER);
}

/**
 * @brief A composite-shader preset skips the third flip. Checked on the hardware
 * benchmark's blur3 fixture too, which documents itself as a one-copy frame.
 */
TEST_F(PerfGpuStageRenderTest, CompositeShaderPresetReportsOneCopy)
{
    for (const auto& path : {std::string(PROJECTM_CUSTOM_MILK_FIXED_DIR) + "/milk009.milk",
                             std::string(PROJECTM_PRESET_TESTS_DIR) + "/280-compshader-blur3.milk"})
    {
        const auto stages = Render(path);
        if (stages.empty())
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }

        EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_COPY), 1) << path;
        EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_COMPOSITE), 1) << path;
        EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_PRESENT), 1) << path;
    }
}

/** @brief A custom warp shader still needs the pre-warp flip: two copies with a composite shader. */
TEST_F(PerfGpuStageRenderTest, CustomWarpShaderPresetReportsThePreWarpCopy)
{
    const auto stages = Render(std::string(PROJECTM_CUSTOM_MILK_FIXED_DIR) + "/milk012.milk");
    if (stages.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }

    EXPECT_EQ(Count(stages, PROJECTM_PERF_GPU_STAGE_COPY), 2);
    // The pre-warp copy comes before the warp mesh draw.
    const auto firstCopy = std::find(stages.begin(), stages.end(), static_cast<int>(PROJECTM_PERF_GPU_STAGE_COPY));
    const auto lastWarp = std::find(stages.rbegin(), stages.rend(), static_cast<int>(PROJECTM_PERF_GPU_STAGE_WARP));
    ASSERT_NE(firstCopy, stages.end());
    ASSERT_NE(lastWarp, stages.rend());
    EXPECT_LT(firstCopy - stages.begin(), stages.rend() - lastWarp - 1);
}
