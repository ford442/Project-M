/**
 * Musical preset scheduling (projectM-4/rhythm.h): switching every N bars or on a section
 * change, beat-aligned hard cuts and soft cuts measured in beats.
 */
#include "PresetSwitchScheduler.hpp"

#include <gtest/gtest.h>

using libprojectM::PresetSwitchScheduler;
using libprojectM::Audio::RhythmInfo;
using Policy = libprojectM::PresetSwitchScheduler::Policy;

namespace {

constexpr double kDuration = 30.0;

/** @brief A frame at a known tempo; beat/bar/section flags as given. */
auto Frame(bool beat = false, bool bar = false, bool section = false, std::uint64_t beatIndex = 0) -> RhythmInfo
{
    RhythmInfo info;
    info.bpm = 120.0f;
    info.confidence = 0.9f;
    info.beat = beat;
    info.bar = bar;
    info.sectionChanged = section;
    info.beatIndex = beatIndex;
    return info;
}

/** @brief A frame without a known tempo. */
auto Unknown(bool section = false) -> RhythmInfo
{
    RhythmInfo info;
    info.sectionChanged = section;
    return info;
}

} // namespace

TEST(PresetSwitchScheduler, TimerPolicyOnlyFollowsTheTimer)
{
    PresetSwitchScheduler scheduler;
    EXPECT_EQ(scheduler.GetPolicy(), Policy::Timer);
    scheduler.Observe(Frame(true, true), 1.0);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true, true), 1.0, kDuration, false));
    EXPECT_TRUE(scheduler.SwitchDue(Frame(), 31.0, kDuration, true));
    // Not even the twice-the-duration safety net applies: the timer policy is unchanged behavior.
    EXPECT_FALSE(scheduler.SwitchDue(Frame(), 100.0, kDuration, false));
}

TEST(PresetSwitchScheduler, BarsPolicySwitchesOnTheDownbeatCompletingTheBars)
{
    PresetSwitchScheduler scheduler;
    scheduler.SetPolicy(Policy::Bars, 4);
    scheduler.PresetStarted();

    double time = 0.0;
    int switchedOnBar = -1;
    for (int bar = 1; bar <= 8 && switchedOnBar < 0; bar++)
    {
        // Three beats without a downbeat, then the downbeat.
        for (int beat = 0; beat < 3; beat++)
        {
            time += 0.5;
            const auto frame = Frame(true, false);
            scheduler.Observe(frame, time);
            EXPECT_FALSE(scheduler.SwitchDue(frame, time, kDuration, false)) << "off the downbeat, bar " << bar;
        }
        time += 0.5;
        const auto downbeat = Frame(true, true);
        scheduler.Observe(downbeat, time);
        if (scheduler.SwitchDue(downbeat, time, kDuration, false))
        {
            switchedOnBar = bar;
        }
    }
    EXPECT_EQ(switchedOnBar, 4);

    // The timer running out is not enough on its own while the tempo is known...
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true), time, kDuration, true));
    // ...but after twice the duration the preset goes regardless.
    EXPECT_TRUE(scheduler.SwitchDue(Frame(), 2.0 * kDuration, kDuration, false));

    // A new preset counts its bars from zero again.
    scheduler.PresetStarted();
    scheduler.Observe(Frame(true, true), 0.5);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true, true), 0.5, kDuration, false));
}

TEST(PresetSwitchScheduler, BarsPolicyFallsBackToTheTimerWithoutATempo)
{
    PresetSwitchScheduler scheduler;
    scheduler.SetPolicy(Policy::Bars, 0);
    EXPECT_EQ(scheduler.Bars(), 16U);
    EXPECT_FALSE(scheduler.SwitchDue(Unknown(), 10.0, kDuration, false));
    EXPECT_TRUE(scheduler.SwitchDue(Unknown(), 31.0, kDuration, true));
}

TEST(PresetSwitchScheduler, SectionPolicySwitchesOnTheDownbeatAfterASectionChange)
{
    PresetSwitchScheduler scheduler;
    scheduler.SetPolicy(Policy::Section, 2);
    scheduler.PresetStarted();

    // A section change in the first bar is too early to count.
    scheduler.Observe(Frame(true, false, true), 1.0);
    scheduler.Observe(Frame(true, true), 2.0);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true, true), 2.0, kDuration, false));
    scheduler.Observe(Frame(true, true), 4.0);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true, true), 4.0, kDuration, false));

    // Two bars in, a section change arms the switch; it lands on the next downbeat.
    scheduler.Observe(Frame(true, false, true), 5.0);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true, false, true), 5.0, kDuration, false));
    scheduler.Observe(Frame(true), 5.5);
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true), 5.5, kDuration, false));
    scheduler.Observe(Frame(true, true), 6.0);
    EXPECT_TRUE(scheduler.SwitchDue(Frame(true, true), 6.0, kDuration, false));

    // Without sections, the timer still moves on, on a downbeat.
    scheduler.PresetStarted();
    EXPECT_FALSE(scheduler.SwitchDue(Frame(true), 31.0, kDuration, true));
    EXPECT_TRUE(scheduler.SwitchDue(Frame(true, true), 31.0, kDuration, true));

    // And without a tempo, a section change switches at once (after the minimum time).
    scheduler.PresetStarted();
    scheduler.Observe(Unknown(true), 20.0);
    EXPECT_TRUE(scheduler.SwitchDue(Unknown(), 20.0, kDuration, false));
}

TEST(PresetSwitchScheduler, HardCutsWaitForTheNextBeatWhenAsked)
{
    PresetSwitchScheduler scheduler;

    // Disabled: the loudness trigger passes straight through.
    EXPECT_TRUE(scheduler.HardCutDue(true, Frame(false, false, false, 10)));

    scheduler.SetHardCutOnBeat(true);
    EXPECT_TRUE(scheduler.HardCutOnBeat());
    // On the beat: immediately.
    EXPECT_TRUE(scheduler.HardCutDue(true, Frame(true, false, false, 11)));
    // Off the beat: held, then released on the beat.
    EXPECT_FALSE(scheduler.HardCutDue(true, Frame(false, false, false, 11)));
    EXPECT_FALSE(scheduler.HardCutDue(false, Frame(false, false, false, 11)));
    EXPECT_TRUE(scheduler.HardCutDue(false, Frame(true, false, false, 12)));
    EXPECT_FALSE(scheduler.HardCutDue(false, Frame(true, false, false, 13))) << "fires once";

    // Without a tempo nothing waits.
    EXPECT_TRUE(scheduler.HardCutDue(true, Unknown()));

    // A pending cut never waits more than a beat, even if the beat frame was missed.
    EXPECT_FALSE(scheduler.HardCutDue(true, Frame(false, false, false, 20)));
    EXPECT_TRUE(scheduler.HardCutDue(false, Frame(false, false, false, 22)));

    // A new preset drops a pending cut.
    EXPECT_FALSE(scheduler.HardCutDue(true, Frame(false, false, false, 30)));
    scheduler.PresetStarted();
    EXPECT_FALSE(scheduler.HardCutDue(false, Frame(true, false, false, 31)));
}

TEST(PresetSwitchScheduler, SoftCutDurationInBeatsFallsBackToSeconds)
{
    EXPECT_DOUBLE_EQ(PresetSwitchScheduler::SoftCutDuration(3.0, 0.0, 120.0f), 3.0);
    EXPECT_DOUBLE_EQ(PresetSwitchScheduler::SoftCutDuration(3.0, 2.0, 120.0f), 1.0);
    EXPECT_DOUBLE_EQ(PresetSwitchScheduler::SoftCutDuration(3.0, 4.0, 0.0f), 3.0) << "tempo unknown";
}
