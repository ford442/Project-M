/**
 * @file PCM.hpp
 * @brief Takes sound data from the outside, analyzes it and hands it back out.
 *
 * Returns waveform and spectrum data, as well as relative beat detection values.
 **/

#pragma once

#include "Audio/AudioConstants.hpp"
#include "Audio/FrameAudioData.hpp"
#include "Audio/Loudness.hpp"
#include "Audio/MilkdropFFT.hpp"
#include "Audio/RhythmAnalyzer.hpp"
#include "Audio/WaveformAligner.hpp"

#include <projectM-4/projectM_cxx_export.h>

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <vector>


namespace libprojectM {
namespace Audio {

class PROJECTM_CXX_EXPORT PCM
{
public:
    /**
     * @brief Adds new interleaved floating-point PCM data to the buffer.
     * Left channel is expected at offset 0, right channel at offset 1. Other channels are ignored.
     * @param samples The buffer to be added
     * @param channels The number of channels in the input data.
     * @param count The amount of samples in the buffer
     */
    void Add(const float* samples, uint32_t channels, size_t count);

    /**
     * @brief Adds new mono unsigned 8-bit PCM data to the storage
     * Left channel is expected at offset 0, right channel at offset 1. Other channels are ignored.
     * @param samples The buffer to be added
     * @param channels The number of channels in the input data.
     * @param count The amount of samples in the buffer
     */
    void Add(const uint8_t* samples, uint32_t channels, size_t count);

    /**
     * @brief Adds new mono signed 16-bit PCM data to the storage
     * Left channel is expected at offset 0, right channel at offset 1. Other channels are ignored.
     * @param samples The buffer to be added
     * @param channels The number of channels in the input data.
     * @param count The amount of samples in the buffer
     */
    void Add(const int16_t* samples, uint32_t channels, size_t count);

    /**
     * @brief Updates the internal audio data values for rendering the next frame.
     * This method must only be called once per frame, as it does some temporal blending
     * and alignments using the previous frame(s) as reference. This function will perform:
     * - Passing the waveform data into the spectrum analyzer
     * - Aligning waveforms to a best-fit match to the previous frame to produce a calmer waveform shape.
     * - Calculating the bass/mid/treb values and their attenuated (time-smoothed) versions.
     *
     * @param secondsSinceLastFrame Time passed since rendering the last frame. Basically 1.0/FPS.
     * @param frame Frames rendered since projectM was started.
     */
    void UpdateFrameAudioData(double secondsSinceLastFrame, uint32_t frame);

    /**
     * @brief Runs the rhythm analysis (tempo, beat phase, onsets, sections) on every sample
     *        added since the previous call.
     *
     * A separate step from UpdateFrameAudioData() so its cost shows up separately in the perf
     * timers. Must be called once per frame; without it, FrameAudioData::rhythm keeps its
     * defaults.
     *
     * @param secondsSinceLastFrame Time passed since rendering the last frame, the analyzer's clock.
     */
    void UpdateRhythmAnalysis(double secondsSinceLastFrame);

    /**
     * @brief Sets a known tempo instead of estimating it. See RhythmAnalyzer::SetTempoHint().
     * @param bpm Tempo in beats per minute, or 0 to go back to estimating.
     */
    void SetRhythmHint(float bpm);

    /**
     * @brief Returns the tempo hint, 0 if none is set.
     */
    auto RhythmHint() const -> float;

    /**
     * @brief Returns a class holding a copy of the current frame audio data.
     * @return A FrameAudioData class with waveform, spectrum and other derived values.
     */
    auto GetFrameAudioData() const -> FrameAudioData;

private:
    template<
        int signalAmplitude,
        int signalOffset,
        typename SampleType>
    void AddToBuffer(const SampleType* samples, uint32_t channel, size_t sampleCount);

    /**
     * Updates FFT data
     */
    void UpdateSpectrum(const WaveformBuffer& waveformData, SpectrumBuffer& spectrumData);

    /**
     * Copies data out of the circular input buffer into the per-frame waveform buffer.
     */
    void CopyNewWaveformData(const WaveformBuffer& source, WaveformBuffer& destination);

    std::mutex m_pcmMutex; //!< Protects the circular input buffer from concurrent access.

    // External input buffer
    WaveformBuffer m_inputBufferL{0.f}; //!< Circular buffer for left-channel PCM data.
    WaveformBuffer m_inputBufferR{0.f}; //!< Circular buffer for right-channel PCM data.
    std::atomic<size_t> m_start{0};     //!< Circular buffer start index.

    // Frame waveform data
    WaveformBuffer m_waveformL{0.f}; //!< Left-channel waveform data, aligned. Only the first WaveformSamples number of samples are valid.
    WaveformBuffer m_waveformR{0.f}; //!< Right-channel waveform data, aligned. Only the first WaveformSamples number of samples are valid.

    // Frame spectrum data
    SpectrumBuffer m_spectrumL{0.f}; //!< Left-channel spectrum data.
    SpectrumBuffer m_spectrumR{0.f}; //!< Right-channel spectrum data.

    MilkdropFFT m_fft{WaveformSamples, SpectrumSamples, true}; //!< Spectrum analyzer instance.

    // Rhythm analysis sees every sample, not just the latest AudioBufferSamples: a mono copy
    // of the input goes into a larger ring, drained once per frame by UpdateRhythmAnalysis().
    static constexpr size_t RhythmRingSamples = 16384;                            //!< ~0.37 s at 44.1 kHz; enough for a frame at 3 FPS.
    std::vector<float> m_rhythmRing = std::vector<float>(RhythmRingSamples, 0.f); //!< Mono input, full scale +-1. Guarded by m_pcmMutex.
    uint64_t m_rhythmWritten{0};                                                  //!< Samples written to m_rhythmRing so far. Guarded by m_pcmMutex.
    uint64_t m_rhythmRead{0};                                                     //!< Samples handed to the analyzer so far. Render thread only.
    std::vector<float> m_rhythmSamples;                                           //!< Scratch buffer for the samples of one frame.
    RhythmAnalyzer m_rhythm;                                                      //!< Tempo, beat phase, onsets, sections.

    // Alignment data
    WaveformAligner m_alignL; //!< Left-channel waveform alignment.
    WaveformAligner m_alignR; //!< Left-channel waveform alignment.

    // Frame beat detection values
    Loudness m_bass{Loudness::Band::Bass};       //!< Beat detection/volume for the "bass" band.
    Loudness m_middles{Loudness::Band::Middles}; //!< Beat detection/volume for the "middles" band.
    Loudness m_treble{Loudness::Band::Treble};   //!< Beat detection/volume for the "treble" band.
};

} // namespace Audio
} // namespace libprojectM
