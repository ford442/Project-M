#pragma once

#include <Audio/RhythmInfo.hpp>

#include <cstdint>

namespace libprojectM {

/**
 * @brief Decides when to ask for the next preset, on the timer or on musical boundaries.
 *
 * Holds the musical half of ProjectM's preset switching (see projectM-4/rhythm.h): counting
 * bars in the active preset, remembering a detected section change, aligning beat-detection
 * hard cuts to the beat and resolving a soft cut length given in beats. ProjectM feeds it the
 * frame's RhythmInfo and its timer state; it has no clock or GL state of its own, so it is
 * tested on its own.
 */
class PresetSwitchScheduler
{
public:
    /**
     * @brief When a switch is requested. Values match projectm_preset_switch_policy.
     */
    enum class Policy : int
    {
        Timer = 0,  //!< After the preset duration.
        Bars = 1,   //!< On the downbeat that completes the configured number of bars.
        Section = 2 //!< On the first downbeat after a detected section change.
    };

    /**
     * @brief Sets the policy.
     * @param policy When to switch.
     * @param bars Preset length (Bars) or shortest preset (Section) in bars; 0 means 16.
     */
    void SetPolicy(Policy policy, uint32_t bars);

    auto GetPolicy() const -> Policy;

    auto Bars() const -> uint32_t;

    /**
     * @brief Makes beat-detection hard cuts wait for the next beat.
     */
    void SetHardCutOnBeat(bool enabled);

    auto HardCutOnBeat() const -> bool;

    /**
     * @brief Quantises musical switches to phrases.
     *
     * With a phrase length set, a Bars or Section switch (or the Section policy's timer
     * fallback) only lands on a downbeat that starts a phrase: every @p bars bars, counted
     * from the first downbeat after the latest section change. A switch may therefore come
     * up to @p bars - 1 bars later than the policy alone would place it.
     * @param bars Phrase length in bars (typically 4, 8 or 16), 0 or 1 to switch on any bar.
     */
    void SetPhraseBars(uint32_t bars);

    auto PhraseBars() const -> uint32_t;

    /**
     * @brief Requests a hard cut for the first downbeat after each detected section change
     *        (a "drop" cut), whatever the policy.
     */
    void SetSectionHardCut(bool enabled);

    auto SectionHardCut() const -> bool;

    /**
     * @brief Forgets the bars and the section change of the previous preset.
     *
     * Call when a preset starts (a hard cut, or the start of a soft cut).
     */
    void PresetStarted();

    /**
     * @brief Counts bars and arms a section switch. Call once per frame, whether or not a
     *        switch may be requested this frame.
     * @param rhythm This frame's musical time.
     * @param presetSeconds How long the active preset has been running.
     */
    void Observe(const Audio::RhythmInfo& rhythm, double presetSeconds);

    /**
     * @brief Whether the policy asks for the next preset on this frame.
     * @param rhythm This frame's musical time.
     * @param presetSeconds How long the active preset has been running.
     * @param presetDuration The configured preset duration.
     * @param timerExpired True once the preset timer ran out (the Timer policy's condition).
     */
    auto SwitchDue(const Audio::RhythmInfo& rhythm, double presetSeconds, double presetDuration, bool timerExpired) const -> bool;

    /**
     * @brief Whether the policy will ask for the next preset on the coming downbeat.
     *
     * Checked on downbeat frames and on section-change frames, while the tempo is known: it
     * predicts SwitchDue() for the next downbeat, so a host that prepares presets
     * asynchronously can be asked for the next preset about one bar early and the switch held
     * for the downbeat (ProjectM does this). False whenever SwitchDue() is true on this frame.
     *
     * @param rhythm This frame's musical time.
     * @param presetSeconds How long the active preset has been running.
     * @param presetDuration The configured preset duration.
     * @param timerExpired True once the preset timer ran out.
     */
    auto SwitchDueNextBar(const Audio::RhythmInfo& rhythm, double presetSeconds, double presetDuration, bool timerExpired) const -> bool;

    /**
     * @brief Whether to request a drop cut (a hard cut held for the next downbeat) on this frame.
     *
     * True on the frame a section change is detected, if section hard cuts are enabled and the
     * tempo is known.
     */
    auto DropCutDue(const Audio::RhythmInfo& rhythm) const -> bool;

    /**
     * @brief Whether to request a hard cut on this frame.
     *
     * With hard cuts on the beat enabled and the tempo known, a loudness trigger off the beat
     * is held until the next beat (at most one beat later). Otherwise it passes straight through.
     *
     * @param loudnessTrigger The loudness-based hard cut condition fired on this frame.
     * @param rhythm This frame's musical time.
     */
    auto HardCutDue(bool loudnessTrigger, const Audio::RhythmInfo& rhythm) -> bool;

    /**
     * @brief Soft cut length for a transition starting now.
     * @param seconds The configured duration in seconds.
     * @param beats The configured duration in beats, 0 for seconds only.
     * @param bpm The current tempo, 0 if unknown.
     * @return beats at bpm if both are known, else seconds.
     */
    static auto SoftCutDuration(double seconds, double beats, float bpm) -> double;

private:
    /**
     * @brief The policy's decision for a downbeat, given the state at that downbeat.
     */
    auto DueOnDownbeat(uint32_t barsInPreset, uint32_t phraseBar, bool timerExpired) const -> bool;

    auto PhraseStart(uint32_t phraseBar) const -> bool;

    Policy m_policy{Policy::Timer};
    uint32_t m_bars{16};
    uint32_t m_barsInPreset{0};         //!< Downbeats since the active preset started.
    bool m_sectionSwitchPending{false}; //!< A section change asked for a switch on the next downbeat.
    uint32_t m_phraseBars{0};           //!< Phrase length in bars, 0 = no phrase quantisation.
    uint32_t m_phraseBar{0};            //!< Downbeats since the phrase grid's origin (the first downbeat after a section change).
    bool m_phraseRestartPending{false}; //!< A section change moves the phrase origin to the next downbeat.
    bool m_sectionHardCut{false};
    bool m_hardCutOnBeat{false};
    bool m_hardCutPending{false};          //!< A hard cut is waiting for the next beat.
    std::uint64_t m_hardCutPendingBeat{0}; //!< Beat index when the pending hard cut was triggered.
};

} // namespace libprojectM
