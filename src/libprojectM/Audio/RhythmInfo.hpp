/**
 * @file RhythmInfo.hpp
 * @brief Musical-time values for one frame, as computed by RhythmAnalyzer.
 */
#pragma once

#include <cstdint>

namespace libprojectM {
namespace Audio {

/**
 * @brief Musical-time values for one frame. Exposed to presets as the @c pm_* variables.
 */
struct RhythmInfo {
    float bpm{0.0f};            //!< Tempo estimate, 0 while confidence is below RhythmAnalyzer::ConfidenceThreshold.
    float beatPhase{0.0f};      //!< 0..1 sawtooth, 0 = (predicted) beat.
    float beatPulse{0.0f};      //!< 1 on the beat frame, decays exponentially over ~100 ms. Stays 0 while not confident.
    std::uint64_t beatIndex{0}; //!< Monotonic beat counter, incremented every time beatPhase wraps.
    float barPhase{0.0f};       //!< 0..1 over a four-beat bar, 0 = downbeat.
    float onset{0.0f};          //!< Normalized onset strength, all bands (0..1).
    float onsetLow{0.0f};       //!< Normalized onset strength, low band (~40-200 Hz at 44.1 kHz).
    float onsetMid{0.0f};       //!< Normalized onset strength, mid band (~200 Hz-2 kHz).
    float onsetHigh{0.0f};      //!< Normalized onset strength, high band (~2-11 kHz).
    float centroid{0.0f};       //!< Spectral centroid, 0..1 of the Nyquist frequency.
    float flatness{0.0f};       //!< Spectral flatness, 0 = tonal .. 1 = noise-like.
    float rms{0.0f};            //!< RMS of the latest audio, 0..1 of full scale.
    int section{0};             //!< Section index, incremented on every detected section change.
    bool sectionChanged{false}; //!< True only on the frame a new section was detected.
    bool beat{false};           //!< True only on the frame beatPhase wrapped while confident.
    bool bar{false};            //!< True only on a confident beat frame that starts a bar.
    float confidence{0.0f};     //!< 0..1 tracker confidence. 1 while a tempo hint is set.
};

} // namespace Audio
} // namespace libprojectM
