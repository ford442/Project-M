#include "Audio/PCM.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
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
