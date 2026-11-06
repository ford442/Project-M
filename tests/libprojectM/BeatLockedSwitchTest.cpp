/**
 * @file BeatLockedSwitchTest.cpp
 * @brief Musical preset switches land on the downbeat (projectM-4/rhythm.h, "Switches land on
 *        the downbeat").
 *
 * On a real GL context (SDL2 + a display, or xvfb-run): a click track at 120, 128 and 174 BPM
 * drives a BARS policy. The switch request arrives about a bar early; the host loads the next
 * preset on the following frame (mid-bar, as an asynchronous host would), and the engine must
 * hold it and switch on the downbeat frame itself, with and without output-latency
 * compensation.
 */

#include "HeadlessGlContext.hpp"

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

namespace {

constexpr double kSampleRate = 44100.0;
constexpr double kFps = 60.0;
constexpr double kPi = 3.14159265358979323846;
constexpr const char* kPreset = "[preset00]\nzoom=1.0\ndecay=0.98\n";

/** A kick on every beat, accented on the downbeat. */
auto ClickTrack(double bpm, double seconds) -> std::vector<float>
{
    std::vector<float> signal(static_cast<size_t>(seconds * kSampleRate), 0.0f);
    const double period = 60.0 / bpm;
    int beat = 0;
    for (double time = 0.1; time < seconds; time = 0.1 + (++beat) * period)
    {
        const float level = beat % 4 == 0 ? 0.9f : 0.5f;
        const auto first = static_cast<size_t>(time * kSampleRate);
        for (size_t index = first; index < signal.size() && index < first + static_cast<size_t>(0.2 * kSampleRate); index++)
        {
            const double t = static_cast<double>(index - first) / kSampleRate;
            signal[index] += static_cast<float>(level * std::sin(2.0 * kPi * 60.0 * t) * std::exp(-t / 0.06));
        }
    }
    return signal;
}

struct Case {
    double bpm;
    double latencyMs;
};

auto operator<<(std::ostream& stream, const Case& value) -> std::ostream&
{
    return stream << value.bpm << " BPM, " << value.latencyMs << " ms";
}

class BeatLockedSwitchTest : public testing::TestWithParam<Case>
{
protected:
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
        m_instance = projectm_create();
        if (m_instance == nullptr)
        {
            GTEST_SKIP() << "projectm_create() is unavailable with this context";
        }
        projectm_set_window_size(m_instance, 32, 32);
    }

    void TearDown() override
    {
        if (m_instance != nullptr)
        {
            projectm_destroy(m_instance);
        }
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    projectm_handle m_instance{nullptr};
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> BeatLockedSwitchTest::s_context;

TEST_P(BeatLockedSwitchTest, SwitchLandsOnTheDownbeatFrame)
{
    const auto& param = GetParam();
    constexpr double seconds = 22.0;
    const auto signal = ClickTrack(param.bpm, seconds);

    projectm_set_rhythm_hint(m_instance, static_cast<float>(param.bpm));
    projectm_set_rhythm_latency(m_instance, param.latencyMs);
    EXPECT_NEAR(projectm_get_rhythm_latency(m_instance), param.latencyMs, 1e-9);
    projectm_set_preset_switch_policy(m_instance, PROJECTM_PRESET_SWITCH_BARS, 2);
    projectm_set_preset_duration(m_instance, 60.0);
    projectm_set_soft_cut_duration(m_instance, 0.5);

    int requests = 0;
    projectm_set_preset_switch_requested_event_callback(
        m_instance, [](bool, void* data) { ++*static_cast<int*>(data); }, &requests);

    int handledRequests = 0;
    bool loadNextFrame = false;
    bool wasHeld = false;
    int switches = 0;
    int currentHold = 0;
    std::vector<int> holds;
    double time = 0.0;
    size_t fed = 0;
    const auto frames = static_cast<int>((seconds - 0.5) * kFps);
    for (int frame = 0; frame < frames; frame++)
    {
        time += 1.0 / kFps;
        const auto until = std::min(signal.size(), static_cast<size_t>(time * kSampleRate));
        projectm_pcm_add_float(m_instance, signal.data() + fed, static_cast<unsigned int>(until - fed), PROJECTM_MONO);
        fed = until;

        if (loadNextFrame)
        {
            // The load arrives one frame after the request, in the middle of the bar.
            loadNextFrame = false;
            projectm_load_preset_data(m_instance, kPreset, true);
            EXPECT_TRUE(projectm_preset_is_held_for_downbeat(m_instance)) << "frame " << frame;
        }

        projectm_set_frame_time(m_instance, time);
        projectm_opengl_render_frame(m_instance);

        projectm_rhythm_info rhythm{};
        projectm_get_rhythm_info(m_instance, &rhythm);
        const bool held = projectm_preset_is_held_for_downbeat(m_instance);
        if (held)
        {
            currentHold++;
        }
        if (wasHeld && !held)
        {
            switches++;
            holds.push_back(currentHold);
            currentHold = 0;
            EXPECT_EQ(rhythm.bar, 1) << "switch on frame " << frame << " at bar phase " << rhythm.bar_phase;
        }
        wasHeld = held;

        if (requests > handledRequests)
        {
            handledRequests = requests;
            EXPECT_EQ(rhythm.bar, 1) << "the request is made on a downbeat, one bar early";
            loadNextFrame = true;
        }
    }

    EXPECT_GE(switches, 3);
    // After the warm-up (the downbeat detector settles within the first switch or two, which
    // then falls back to a later downbeat), each switch is held for one bar less the load frame.
    const double barFrames = 240.0 / param.bpm * kFps;
    ASSERT_GE(holds.size(), 3U);
    for (size_t index = 2; index < holds.size(); index++)
    {
        EXPECT_NEAR(holds[index], barFrames - 1.0, 2.0) << "switch " << index;
    }
    // Even while settling, a late switch only falls back to the next downbeat.
    for (const int hold : holds)
    {
        EXPECT_LE(hold, 2.0 * barFrames + 2.0);
    }
}

INSTANTIATE_TEST_SUITE_P(ClickTracks, BeatLockedSwitchTest,
                         testing::Values(Case{120.0, 0.0}, Case{128.0, 0.0}, Case{174.0, 0.0},
                                         Case{120.0, 60.0}, Case{128.0, 60.0}, Case{174.0, 60.0}));

TEST_F(BeatLockedSwitchTest, PhraseAndSectionCutSettingsRoundTrip)
{
    projectm_set_preset_switch_phrase(m_instance, 8);
    EXPECT_EQ(projectm_get_preset_switch_phrase(m_instance), 8U);
    projectm_set_preset_switch_phrase(m_instance, 1);
    EXPECT_EQ(projectm_get_preset_switch_phrase(m_instance), 0U);
    projectm_set_section_hard_cut(m_instance, true);
    EXPECT_TRUE(projectm_get_section_hard_cut(m_instance));
    projectm_set_rhythm_latency(m_instance, 5000.0);
    EXPECT_EQ(projectm_get_rhythm_latency(m_instance), 1000.0);
}

TEST_F(BeatLockedSwitchTest, LoadWithoutARequestIsNotHeld)
{
    projectm_set_preset_switch_policy(m_instance, PROJECTM_PRESET_SWITCH_BARS, 2);
    projectm_opengl_render_frame(m_instance);
    projectm_load_preset_data(m_instance, kPreset, true);
    EXPECT_FALSE(projectm_preset_is_held_for_downbeat(m_instance));
}

} // namespace
