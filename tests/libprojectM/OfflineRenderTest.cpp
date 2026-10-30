/**
 * @file OfflineRenderTest.cpp
 * @brief projectm_render_offline_frame(): two runs over the same audio and frame times render
 *        the same pixels, and the audio reaches the frame.
 */

#include "HeadlessGlContext.hpp"
#include "TestGl.hpp"

#include <TimeKeeper.hpp>

#include <gtest/gtest.h>

#include <projectM-4/offline_render.h>
#include <projectM-4/projectM.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace {

constexpr int kSize = 64;
constexpr int kFrames = 20;
constexpr unsigned int kSamplesPerFrame = 735; // 44.1 kHz at 60 fps

/// A GL context, plus an RGBA8 framebuffer of kSize x kSize to render into.
class OfflineRenderTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "no headless OpenGL context";
        }
        m_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!m_context->Valid() || !m_context->InitializeGlad())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
        glGenTextures(1, &m_texture);
        glBindTexture(GL_TEXTURE_2D, m_texture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kSize, kSize, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glGenFramebuffers(1, &m_framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_texture, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    void TearDown() override
    {
        if (m_context && m_context->Valid())
        {
            glDeleteFramebuffers(1, &m_framebuffer);
            glDeleteTextures(1, &m_texture);
        }
    }

    auto CreateInstance(const char* preset) -> projectm_handle
    {
        auto* instance = projectm_create();
        if (instance == nullptr)
        {
            return nullptr;
        }
        projectm_set_seed(instance, 7);
        projectm_set_window_size(instance, kSize, kSize);
        projectm_set_preset_duration(instance, 3600.0);
        projectm_set_soft_cut_duration(instance, 0.0);
        projectm_load_preset_file(instance, (std::string(PROJECTM_PRESET_TESTS_DIR) + "/" + preset).c_str(), false);
        return instance;
    }

    auto ReadPixels() -> std::vector<unsigned char>
    {
        std::vector<unsigned char> pixels(kSize * kSize * 4);
        glBindFramebuffer(GL_FRAMEBUFFER, m_framebuffer);
        glReadPixels(0, 0, kSize, kSize, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        return pixels;
    }

    /// Renders kFrames offline frames of @a preset, a sine wave of @a amplitude as the audio,
    /// and returns each frame's pixels; empty if projectM cannot run on this context.
    auto Render(const char* preset, float amplitude) -> std::vector<std::vector<unsigned char>>
    {
        std::vector<std::vector<unsigned char>> frames;
        auto* instance = CreateInstance(preset);
        if (instance == nullptr)
        {
            return frames;
        }
        std::vector<float> samples(kSamplesPerFrame * 2);
        for (int frame = 0; frame < kFrames; frame++)
        {
            for (unsigned int i = 0; i < kSamplesPerFrame; i++)
            {
                const double t = (frame * kSamplesPerFrame + i) / 44100.0;
                samples[i * 2] = amplitude * static_cast<float>(std::sin(2.0 * 3.14159265358979 * 110.0 * t));
                samples[i * 2 + 1] = samples[i * 2];
            }
            EXPECT_TRUE(projectm_render_offline_frame(instance, samples.data(), kSamplesPerFrame, frame / 60.0, m_framebuffer));
            frames.push_back(ReadPixels());
        }
        projectm_destroy(instance);
        return frames;
    }

    std::unique_ptr<libprojectM::Test::HeadlessGlContext> m_context;
    GLuint m_texture{0};
    GLuint m_framebuffer{0};
};

} // namespace

TEST_F(OfflineRenderTest, TwoRunsRenderTheSamePixels)
{
    const auto first = Render("300-beatdetect-bassmidtreb.milk", 0.8F);
    if (first.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    const auto second = Render("300-beatdetect-bassmidtreb.milk", 0.8F);
    ASSERT_EQ(first.size(), second.size());
    for (size_t frame = 0; frame < first.size(); frame++)
    {
        EXPECT_EQ(first[frame], second[frame]) << "frame " << frame;
    }
}

TEST_F(OfflineRenderTest, TheAudioReachesTheFrame)
{
    const auto loud = Render("300-beatdetect-bassmidtreb.milk", 0.8F);
    if (loud.empty())
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    const auto silent = Render("300-beatdetect-bassmidtreb.milk", 0.0F);
    EXPECT_NE(loud.back(), silent.back());
}

TEST_F(OfflineRenderTest, RejectsInvalidArguments)
{
    auto* instance = CreateInstance("000-empty.milk");
    if (instance == nullptr)
    {
        GTEST_SKIP() << "projectm_create() is unavailable with this context";
    }
    EXPECT_FALSE(projectm_render_offline_frame(instance, nullptr, 16, 0.0, m_framebuffer)) << "null samples";
    EXPECT_FALSE(projectm_render_offline_frame(instance, nullptr, 0, -1.0, m_framebuffer)) << "negative time";
    EXPECT_FALSE(projectm_render_offline_frame(instance, nullptr, 0, std::numeric_limits<double>::quiet_NaN(), m_framebuffer)) << "NaN";
    EXPECT_FALSE(projectm_render_offline_frame(instance, nullptr, 0, std::numeric_limits<double>::infinity(), m_framebuffer)) << "infinity";

    EXPECT_TRUE(projectm_render_offline_frame(instance, nullptr, 0, 1.0, m_framebuffer));
    EXPECT_FALSE(projectm_render_offline_frame(instance, nullptr, 0, 0.5, m_framebuffer)) << "time going backwards";
    EXPECT_TRUE(projectm_render_offline_frame(instance, nullptr, 0, 1.0, m_framebuffer)) << "the same time again is allowed";
    EXPECT_DOUBLE_EQ(projectm_get_last_frame_time(instance), 1.0);
    projectm_destroy(instance);
}

// The engine's clock starts at exactly 0, not at a clock reading taken during construction: a
// first frame at time 0 has a time step of exactly 0. (A few microseconds of construction time
// leaking into the first step made the bass/mid/treb averages differ between runs.)
TEST(OfflineRenderTimeTest, TheFirstFrameAtTimeZeroHasNoTimeStep)
{
    libprojectM::TimeKeeper timeKeeper(10.0, 3.0, 20.0, 0.0);
    timeKeeper.SetFrameTime(0.0);
    timeKeeper.UpdateTimers();
    EXPECT_EQ(timeKeeper.SecondsSinceLastFrame(), 0.0);
    EXPECT_EQ(timeKeeper.PresetFrameA(), 2);
}
