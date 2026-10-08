#pragma once

#include <Audio/RhythmInfo.hpp>

#include <projectm-eval.h>

#include <array>

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief The read-only @c pm_* musical-time variables (see Audio::RhythmAnalyzer).
 *
 * One table for every place they reach a preset: the per-frame, per-pixel, custom shape and
 * custom waveform code contexts, the GPU per-pixel uniforms (u_pp_pm_*) and the warp and
 * composite shader uniforms (_c14.._c17).
 *
 * Every name carries the pm_ prefix. More than a hundred presets in the corpus use @c beat
 * as a local variable; nothing here may take an un-prefixed name from them. A preset that
 * assigns to a pm_* name simply overwrites it for the rest of that frame, like any local.
 */
class RhythmVariables
{
public:
    enum Index
    {
        Bpm,
        BeatPhase,
        BeatPulse,
        BeatIndex,
        BarPhase,
        Onset,
        OnsetLow,
        OnsetMid,
        OnsetHigh,
        Centroid,
        Flatness,
        Rms,
        Section,
        SectionChange,
        Confidence,
        Count
    };

    /** @brief Variable names, in Index order. */
    static constexpr std::array<const char*, Count> Names{
        "pm_bpm",
        "pm_beat_phase",
        "pm_beat_pulse",
        "pm_beat_index",
        "pm_bar_phase",
        "pm_onset",
        "pm_onset_lo",
        "pm_onset_mid",
        "pm_onset_hi",
        "pm_centroid",
        "pm_flatness",
        "pm_rms",
        "pm_section",
        "pm_section_change",
        "pm_rhythm_conf",
    };

    /**
     * @brief The variable values for one frame, in Index order.
     */
    static auto Values(const Audio::RhythmInfo& info) -> std::array<double, Count>
    {
        std::array<double, Count> values{};
        values[Bpm] = info.bpm;
        values[BeatPhase] = info.beatPhase;
        values[BeatPulse] = info.beatPulse;
        values[BeatIndex] = static_cast<double>(info.beatIndex);
        values[BarPhase] = info.barPhase;
        values[Onset] = info.onset;
        values[OnsetLow] = info.onsetLow;
        values[OnsetMid] = info.onsetMid;
        values[OnsetHigh] = info.onsetHigh;
        values[Centroid] = info.centroid;
        values[Flatness] = info.flatness;
        values[Rms] = info.rms;
        values[Section] = info.section;
        values[SectionChange] = info.sectionChanged ? 1.0 : 0.0;
        values[Confidence] = info.confidence;
        return values;
    }

    /**
     * @brief Registers all variables in an expression evaluator context.
     */
    void Register(projectm_eval_context* context)
    {
        for (int index = 0; index < Count; index++)
        {
            m_variables[index] = projectm_eval_context_register_variable(context, Names[index]);
        }
    }

    /**
     * @brief Loads one frame's values.
     */
    void Load(const Audio::RhythmInfo& info)
    {
        const auto values = Values(info);
        for (int index = 0; index < Count; index++)
        {
            *m_variables[index] = static_cast<PRJM_EVAL_F>(values[index]);
        }
    }

    /**
     * @brief Copies the current values of another context's variables, e.g. after the
     *        per-frame code may have changed them.
     */
    void CopyFrom(const RhythmVariables& source)
    {
        for (int index = 0; index < Count; index++)
        {
            *m_variables[index] = *source.m_variables[index];
        }
    }

    /**
     * @brief The current value of one variable.
     */
    auto Value(Index index) const -> PRJM_EVAL_F
    {
        return *m_variables[index];
    }

private:
    std::array<PRJM_EVAL_F*, Count> m_variables{};
};

} // namespace MilkdropPreset
} // namespace libprojectM
