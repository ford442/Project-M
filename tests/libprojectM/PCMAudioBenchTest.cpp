#include "Audio/PCM.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

#include <projectM-4/projectm_perf.h>

namespace {

using Clock = std::chrono::steady_clock;

std::vector<float> GenerateSine(size_t count, float freqHz = 80.f)
{
    std::vector<float> out(count);
    for (size_t i = 0; i < count; ++i)
    {
        out[i] = 0.75f * std::sin(2.f * static_cast<float>(M_PI) * freqHz * static_cast<float>(i) / 44100.f);
    }
    return out;
}

} // namespace

TEST(PCMAudioBenchTest, UpdateFrameAudioDataThroughput)
{
    constexpr int kFrames = 3000;
    libprojectM::Audio::PCM pcm;
    const auto tone = GenerateSine(libprojectM::Audio::AudioBufferSamples);

    for (int i = 0; i < 50; ++i)
    {
        pcm.Add(tone.data(), 1, tone.size());
        pcm.UpdateFrameAudioData(1.0 / 60.0, static_cast<uint32_t>(i));
    }

    const auto start = Clock::now();
    for (int i = 0; i < kFrames; ++i)
    {
        pcm.Add(tone.data(), 1, tone.size());
        pcm.UpdateFrameAudioData(1.0 / 60.0, static_cast<uint32_t>(50 + i));
    }
    const auto end = Clock::now();

    const double totalMs = std::chrono::duration<double, std::milli>(end - start).count();
    const double msPerFrame = totalMs / kFrames;

    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);

    std::cout << "[PCMAudioBench] compiled=" << info.compiled_enabled
              << " maxThreads=" << info.max_threads
              << " frames=" << kFrames
              << " audioUpdateTotalMs=" << totalMs
              << " audioUpdateMsPerFrame=" << msPerFrame << std::endl;

    const auto data = pcm.GetFrameAudioData();
    EXPECT_GT(data.bass, 0.f);
    EXPECT_LT(msPerFrame, 5.0);
}

TEST(PCMAudioBenchTest, RhythmAnalysisCostPerFrame)
{
    // 60 FPS at 44.1 kHz: 735 new samples per frame, a kick every 0.5 s on top of noise.
    constexpr int kFrames = 3600;
    constexpr size_t kSamplesPerFrame = 735;
    libprojectM::Audio::PCM pcm;

    std::vector<float> block(kSamplesPerFrame);
    uint32_t noise = 12345;
    size_t sample = 0;
    std::vector<double> frameMs;
    frameMs.reserve(kFrames);
    for (int frame = 0; frame < kFrames; ++frame)
    {
        for (auto& value : block)
        {
            noise = noise * 1664525u + 1013904223u;
            const double t = static_cast<double>(sample % 22050) / 44100.0;
            value = 0.05f * (static_cast<float>(noise >> 8) / 8388608.0f - 1.0f) +
                    0.6f * static_cast<float>(std::sin(2.0 * M_PI * 55.0 * t) * std::exp(-t / 0.08));
            sample++;
        }
        pcm.Add(block.data(), 1, block.size());
        pcm.UpdateFrameAudioData(1.0 / 60.0, static_cast<uint32_t>(frame));

        const auto start = Clock::now();
        pcm.UpdateRhythmAnalysis(1.0 / 60.0);
        frameMs.push_back(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
    }

    std::vector<double> sorted(frameMs.begin() + 600, frameMs.end()); // Skip the first 10 s.
    std::sort(sorted.begin(), sorted.end());
    double sum = 0.0;
    for (double value : sorted)
    {
        sum += value;
    }
    const double mean = sum / static_cast<double>(sorted.size());
    const double p95 = sorted[sorted.size() * 95 / 100];
    const double worst = sorted.back();

    std::cout << "[PCMAudioBench] rhythmMsPerFrame mean=" << mean << " p95=" << p95 << " max=" << worst << std::endl;
    RecordProperty("rhythm_ms_mean", std::to_string(mean));
    RecordProperty("rhythm_ms_p95", std::to_string(p95));

    const auto rhythm = pcm.GetFrameAudioData().rhythm;
    EXPECT_NEAR(rhythm.bpm, 120.0f, 1.0f);
    // Generous: Debug builds and loaded CI runners. The WASM budget (0.2 ms at p95) is
    // checked by the perf HUD's rhythmMs bucket, see docs/AUDIO_PIPELINE.md.
    EXPECT_LT(p95, 2.0);
}
