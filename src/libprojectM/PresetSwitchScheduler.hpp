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
    Policy m_policy{Policy::Timer};
    uint32_t m_bars{16};
    uint32_t m_barsInPreset{0};         //!< Downbeats since the active preset started.
    bool m_sectionSwitchPending{false}; //!< A section change asked for a switch on the next downbeat.
    bool m_hardCutOnBeat{false};
    bool m_hardCutPending{false};          //!< A hard cut is waiting for the next beat.
    std::uint64_t m_hardCutPendingBeat{0}; //!< Beat index when the pending hard cut was triggered.
};

} // namespace libprojectM
