#include "Audio/PCM.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <numeric>
#include <vector>

using namespace libprojectM::Audio;

namespace {

constexpr double kFrameDt = 1.0 / 60.0;
constexpr float kSampleRate = 44100.f;

std::vector<float> GenerateSine(size_t count, float freqHz, float amplitude = 0.75f)
{
    std::vector<float> out(count);
    for (size_t i = 0; i < count; i++)
    {
        out[i] = amplitude * std::sin(2.f * static_cast<float>(M_PI) * freqHz * static_cast<float>(i) / kSampleRate);
    }
    return out;
}

float BandEnergy(const FrameAudioData& data, int startBin, int endBin)
{
    float sum = 0.f;
    for (int i = startBin; i < endBin; ++i)
    {
        sum += data.spectrumLeft[static_cast<size_t>(i)];
    }
    return sum;
}

void WarmupSilence(PCM& pcm, uint32_t frames = 80)
{
    std::vector<float> silence(AudioBufferSamples, 0.f);
    for (uint32_t frame = 0; frame < frames; ++frame)
    {
        pcm.Add(silence.data(), 1, silence.size());
        pcm.UpdateFrameAudioData(kFrameDt, frame);
    }
}

void FeedSignal(PCM& pcm, const std::vector<float>& signal, uint32_t startFrame, uint32_t frames)
{
    for (uint32_t i = 0; i < frames; ++i)
    {
        pcm.Add(signal.data(), 1, signal.size());
        pcm.UpdateFrameAudioData(kFrameDt, startFrame + i);
    }
}

} // namespace

TEST(PCMAudioReactivity, SilenceKeepsWaveformNearZero)
{
    PCM pcm;
    WarmupSilence(pcm);
    const auto data = pcm.GetFrameAudioData();

    float peak = 0.f;
    for (float sample : data.waveformLeft)
    {
        peak = std::max(peak, std::fabs(sample));
    }
    EXPECT_LT(peak, 0.05f);
}

TEST(PCMAudioReactivity, SineProducesNonZeroWaveform)
{
    PCM pcm;
    WarmupSilence(pcm);
    const auto tone = GenerateSine(AudioBufferSamples, 220.f);
    FeedSignal(pcm, tone, 80, 30);

    const auto data = pcm.GetFrameAudioData();
    float peak = 0.f;
    for (float sample : data.waveformLeft)
    {
        peak = std::max(peak, std::fabs(sample));
    }
    EXPECT_GT(peak, 0.1f);
}

TEST(PCMAudioReactivity, BassToneEnergizesLowSpectrumMoreThanTrebleTone)
{
    PCM pcmBass;
    WarmupSilence(pcmBass);
    FeedSignal(pcmBass, GenerateSine(AudioBufferSamples, 80.f), 80, 60);
    const auto bassData = pcmBass.GetFrameAudioData();

    PCM pcmTreble;
    WarmupSilence(pcmTreble);
    FeedSignal(pcmTreble, GenerateSine(AudioBufferSamples, 6000.f), 80, 60);
    const auto trebleData = pcmTreble.GetFrameAudioData();

    // Each band uses one sixth of the 512-bin spectrum (see Loudness::Band).
    const float bassBandEnergy = BandEnergy(bassData, 0, SpectrumSamples / 6);
    const float trebleBandEnergy = BandEnergy(trebleData, 0, SpectrumSamples / 6);
    const float bassOnTrebleTone = BandEnergy(trebleData, SpectrumSamples / 3, SpectrumSamples / 2);
    const float trebleOnBassTone = BandEnergy(bassData, SpectrumSamples / 3, SpectrumSamples / 2);

    EXPECT_GT(bassBandEnergy, trebleBandEnergy * 1.5f);
    EXPECT_GT(bassOnTrebleTone, trebleOnBassTone * 1.5f);
}

TEST(PCMAudioReactivity, BeatOnsetSpikesBassRelative)
{
    PCM pcm;
    WarmupSilence(pcm, 120);

    const auto before = pcm.GetFrameAudioData();
    const float bassBefore = before.bass;

    const auto kick = GenerateSine(AudioBufferSamples, 55.f, 1.0f);
    FeedSignal(pcm, kick, 120, 3);
    const auto after = pcm.GetFrameAudioData();

    EXPECT_GT(after.bass, bassBefore);
    EXPECT_GT(after.bass, 1.05f);
}

TEST(PCMAudioReactivity, MonoInputDuplicatesToRightChannel)
{
    PCM pcm;
    const auto tone = GenerateSine(AudioBufferSamples, 440.f);
    FeedSignal(pcm, tone, 0, 20);

    const auto data = pcm.GetFrameAudioData();
    float maxDiff = 0.f;
    for (size_t i = 0; i < WaveformSamples; ++i)
    {
        maxDiff = std::max(maxDiff, std::fabs(data.waveformLeft[i] - data.waveformRight[i]));
    }
    EXPECT_LT(maxDiff, 0.02f);
}

TEST(PCMAudioReactivity, SpectrumPopulatedAfterTone)
{
    PCM pcm;
    WarmupSilence(pcm);
    FeedSignal(pcm, GenerateSine(AudioBufferSamples, 440.f), 80, 40);

    const auto data = pcm.GetFrameAudioData();
    const float sum = std::accumulate(data.spectrumLeft.begin(), data.spectrumLeft.end(), 0.f);
    EXPECT_GT(sum, 1.f);
}
