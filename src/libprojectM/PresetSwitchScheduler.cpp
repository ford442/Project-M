#include "PresetSwitchScheduler.hpp"

namespace libprojectM {

namespace {

constexpr uint32_t kDefaultBars = 16;
constexpr double kFallbackBarSeconds = 2.0; //!< A bar at 120 BPM, when the tempo is unknown.

} // namespace

void PresetSwitchScheduler::SetPolicy(Policy policy, uint32_t bars)
{
    m_policy = policy;
    m_bars = bars > 0 ? bars : kDefaultBars;
    m_sectionSwitchPending = false;
}

auto PresetSwitchScheduler::GetPolicy() const -> Policy
{
    return m_policy;
}

auto PresetSwitchScheduler::Bars() const -> uint32_t
{
    return m_bars;
}

void PresetSwitchScheduler::SetHardCutOnBeat(bool enabled)
{
    m_hardCutOnBeat = enabled;
    if (!enabled)
    {
        m_hardCutPending = false;
    }
}

auto PresetSwitchScheduler::HardCutOnBeat() const -> bool
{
    return m_hardCutOnBeat;
}

void PresetSwitchScheduler::PresetStarted()
{
    m_barsInPreset = 0;
    m_sectionSwitchPending = false;
    m_hardCutPending = false;
}

void PresetSwitchScheduler::Observe(const Audio::RhythmInfo& rhythm, double presetSeconds)
{
    if (rhythm.bar)
    {
        m_barsInPreset++;
    }

    if (rhythm.sectionChanged && m_policy == Policy::Section)
    {
        // Only a section change after the shortest preset length counts. Bars are counted
        // while the tempo is known; time covers the stretches where it was not.
        const double barSeconds = rhythm.bpm > 0.0f ? 240.0 / static_cast<double>(rhythm.bpm) : kFallbackBarSeconds;
        if (m_barsInPreset >= m_bars || presetSeconds >= static_cast<double>(m_bars) * barSeconds)
        {
            m_sectionSwitchPending = true;
        }
    }
}

auto PresetSwitchScheduler::SwitchDue(const Audio::RhythmInfo& rhythm, double presetSeconds, double presetDuration,
                                      bool timerExpired) const -> bool
{
    if (m_policy == Policy::Timer)
    {
        return timerExpired;
    }

    // However long the bars take, never keep a preset for more than twice its duration.
    if (presetSeconds >= 2.0 * presetDuration)
    {
        return true;
    }

    const bool tempoKnown = rhythm.bpm > 0.0f;
    if (m_policy == Policy::Bars)
    {
        if (!tempoKnown)
        {
            return timerExpired;
        }
        return rhythm.bar && m_barsInPreset >= m_bars;
    }

    // Section: on the first downbeat after a section change, or the timer on a downbeat.
    if (!tempoKnown)
    {
        return m_sectionSwitchPending || timerExpired;
    }
    return rhythm.bar && (m_sectionSwitchPending || timerExpired);
}

auto PresetSwitchScheduler::HardCutDue(bool loudnessTrigger, const Audio::RhythmInfo& rhythm) -> bool
{
    const bool tempoKnown = rhythm.bpm > 0.0f;
    if (loudnessTrigger)
    {
        if (m_hardCutOnBeat && tempoKnown && !rhythm.beat)
        {
            // Land the cut on the next beat instead.
            m_hardCutPending = true;
            m_hardCutPendingBeat = rhythm.beatIndex;
            return false;
        }
        m_hardCutPending = false;
        return true;
    }

    if (m_hardCutPending && (rhythm.beat || !tempoKnown || rhythm.beatIndex > m_hardCutPendingBeat + 1))
    {
        m_hardCutPending = false;
        return true;
    }
    return false;
}

auto PresetSwitchScheduler::SoftCutDuration(double seconds, double beats, float bpm) -> double
{
    if (beats > 0.0 && bpm > 0.0f)
    {
        return beats * 60.0 / static_cast<double>(bpm);
    }
    return seconds;
}

} // namespace libprojectM
