/**
 * @file FlashLimiterTest.cpp
 * @brief The temporal flash limiter (Renderer::FlashLimiter, docs/FLASH_LIMITER.md).
 *
 * Two groups, both on a real GL context (SDL2 + a display, or xvfb-run):
 *
 *  - The limiter on its own, fed synthetic frames: a black-to-white step comes out as an
 *    intermediate grey and counts as one clamped frame; an unchanged frame is copied
 *    byte for byte and counts as nothing.
 *  - Through projectm_opengl_render_frame_fbo(): presets/tests/290-compshader-strobe.milk
 *    strobes the whole frame at 15 Hz. With the limiter off it reaches the target
 *    untouched; with it on every frame stays within the threshold of the one before and
 *    the strobe spans at most 1.5 thresholds. A calm preset (280-compshader-blur3.milk)
 *    is presented byte for byte the same either way and clamps nothing.
 */

#include "HeadlessGlContext.hpp"

#include <Renderer/FlashLimiter.hpp>

#include "TestGl.hpp"

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

using libprojectM::Renderer::FlashLimiter;

namespace {

constexpr int kWidth = 64;
constexpr int kHeight = 48;

/** @brief An RGBA8 texture + framebuffer to present into, like a host's canvas FBO. */
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
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

auto SrgbToLinear(double value) -> double
{
    return value <= 0.04045 ? value / 12.92 : std::pow((value + 0.055) / 1.055, 2.4);
}

/** @brief Mean WCAG relative luminance of an RGBA8 image. */
auto MeanLuminance(const std::vector<uint8_t>& pixels) -> double
{
    double sum = 0.0;
    for (size_t i = 0; i + 3 < pixels.size(); i += 4)
    {
        sum += 0.2126 * SrgbToLinear(pixels[i] / 255.0) +
               0.7152 * SrgbToLinear(pixels[i + 1] / 255.0) +
               0.0722 * SrgbToLinear(pixels[i + 2] / 255.0);
    }
    return sum / static_cast<double>(pixels.size() / 4);
}

/** @brief Clears the limiter's frame to one grey level and presents it. */
void PresentSolidFrame(FlashLimiter& limiter, const TargetFramebuffer& target, float grey)
{
    ASSERT_TRUE(limiter.BeginFrame(kWidth, kHeight));
    glClearColor(grey, grey, grey, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    limiter.EndFrame({target.Id()}, 1.0 / 60.0);
}

class FlashLimiterTest : public testing::Test
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

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> FlashLimiterTest::s_context;

} // namespace

TEST_F(FlashLimiterTest, DisabledAllocatesNothingAndDoesNotTakeTheFrame)
{
    FlashLimiter limiter;
    EXPECT_FALSE(limiter.Enabled());
    EXPECT_FALSE(limiter.BeginFrame(kWidth, kHeight));
    EXPECT_FALSE(limiter.PresentedFramebuffer().Valid());
    EXPECT_EQ(limiter.ClampedFrames(), 0u);
}

TEST_F(FlashLimiterTest, BlackToWhiteStepIsClampedToTheThreshold)
{
    TargetFramebuffer target;
    FlashLimiter limiter;
    limiter.SetEnabled(true);

    PresentSolidFrame(limiter, target, 0.0f);
    const auto black = target.Read();
    EXPECT_EQ(*std::max_element(black.begin(), black.end() - 1), 255) << "alpha";
    EXPECT_NEAR(MeanLuminance(black), 0.0, 1e-6);
    EXPECT_EQ(limiter.ClampedFrames(), 0u) << "the first frame seeds the history";

    PresentSolidFrame(limiter, target, 1.0f);
    const auto stepped = target.Read();
    const double luminance = MeanLuminance(stepped);
    EXPECT_GT(luminance, 0.5 * FlashLimiter::DefaultThreshold);
    EXPECT_LE(luminance, FlashLimiter::DefaultThreshold + 0.01);
    EXPECT_EQ(limiter.ClampedFrames(), 1u);

    // Each further white frame may move the image by at most the threshold again, and the
    // band the presented luminance may span relaxes by one threshold per WindowSeconds, so
    // reaching white takes about WindowSeconds / threshold seconds, each frame counted.
    double previous = luminance;
    uint32_t steps = 1;
    while (previous < 0.99 && steps < 1000)
    {
        PresentSolidFrame(limiter, target, 1.0f);
        const double next = MeanLuminance(target.Read());
        EXPECT_LE(next - previous, FlashLimiter::DefaultThreshold + 0.01) << "after " << steps << " frames";
        EXPECT_GE(next, previous - 1e-6);
        previous = next;
        steps++;
    }
    EXPECT_GE(previous, 0.99) << "the limiter must let a lasting change through eventually";
    const double expectedFrames = 60.0 * FlashLimiter::WindowSeconds / FlashLimiter::DefaultThreshold;
    EXPECT_GT(steps, 0.5 * expectedFrames);
    EXPECT_LT(steps, 1.5 * expectedFrames);
    EXPECT_GE(limiter.ClampedFrames(), steps - 1);
    EXPECT_LE(limiter.ClampedFrames(), steps);
}

TEST_F(FlashLimiterTest, UnchangedFrameIsCopiedExactly)
{
    TargetFramebuffer target;
    FlashLimiter limiter;
    limiter.SetEnabled(true);

    for (int frame = 0; frame < 4; frame++)
    {
        ASSERT_TRUE(limiter.BeginFrame(kWidth, kHeight));
        // A gradient, so "exactly" covers more than one value.
        glEnable(GL_SCISSOR_TEST);
        for (int band = 0; band < 8; band++)
        {
            glScissor(band * kWidth / 8, 0, kWidth / 8, kHeight);
            const float value = static_cast<float>(band * 37 % 256) / 255.0f;
            glClearColor(value, 1.0f - value, 0.25f, 1.0f);
            glClear(GL_COLOR_BUFFER_BIT);
        }
        glDisable(GL_SCISSOR_TEST);
        limiter.EndFrame({target.Id()}, 1.0 / 60.0);
    }
    const auto presented = target.Read();

    // The same frame drawn straight into the target.
    glBindFramebuffer(GL_FRAMEBUFFER, target.Id());
    glViewport(0, 0, kWidth, kHeight);
    glEnable(GL_SCISSOR_TEST);
    for (int band = 0; band < 8; band++)
    {
        glScissor(band * kWidth / 8, 0, kWidth / 8, kHeight);
        const float value = static_cast<float>(band * 37 % 256) / 255.0f;
        glClearColor(value, 1.0f - value, 0.25f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    glDisable(GL_SCISSOR_TEST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    EXPECT_EQ(presented, target.Read());
    EXPECT_EQ(limiter.ClampedFrames(), 0u);
}

TEST_F(FlashLimiterTest, ReEnablingRestartsTheCount)
{
    TargetFramebuffer target;
    FlashLimiter limiter;
    limiter.SetEnabled(true);
    PresentSolidFrame(limiter, target, 0.0f);
    PresentSolidFrame(limiter, target, 1.0f);
    ASSERT_EQ(limiter.ClampedFrames(), 1u);

    limiter.SetEnabled(false);
    EXPECT_FALSE(limiter.BeginFrame(kWidth, kHeight)) << "releases the textures";
    EXPECT_EQ(limiter.ClampedFrames(), 1u) << "the count outlives the textures";

    limiter.SetEnabled(true);
    EXPECT_EQ(limiter.ClampedFrames(), 0u);
    PresentSolidFrame(limiter, target, 1.0f);
    EXPECT_EQ(limiter.ClampedFrames(), 0u) << "the history restarts at the first frame";
}

TEST_F(FlashLimiterTest, ResizeReseedsTheHistoryButKeepsTheCount)
{
    TargetFramebuffer target;
    FlashLimiter limiter;
    limiter.SetEnabled(true);
    PresentSolidFrame(limiter, target, 0.0f);
    PresentSolidFrame(limiter, target, 1.0f);
    ASSERT_EQ(limiter.ClampedFrames(), 1u);

    // A smaller frame (the target is larger; only the lower-left corner is written).
    ASSERT_TRUE(limiter.BeginFrame(kWidth / 2, kHeight / 2));
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    limiter.EndFrame({target.Id()}, 1.0 / 60.0);
    EXPECT_EQ(limiter.ClampedFrames(), 1u) << "a frame after a resize is a new start";
}

namespace {

/**
 * @brief Renders @p frames frames of @p presetPath at 60 fps into a target and returns
 *        each frame's mean luminance, plus the clamp count after the last one.
 */
auto RenderPreset(const std::string& presetPath, int frames, bool limit, uint32_t& clampedFrames,
                  std::vector<std::vector<uint8_t>>* images = nullptr) -> std::vector<double>
{
    TargetFramebuffer target;
    std::vector<double> luminance;
    auto* instance = projectm_create();
    if (instance == nullptr)
    {
        return luminance;
    }
    projectm_set_window_size(instance, kWidth, kHeight);
    projectm_set_preset_duration(instance, 3600.0);
    projectm_set_soft_cut_duration(instance, 0.0);
    projectm_load_preset_file(instance, presetPath.c_str(), false);
    projectm_set_flash_limit_enabled(instance, limit);

    for (int frame = 0; frame < frames; frame++)
    {
        projectm_set_frame_time(instance, static_cast<double>(frame) / 60.0);
        projectm_opengl_render_frame_fbo(instance, target.Id());
        auto pixels = target.Read();
        luminance.push_back(MeanLuminance(pixels));
        if (images != nullptr)
        {
            images->push_back(std::move(pixels));
        }
    }
    clampedFrames = projectm_get_flash_limit_clamped_frames(instance);
    projectm_destroy(instance);
    return luminance;
}

} // namespace

TEST_F(FlashLimiterTest, StrobePresetReachesTheTargetUntouchedWhileDisabled)
{
    uint32_t clamped = 99;
    const auto luminance = RenderPreset(std::string(PROJECTM_PRESET_TESTS_DIR) + "/290-compshader-strobe.milk", 24, false, clamped);
    if (luminance.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    EXPECT_EQ(clamped, 0u);

    // Past the first frames (the idle preset may still be on screen), the preset alternates
    // full black and full white every two frames.
    int flips = 0;
    for (size_t frame = 4; frame < luminance.size(); frame++)
    {
        EXPECT_TRUE(luminance[frame] < 0.01 || luminance[frame] > 0.99) << "frame " << frame << ": " << luminance[frame];
        if (std::abs(luminance[frame] - luminance[frame - 1]) > 0.5)
        {
            flips++;
        }
    }
    EXPECT_GE(flips, 8);
}

TEST_F(FlashLimiterTest, StrobePresetIsClampedWhileEnabled)
{
    uint32_t clamped = 0;
    const auto luminance = RenderPreset(std::string(PROJECTM_PRESET_TESTS_DIR) + "/290-compshader-strobe.milk", 24, true, clamped);
    if (luminance.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    EXPECT_GE(clamped, 8u);
    // Never more than a threshold per frame, and an oscillation this fast (15 Hz) never
    // spans more than 1.5 thresholds (docs/FLASH_LIMITER.md).
    for (size_t frame = 1; frame < luminance.size(); frame++)
    {
        EXPECT_LE(std::abs(luminance[frame] - luminance[frame - 1]), FlashLimiter::DefaultThreshold + 0.01)
            << "frame " << frame;
    }
    for (size_t frame = 4; frame + 8 <= luminance.size(); frame++)
    {
        const auto [low, high] = std::minmax_element(luminance.begin() + static_cast<long>(frame),
                                                     luminance.begin() + static_cast<long>(frame) + 8);
        EXPECT_LE(*high - *low, 1.5 * FlashLimiter::DefaultThreshold + 0.01) << "frames " << frame << "-" << frame + 7;
    }
}

TEST_F(FlashLimiterTest, CalmPresetIsPresentedIdenticallyAndNeverClamped)
{
    const std::string preset = std::string(PROJECTM_PRESET_TESTS_DIR) + "/280-compshader-blur3.milk";
    uint32_t clampedOff = 0;
    uint32_t clampedOn = 0;
    std::vector<std::vector<uint8_t>> off;
    std::vector<std::vector<uint8_t>> on;
    if (RenderPreset(preset, 24, false, clampedOff, &off).empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    RenderPreset(preset, 24, true, clampedOn, &on);
    EXPECT_EQ(clampedOn, 0u);
    ASSERT_EQ(off.size(), on.size());
    for (size_t frame = 0; frame < off.size(); frame++)
    {
        EXPECT_EQ(off[frame], on[frame]) << "frame " << frame;
    }
}
