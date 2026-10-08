/**
 * @file RhythmAnalyzer.hpp
 * @brief Tempo, beat phase, bar, section and spectral descriptors from the incoming audio.
 *
 * Milkdrop's audio model only knows loudness relative to a running average (bass/mid/treb).
 * This class adds musical time, entirely in-tree:
 *
 *  1. Onset strength: half-wave rectified spectral flux of the log-magnitude spectrum, kept
 *     separately for a low, mid and high band (Bello et al. 2005, "A tutorial on onset
 *     detection in music signals"). It runs on every incoming sample in 1024-sample windows
 *     every 441 samples (10 ms at 44.1 kHz), not on the frame's 576-sample waveform, so
 *     onsets are timed to the hop rather than the frame and none fall between two frames.
 *  2. Tempo: the onset envelope is resampled to a fixed 100 Hz grid and fed into an
 *     exponentially weighted autocorrelation. A four-harmonic comb over 60-200 BPM with a
 *     log-Gaussian tempo prior picks the beat period (Scheirer 1998, "Tempo and beat analysis
 *     of acoustic musical signals"; the prior follows Ellis 2007, "Beat tracking by dynamic
 *     programming").
 *  3. Beat tracking: a free-running beat clock is phase-locked to the onsets. Every 50 ms the
 *     recent rising edges of the onset envelope are folded onto the clock's own phase; the
 *     peak of that histogram is how far the clock is off, and the clock is pulled towards it.
 *     Because the clock runs ahead on its own period, the phase is anticipatory: beatPhase
 *     wraps *on* the beat, not one or more frames after it was heard.
 *  4. Bars: low-band accent per beat position mod 4, confidence gated. Falls back to the
 *     plain beat count mod 4.
 *  5. Sections: the distance between the mean log-band spectrum of the last 3 s and of the
 *     8 s before it, a box-kernel form of Foote's novelty (Foote 2000, "Automatic audio
 *     segmentation using a measure of audio novelty"), with an adaptive threshold.
 *  6. Descriptors: spectral centroid, spectral flatness and RMS.
 *
 * Only the papers were used; no code from GPL/AGPL beat trackers (aubio, BTrack, Essentia).
 *
 * The time base is the sum of the frame durations passed to Update(). The samples that
 * arrived since the previous call are spread evenly over that frame, so the analyzer never
 * needs the audio sample rate and works at any frame rate and with any host feeding scheme
 * that delivers audio at roughly the rate it is played.
 */

#pragma once

#include "Audio/RhythmInfo.hpp"

#include <projectM-4/projectM_cxx_export.h>

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace libprojectM {
namespace Audio {

/**
 * @brief Derives tempo, beat/bar phase, sections and spectral descriptors. See file comment.
 *
 * Update() must be called once per rendered frame, on the render thread. SetTempoHint() may
 * be called from any thread.
 */
class PROJECTM_CXX_EXPORT RhythmAnalyzer
{
public:
    static constexpr double EnvelopeRate = 100.0;       //!< Onset envelope samples per second.
    static constexpr float MinBpm = 60.0f;              //!< Slowest tempo considered.
    static constexpr float MaxBpm = 200.0f;             //!< Fastest tempo considered.
    static constexpr float ConfidenceThreshold = 0.35f; //!< Below this, bpm reads 0 and beats are not reported.
    static constexpr int BeatsPerBar = 4;               //!< Bar length in beats.
    static constexpr int FftSize = 1024;                //!< Onset analysis window, in samples.
    static constexpr int HopSamples = 441;              //!< Onset analysis hop, in samples (10 ms at 44.1 kHz).

    RhythmAnalyzer();

    /**
     * @brief Forgets everything learned so far, as if the analyzer had just been created.
     * Keeps a tempo hint.
     */
    void Reset();

    /**
     * @brief Analyzes one frame.
     * @param samples The mono audio samples (full scale +-1) that arrived since the previous
     *                call, oldest first. May be null if sampleCount is 0.
     * @param sampleCount Number of samples.
     * @param secondsSinceLastFrame Time since the previous call, the analyzer's only clock.
     */
    void Update(const float* samples, std::size_t sampleCount, double secondsSinceLastFrame);

    /**
     * @brief Overrides tempo estimation with a known tempo (MIDI clock, track metadata).
     *
     * The beat clock then runs at exactly this tempo and only its phase is locked to the
     * audio. Confidence reads 1 while a hint is set.
     * @param bpm Tempo in beats per minute, or 0 (or any value <= 0) to clear the hint and
     *            go back to estimating.
     */
    void SetTempoHint(float bpm);

    /**
     * @brief Returns the current tempo hint, 0 if none is set.
     */
    auto TempoHint() const -> float;

    /**
     * @brief Returns the values computed by the last Update() call.
     */
    auto Info() const -> const RhythmInfo&;

private:
    static constexpr int Bins = FftSize / 2;    //!< Magnitude bins from 0 Hz up to just below Nyquist.
    static constexpr int HistorySize = 1024;    //!< Onset envelope samples kept (10.24 s).
    static constexpr int MaxLag = 410;          //!< Autocorrelation lags kept (4.1 s, four 60 BPM beats).
    static constexpr int PhaseBins = 64;        //!< Beat phase histogram resolution.
    static constexpr int PhaseWindow = 400;     //!< Envelope samples folded into the phase histogram (4 s).
    static constexpr int SectionBands = 12;     //!< Log-spaced bands in the section feature vector.
    static constexpr int SectionHistory = 128;  //!< Section feature hops kept (32 s at 0.25 s).
    static constexpr int TempoCandidates = 281; //!< MinBpm..MaxBpm in 0.5 BPM steps.

    void AnalyzeHop(double time);
    void ComputeMagnitudes();
    void ComputeDescriptors(double hopSeconds);
    void PushEnvelopeSample(float value);
    void EstimateTempo();
    void AdoptTempoEstimate(double period);
    auto MeasurePhaseError() -> double;
    void AdvanceClock(double dt, float lowOnset);
    void UpdateDownbeat();
    void AccumulateSectionFeatures(double hopSeconds);
    void EvaluateSectionNovelty();
    void SetTempoPeriod(double period);
    auto WindowRms() const -> float;

    // Short-time spectrum of the incoming audio.
    std::array<float, FftSize> m_samples{};     //!< Ring of the latest FftSize samples.
    int m_samplePosition{0};                    //!< Ring write position.
    int m_samplesSinceHop{0};                   //!< Samples received since the last hop.
    std::array<float, FftSize> m_hann{};        //!< Analysis window.
    std::array<int, Bins> m_bitReverse{};       //!< Bit reversal permutation of the half-size complex FFT.
    std::array<float, Bins / 2> m_twiddleCos{}; //!< exp(-2 pi i k / Bins), real part.
    std::array<float, Bins / 2> m_twiddleSin{}; //!< exp(-2 pi i k / Bins), negated imaginary part.
    std::array<float, Bins> m_unpackCos{};      //!< exp(-2 pi i k / FftSize), for the real-FFT unpacking.
    std::array<float, Bins> m_unpackSin{};
    std::array<float, Bins> m_fftReal{};
    std::array<float, Bins> m_fftImaginary{};
    std::array<float, Bins> m_magnitudes{}; //!< Latest hop's magnitude spectrum.

    // Onset detection.
    std::array<float, Bins> m_previousLog{}; //!< Previous hop's log-magnitude spectrum.
    bool m_havePreviousSpectrum{false};
    float m_frameOnset{0.0f}; //!< Strongest hop onset since the previous frame (held when no hop arrived).
    float m_frameLow{0.0f};
    float m_frameMid{0.0f};
    float m_frameHigh{0.0f};
    bool m_hopThisFrame{false};
    float m_onsetPeak{0.0f}; //!< Decaying peak trackers for normalization.
    float m_onsetLowPeak{0.0f};
    float m_onsetMidPeak{0.0f};
    float m_onsetHighPeak{0.0f};

    // Onset envelope at EnvelopeRate, mean removed. Stored twice (index and index+HistorySize)
    // so the autocorrelation loop reads a contiguous range without wrapping.
    std::vector<float> m_envelope;
    std::vector<float> m_rise;        //!< Rising edges of the raw envelope: max(0, e[n] - e[n-1]). Beat phase input.
    float m_previousEnvelope{0.0f};   //!< Last raw envelope sample, for m_rise.
    std::uint64_t m_envelopeCount{0}; //!< Envelope samples produced so far.
    double m_envelopeMean{0.0};       //!< Running mean removed from the envelope.
    double m_time{0.0};               //!< Analyzer time: sum of all frame durations.
    double m_previousHopTime{0.0};    //!< Time of the previous hop.
    float m_previousHopOnset{0.0f};   //!< Onset strength of the previous hop.
    double m_lastAudioTime{-1.0};     //!< Time the last sample arrived, -1 before any.

    // Tempo.
    std::array<float, MaxLag + 1> m_autocorrelation{}; //!< Exponentially weighted autocorrelation.
    double m_nextTempoUpdate{0.0};
    double m_tempoPeriod{0.5};   //!< Smoothed beat period in seconds (free-runs at 120 BPM initially).
    bool m_haveTempo{false};     //!< True once a tempo was estimated (or hinted).
    double m_pendingPeriod{0.0}; //!< Candidate for a tempo jump, needs to repeat to be adopted.
    int m_pendingCount{0};
    float m_periodicity{0.0f}; //!< 0..1 strength of the chosen periodicity.
    std::atomic<float> m_tempoHint{0.0f};
    float m_activeHint{0.0f}; //!< Hint applied by the last Update(), to detect changes.

    // Beat clock.
    double m_phase{0.0}; //!< 0..1 beat phase.
    double m_nextPhaseUpdate{0.0};
    std::uint64_t m_beatIndex{0};

    // Bars.
    std::array<float, BeatsPerBar> m_accent{}; //!< Average low-band accent per beat position.
    float m_accentWindow{0.0f};                //!< Strongest low onset near the current beat.
    std::uint64_t m_downbeatOffset{0};         //!< Beat position (mod BeatsPerBar) treated as the downbeat.

    // Descriptors and confidence.
    float m_rmsSlow{0.0f};
    float m_confidence{0.0f};
    float m_centroid{0.0f};
    float m_flatness{0.0f};

    // Sections.
    std::array<float, SectionBands> m_sectionAccumulator{};
    double m_sectionAccumulatedTime{0.0};
    int m_sectionAccumulatedHops{0};
    std::vector<std::array<float, SectionBands>> m_sectionFeatures; //!< Ring of section feature hops.
    std::uint64_t m_sectionHopCount{0};
    std::uint64_t m_lastSectionHop{0};
    double m_noveltyMean{0.0};
    double m_noveltyVariance{0.0};
    bool m_noveltyArmed{true}; //!< Re-armed once novelty falls back below the threshold.

    std::array<float, PhaseWindow> m_recencyWeights{}; //!< Onset weight by age in the phase histogram.
    std::array<float, TempoCandidates> m_tempoPrior{}; //!< Log-Gaussian tempo prior per candidate.

    RhythmInfo m_info;
};

} // namespace Audio
} // namespace libprojectM
