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

void PresetSwitchScheduler::SetPhraseBars(uint32_t bars)
{
    m_phraseBars = bars > 1 ? bars : 0;
}

auto PresetSwitchScheduler::PhraseBars() const -> uint32_t
{
    return m_phraseBars;
}

void PresetSwitchScheduler::SetSectionHardCut(bool enabled)
{
    m_sectionHardCut = enabled;
}

auto PresetSwitchScheduler::SectionHardCut() const -> bool
{
    return m_sectionHardCut;
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
        if (m_phraseRestartPending)
        {
            m_phraseRestartPending = false;
            m_phraseBar = 0;
        }
        else
        {
            m_phraseBar++;
        }
    }
    if (rhythm.sectionChanged)
    {
        m_phraseRestartPending = true;
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
    if (!tempoKnown)
    {
        // Bars falls back to the timer; Section also switches on a section change at once.
        return timerExpired || (m_policy == Policy::Section && m_sectionSwitchPending);
    }
    return rhythm.bar && DueOnDownbeat(m_barsInPreset, m_phraseBar, timerExpired);
}

auto PresetSwitchScheduler::SwitchDueNextBar(const Audio::RhythmInfo& rhythm, double presetSeconds, double presetDuration,
                                             bool timerExpired) const -> bool
{
    if (m_policy == Policy::Timer || rhythm.bpm <= 0.0f || !(rhythm.bar || rhythm.sectionChanged))
    {
        return false;
    }
    if (SwitchDue(rhythm, presetSeconds, presetDuration, timerExpired))
    {
        return false;
    }

    // The state the coming downbeat will see.
    const double untilDownbeat = (1.0 - static_cast<double>(rhythm.barPhase)) * 240.0 / static_cast<double>(rhythm.bpm);
    const double secondsThen = presetSeconds + untilDownbeat;
    if (secondsThen >= 2.0 * presetDuration)
    {
        return true;
    }
    const uint32_t phraseBarThen = m_phraseRestartPending ? 0 : m_phraseBar + 1;
    return DueOnDownbeat(m_barsInPreset + 1, phraseBarThen, timerExpired || secondsThen >= presetDuration);
}

auto PresetSwitchScheduler::DropCutDue(const Audio::RhythmInfo& rhythm) const -> bool
{
    return m_sectionHardCut && rhythm.sectionChanged && rhythm.bpm > 0.0f;
}

auto PresetSwitchScheduler::PhraseStart(uint32_t phraseBar) const -> bool
{
    return m_phraseBars == 0 || phraseBar % m_phraseBars == 0;
}

auto PresetSwitchScheduler::DueOnDownbeat(uint32_t barsInPreset, uint32_t phraseBar, bool timerExpired) const -> bool
{
    if (!PhraseStart(phraseBar))
    {
        return false;
    }
    if (m_policy == Policy::Bars)
    {
        return barsInPreset >= m_bars;
    }
    // Section: the first downbeat after a section change, or the timer on a downbeat.
    return m_sectionSwitchPending || timerExpired;
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
